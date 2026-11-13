import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerAuth } from "../../src/auth.js"
import { GITHUB_COM } from "../../src/config.js"
import { DEVICE_METHOD_ID, TOKEN_METHOD_ID } from "../../src/sign-in.js"

type Ctx = Parameters<typeof registerAuth>[0]
type Editor = Parameters<Parameters<Ctx["integration"]["transform"]>[0]>[0]
type MethodRegistration = Parameters<Editor["method"]["update"]>[0]
type OAuthRegistration = Extract<MethodRegistration, { authorize: unknown }>
type Method = ReturnType<Editor["method"]["list"]>[number]
type Credential = Awaited<Extract<Awaited<ReturnType<OAuthRegistration["authorize"]>>, { mode: "auto" }>["callback"]>

const SERVER = "github"
const ID = "mcp_0123456789abcdef"
const LOCATION = { directory: "/workspace" }
const PAT = "github_pat_" + "A".repeat(40)
const DEVICE_TOKEN = "gho_" + "D".repeat(36)
const INPUT = { serverName: SERVER, clientId: "Iv1.client", scopes: ["repo", "read:org"], endpoints: GITHUB_COM, conflict: () => false }

type Entry = { ref: { id: string; name: string }; methods: Method[]; implementations: Map<string, OAuthRegistration> }

// A model of the host's integration state: transforms replay in registration order on every read.
// `emit()` publishes `integration.updated` to open subscriptions; `end()` ends them.
function fakeHost() {
  const transforms: Array<(editor: Editor) => void> = []
  const servers: Array<{ name: string; status: { status: "needs_auth"; error: string }; integrationID?: string }> = []
  let listCalls = 0
  let announceOnCall = Number.POSITIVE_INFINITY
  const streams = new Set<{ push(): void; end(): void }>()
  const subscriptions: Array<{ types: readonly string[] | undefined; signal: AbortSignal | undefined }> = []

  const subscribe = ((options?: { types?: readonly string[]; signal?: AbortSignal }) => ({
    [Symbol.asyncIterator]() {
      subscriptions.push({ types: options?.types, signal: options?.signal })
      let pending = 0
      let ended = false
      let wake: (() => void) | undefined
      const stream = {
        push: () => {
          pending++
          wake?.()
        },
        end: () => {
          ended = true
          wake?.()
        },
      }
      streams.add(stream)
      const close = () => {
        streams.delete(stream)
        return Promise.resolve({ done: true as const, value: undefined })
      }
      return {
        next: async () => {
          while (pending === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve))
          if (ended) return close()
          pending--
          return { done: false as const, value: { type: "integration.updated", data: {} } }
        },
        return: close,
      }
    },
  })) as unknown as Ctx["event"]["subscribe"]

  const build = () => {
    const integrations = new Map<string, Entry>()
    const entry = (id: string) => {
      const current: Entry = integrations.get(id) ?? { ref: { id, name: id }, methods: [], implementations: new Map() }
      integrations.set(id, current)
      return current
    }
    const editor: Editor = {
      list: () => [...integrations.values()].map((value) => value.ref),
      get: (id) => integrations.get(id)?.ref,
      update: (id, update) => update(entry(id).ref),
      remove: (id) => void integrations.delete(id),
      method: {
        list: (id) => integrations.get(id)?.methods ?? [],
        update: (input) => {
          const current = entry(input.integrationID)
          const same = (method: Method) => method.type === input.method.type && (!("id" in method) || ("id" in input.method && method.id === input.method.id))
          const index = current.methods.findIndex(same)
          if (index === -1) current.methods.push(input.method)
          else current.methods[index] = input.method
          if ("authorize" in input) current.implementations.set(input.method.id, input)
        },
        remove: (id, method) => {
          const current = integrations.get(id)
          if (!current) return
          current.methods = current.methods.filter((candidate) => !(candidate.type === method.type && "id" in candidate && "id" in method && candidate.id === method.id))
          if (method.type === "oauth") current.implementations.delete(method.id)
        },
      },
    }
    for (const transform of transforms) transform(editor)
    return integrations
  }

  const ctx: Ctx = {
    event: { subscribe },
    mcp: {
      list: async () => {
        listCalls++
        if (listCalls >= announceOnCall && servers.length === 0) registerServer()
        return { location: LOCATION, data: servers.map((server) => ({ ...server })) }
      },
    },
    integration: {
      transform: async (callback) => {
        transforms.push(callback)
        return {
          dispose: async () => {
            const index = transforms.indexOf(callback)
            if (index !== -1) transforms.splice(index, 1)
          },
        }
      },
      get: async ({ integrationID }) => {
        const found = build().get(integrationID)
        if (!found) throw new Error(`Integration not found: ${integrationID}`)
        const methods = found.methods.flatMap((method) => (method.type === "oauth" ? [{ id: method.id, type: method.type, label: method.label }] : []))
        return { location: LOCATION, data: { id: found.ref.id, name: found.ref.name, methods, connections: [] } }
      },
    },
  }

  // What OpenCode does for a remote MCP server: an integration named after the server with one built-in oauth method.
  const hostTransform = (editor: Editor) => {
    editor.update(ID, (ref) => {
      ref.name = SERVER
    })
    editor.method.update({
      integrationID: ID,
      method: { id: ID, type: "oauth", label: SERVER },
      authorize: async () => {
        throw new Error("dynamic client registration is not supported")
      },
    })
  }
  function registerServer() {
    servers.push({ name: SERVER, status: { status: "needs_auth", error: "sign in" }, integrationID: ID })
    transforms.push(hostTransform)
  }
  // Re-registering the server (a config change) moves the host's transform to the end.
  const reregisterServer = () => {
    transforms.splice(transforms.indexOf(hostTransform), 1)
    transforms.push(hostTransform)
  }

  return {
    ctx,
    build,
    transforms,
    registerServer,
    reregisterServer,
    announceOnCall: (call: number) => {
      announceOnCall = call
    },
    listCalls: () => listCalls,
    emit: () => {
      for (const stream of streams) stream.push()
    },
    end: () => {
      for (const stream of [...streams]) stream.end()
    },
    openStreams: () => streams.size,
    subscriptions,
    integration: () => build().get(ID),
    implementation: (methodID: string) => {
      const found = build().get(ID)?.implementations.get(methodID)
      if (!found) throw new Error(`method ${methodID} is not registered`)
      return found
    },
  }
}

type Route = (init: RequestInit) => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function stubFetch(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    init.signal?.throwIfAborted()
    const route = routes[url]
    const handler = Array.isArray(route) ? route.shift() : route
    if (!handler) throw new Error(`unexpected request to ${url}`)
    return handler(init)
  })
  return calls
}

const deviceRoutes = (token: Route[]) => ({
  "https://github.com/login/device/code": () =>
    json({ device_code: "device-code", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }),
  "https://github.com/login/oauth/access_token": token,
  "https://api.github.com/user": (init: RequestInit) =>
    new Headers(init.headers).get("authorization") === `Bearer ${DEVICE_TOKEN}` ? json({ login: "octocat" }) : json({}, 401),
})

async function signedOutHost() {
  const host = fakeHost()
  host.registerServer()
  const auth = await registerAuth(host.ctx, INPUT)
  await vi.advanceTimersByTimeAsync(0)
  return { host, auth }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("integration discovery", () => {
  it("returns at once, then finds the server's integration in the background", async () => {
    const host = fakeHost()
    host.announceOnCall(3)
    const auth = await registerAuth(host.ctx, INPUT)
    expect(auth.integrationID()).toBeUndefined()
    expect(host.transforms).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(250)
    expect(host.listCalls()).toBe(2)
    expect(auth.integrationID()).toBeUndefined()

    await vi.advanceTimersByTimeAsync(250)
    expect(host.listCalls()).toBe(3)
    expect(auth.integrationID()).toBe(ID)
    await auth.dispose()
  })

  it("registers after the host's transform, so the built-in method is replaced", async () => {
    const { host, auth } = await signedOutHost()
    const integration = host.integration()
    expect(integration?.ref.name).toBe("GitHub")
    expect(integration?.methods).toEqual([
      { id: DEVICE_METHOD_ID, type: "oauth", label: "Sign in with GitHub" },
      { id: TOKEN_METHOD_ID, type: "oauth", label: "Use a fine-grained personal access token" },
    ])
    expect(host.transforms).toHaveLength(2)
    await auth.dispose()
  })

  it("registers a refresh hook only on device sign-in and labels accounts with the GitHub login", async () => {
    const { host, auth } = await signedOutHost()
    for (const id of [DEVICE_METHOD_ID, TOKEN_METHOD_ID]) {
      const method = host.implementation(id)
      expect("refresh" in method).toBe(id === DEVICE_METHOD_ID)
      const credential: Credential = { type: "oauth", methodID: id as Credential["methodID"], access: "x", refresh: "", expires: 0 }
      expect(method.label?.({ ...credential, metadata: { login: "octocat" } })).toBe("octocat")
      expect(method.label?.(credential)).toBeUndefined()
    }
    await auth.dispose()
  })

  it("attaches again when the host re-registers the server after the plugin", async () => {
    const { host, auth } = await signedOutHost()
    host.reregisterServer()
    expect(host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))).toContain(ID)

    await vi.advanceTimersByTimeAsync(250)
    expect(host.integration()?.ref.name).toBe("GitHub")
    expect(host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])
    // The previous registration was disposed: the host's transform plus one of ours.
    expect(host.transforms).toHaveLength(2)
    await auth.dispose()
  })

  it("subscribes to integration.updated", async () => {
    const { host, auth } = await signedOutHost()
    expect(host.subscriptions).toHaveLength(1)
    expect(host.subscriptions[0]?.types).toEqual(["integration.updated"])
    expect(host.openStreams()).toBe(1)
    await auth.dispose()
  })

  it("polls only for the first 10 seconds, then checks when an integration changes", async () => {
    const host = fakeHost()
    const auth = await registerAuth(host.ctx, INPUT)
    await vi.advanceTimersByTimeAsync(10_000)
    const fast = host.listCalls()
    expect(fast).toBeGreaterThanOrEqual(40)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.listCalls()).toBe(fast)

    host.registerServer()
    await vi.advanceTimersByTimeAsync(0)
    expect(auth.integrationID()).toBeUndefined()
    host.emit()
    await vi.advanceTimersByTimeAsync(0)
    expect(auth.integrationID()).toBe(ID)
    expect(host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])
    await auth.dispose()
  })

  it("attaches again on integration.updated when the host re-registers the server after the startup window", async () => {
    const { host, auth } = await signedOutHost()
    await vi.advanceTimersByTimeAsync(10_000)
    host.reregisterServer()
    expect(host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))).toContain(ID)
    host.emit()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.integration()?.ref.name).toBe("GitHub")
    expect(host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])
    expect(host.transforms).toHaveLength(2)
    await auth.dispose()
  })

  it("folds a burst of events into fewer checks and does not re-register when nothing changed", async () => {
    const { host, auth } = await signedOutHost()
    await vi.advanceTimersByTimeAsync(10_000)
    const calls = host.listCalls()
    for (let index = 0; index < 10; index++) host.emit()
    await vi.advanceTimersByTimeAsync(0)
    // Events that arrive during a check are folded into one more check.
    expect(host.listCalls() - calls).toBeGreaterThan(0)
    expect(host.listCalls() - calls).toBeLessThan(10)
    expect(host.transforms).toHaveLength(2)
    await auth.dispose()
  })

  it("subscribes again after the event stream ends", async () => {
    const { host, auth } = await signedOutHost()
    await vi.advanceTimersByTimeAsync(10_000)
    host.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.openStreams()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(host.subscriptions).toHaveLength(2)
    expect(host.openStreams()).toBe(1)
    host.reregisterServer()
    host.emit()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])
    await auth.dispose()
  })

  it("never creates the integration when the server has gone", async () => {
    const { host, auth } = await signedOutHost()
    host.transforms.splice(host.transforms.length - 2, 1)
    expect(host.build().has(ID)).toBe(false)
    await auth.dispose()
  })

  it("survives a failing lookup and never throws", async () => {
    const host = fakeHost()
    let failures = 2
    const list = host.ctx.mcp.list
    const ctx: Ctx = {
      ...host.ctx,
      mcp: {
        list: async (...args) => {
          if (failures-- > 0) throw new Error("not ready")
          return list(...args)
        },
      },
    }
    host.registerServer()
    const auth = await registerAuth(ctx, INPUT)
    await vi.advanceTimersByTimeAsync(500)
    expect(auth.integrationID()).toBe(ID)
    await auth.dispose()
  })
})

describe("a server named github that is not this plugin's", () => {
  const methodIDs = (host: ReturnType<typeof fakeHost>) => host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))

  it("waits until OpenCode has applied the MCP config", async () => {
    const host = fakeHost()
    host.registerServer()
    let conflict: boolean | undefined
    const auth = await registerAuth(host.ctx, { ...INPUT, conflict: () => conflict })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(auth.integrationID()).toBeUndefined()
    expect(host.transforms).toHaveLength(1)
    conflict = false
    await vi.advanceTimersByTimeAsync(250)
    expect(auth.integrationID()).toBe(ID)
    expect(methodIDs(host)).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])
    await auth.dispose()
  })

  it("leaves the user's server, its name and its own sign-in method alone", async () => {
    const host = fakeHost()
    host.registerServer()
    const auth = await registerAuth(host.ctx, { ...INPUT, conflict: () => true })
    await vi.advanceTimersByTimeAsync(10_000)
    host.emit()
    await vi.advanceTimersByTimeAsync(0)
    expect(auth.integrationID()).toBeUndefined()
    expect(host.transforms).toHaveLength(1)
    expect(host.integration()?.ref.name).toBe(SERVER)
    expect(methodIDs(host)).toEqual([ID])
    await auth.dispose()
  })

  it("never strips the user's method when the conflict appears later, and detaches on the next event", async () => {
    const { host, auth } = await signedOutHost()
    let conflict = false
    const later = await registerAuth(host.ctx, { ...INPUT, conflict: () => conflict })
    await vi.advanceTimersByTimeAsync(0)
    await auth.dispose()
    expect(methodIDs(host)).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])

    conflict = true
    // The transform is still registered, but it is a no-op from now on.
    expect(host.transforms).toHaveLength(2)
    expect(methodIDs(host)).toEqual([ID])
    host.emit()
    await vi.advanceTimersByTimeAsync(0)
    expect(later.integrationID()).toBeUndefined()
    expect(host.transforms).toHaveLength(1)

    // The user removes their server again: the plugin's methods come back.
    conflict = false
    host.emit()
    await vi.advanceTimersByTimeAsync(0)
    expect(later.integrationID()).toBe(ID)
    expect(methodIDs(host)).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])
    await later.dispose()
  })
})

describe("dispose", () => {
  it("stops retries and removes the methods", async () => {
    const host = fakeHost()
    const auth = await registerAuth(host.ctx, INPUT)
    await vi.advanceTimersByTimeAsync(1_000)
    await auth.dispose()
    const calls = host.listCalls()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.listCalls()).toBe(calls)
    expect(host.subscriptions[0]?.signal?.aborted).toBe(true)
    expect(host.openStreams()).toBe(0)

    const signedIn = await signedOutHost()
    await signedIn.auth.dispose()
    expect(signedIn.host.transforms).toHaveLength(1)
    expect(signedIn.host.integration()?.methods.map((method) => ("id" in method ? method.id : method.type))).toEqual([ID])
  })

  it("aborts a device sign-in that is still polling", async () => {
    const { host, auth } = await signedOutHost()
    stubFetch(deviceRoutes([() => json({ error: "authorization_pending" })]))
    const authorization = await host.implementation(DEVICE_METHOD_ID).authorize({})
    if (authorization.mode !== "auto") throw new Error("expected auto mode")
    const outcome = authorization.callback.then(
      () => "resolved",
      () => "rejected",
    )
    await auth.dispose()
    expect(await outcome).toBe("rejected")
  })
})

describe("device sign-in", () => {
  it("offers only the token method without a client ID", async () => {
    const host = fakeHost()
    host.registerServer()
    const { clientId: _, ...withoutClientId } = INPUT
    const auth = await registerAuth(host.ctx, withoutClientId)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.integration()?.methods).toEqual([{ id: TOKEN_METHOD_ID, type: "oauth", label: "Use a fine-grained personal access token" }])
    expect(() => host.implementation(DEVICE_METHOD_ID)).toThrow()
    await auth.dispose()
  })

  it("shows the code, polls GitHub, and resolves to an oauth credential", async () => {
    const { host, auth } = await signedOutHost()
    const calls = stubFetch(deviceRoutes([() => json({ error: "authorization_pending" }), () => json({ access_token: DEVICE_TOKEN, token_type: "bearer", scope: "repo,read:org" })]))
    const now = Date.now()
    const authorization = await host.implementation(DEVICE_METHOD_ID).authorize({})
    expect(authorization).toMatchObject({
      url: "https://github.com/login/device",
      instructions: "Enter code WDJB-MJHT on GitHub to finish signing in.",
      expiresAt: now + 900_000,
      mode: "auto",
    })
    if (authorization.mode !== "auto") throw new Error("expected auto mode")
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body)))).toEqual({ client_id: "Iv1.client", scope: "repo read:org" })

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(authorization.callback).resolves.toEqual({
      type: "oauth",
      methodID: DEVICE_METHOD_ID,
      access: DEVICE_TOKEN,
      refresh: "",
      expires: 0,
      metadata: { tokenType: "Bearer", scope: "repo,read:org", login: "octocat" },
    })
    expect(calls.map((call) => call.url)).toEqual([
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ])
    await auth.dispose()
  })

  it("stops polling for an older code when a new sign-in starts", async () => {
    const { host, auth } = await signedOutHost()
    stubFetch({
      ...deviceRoutes([() => json({ error: "authorization_pending" })]),
      "https://github.com/login/device/code": [
        () => json({ device_code: "first", user_code: "AAAA-AAAA", verification_uri: "https://github.com/login/device" }),
        () => json({ device_code: "second", user_code: "BBBB-BBBB", verification_uri: "https://github.com/login/device" }),
      ],
    })
    const method = host.implementation(DEVICE_METHOD_ID)
    const first = await method.authorize({})
    if (first.mode !== "auto") throw new Error("expected auto mode")
    const firstOutcome = first.callback.then(
      () => "resolved",
      () => "rejected",
    )
    await method.authorize({})
    expect(await firstOutcome).toBe("rejected")
    await auth.dispose()
  })
})

describe("GitHub App device sign-in", () => {
  const APP_TOKEN = "ghu_" + "A".repeat(36)
  const REFRESH = "ghr_" + "R".repeat(40)
  const NEW_TOKEN = "ghu_" + "B".repeat(36)
  const NEW_REFRESH = "ghr_" + "S".repeat(40)
  const OAUTH_URL = "https://github.com/login/oauth/access_token"
  const INSTALLATIONS_URL = "https://api.github.com/user/installations?per_page=1"
  // What OpenCode does before it uses a credential: renew it through the method's refresh when it expires within five minutes.
  const resolve = async (host: ReturnType<typeof fakeHost>, credential: Credential) =>
    credential.expires <= Date.now() + 5 * 60_000 ? await host.implementation(DEVICE_METHOD_ID).refresh!(credential) : credential

  async function appSignIn(host: ReturnType<typeof fakeHost>, installations: number) {
    const calls = stubFetch({
      "https://github.com/login/device/code": () =>
        json({ device_code: "device-code", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }),
      [OAUTH_URL]: [
        () => json({ access_token: APP_TOKEN, expires_in: 1, refresh_token: REFRESH, refresh_token_expires_in: 15897600, scope: "", token_type: "bearer" }),
        (init) => {
          const form = Object.fromEntries(new URLSearchParams(String(init.body)))
          return form.refresh_token === REFRESH
            ? json({ access_token: NEW_TOKEN, expires_in: 28800, refresh_token: NEW_REFRESH, refresh_token_expires_in: 15897600, scope: "", token_type: "bearer" })
            : json({ error: "bad_refresh_token" })
        },
        () => json({ error: "bad_refresh_token" }),
      ],
      "https://api.github.com/user": () => json({ login: "octocat" }),
      [INSTALLATIONS_URL]: [() => json({ total_count: installations }), () => json({ total_count: 1 })],
    })
    const authorization = await host.implementation(DEVICE_METHOD_ID).authorize({})
    if (authorization.mode !== "auto") throw new Error("expected auto mode")
    await vi.advanceTimersByTimeAsync(5_000)
    return { credential: await authorization.callback, calls }
  }

  it("renews an expiring token once with the refresh token, with no client secret, and keeps the new refresh token", async () => {
    const { host, auth } = await signedOutHost()
    const { credential, calls } = await appSignIn(host, 1)
    const signedInAt = Date.now()
    expect(credential).toMatchObject({ access: APP_TOKEN, refresh: REFRESH, expires: signedInAt + 1000, metadata: { login: "octocat", githubApp: true, installations: 1 } })
    expect(host.implementation(DEVICE_METHOD_ID).label?.(credential)).toBe("octocat")

    await vi.advanceTimersByTimeAsync(2_000)
    const renewed = await resolve(host, credential)
    expect(renewed).toMatchObject({ methodID: DEVICE_METHOD_ID, access: NEW_TOKEN, refresh: NEW_REFRESH, expires: Date.now() + 28_800_000, metadata: { login: "octocat", githubApp: true } })
    const refreshes = calls.filter((call) => call.url === OAUTH_URL).slice(1)
    expect(refreshes).toHaveLength(1)
    expect(Object.fromEntries(new URLSearchParams(String(refreshes[0]?.init.body)))).toEqual({ client_id: "Iv1.client", grant_type: "refresh_token", refresh_token: REFRESH })
    // A fresh token is not renewed again.
    expect(await resolve(host, renewed)).toBe(renewed)
    expect(calls.filter((call) => call.url === OAUTH_URL)).toHaveLength(2)
    await auth.dispose()
  })

  it("asks for a new sign-in when GitHub refuses the refresh token, or it is older than six months", async () => {
    const { host, auth } = await signedOutHost()
    const { credential } = await appSignIn(host, 1)
    const stale = { ...credential, refresh: "ghr_" + "X".repeat(40) }
    await expect(resolve(host, stale)).rejects.toThrow("SIGN_IN_REJECTED: GitHub rejected the saved sign-in. Next step: Run /connect and choose GitHub to sign in again.")
    const old = { ...credential, metadata: { ...credential.metadata, refreshExpires: Date.now() - 1 } }
    await expect(resolve(host, old)).rejects.toThrow(/^SIGN_IN_REJECTED: /)
    await auth.dispose()
  })

  it("labels the account with the login alone, since OpenCode never updates a label, and records no installation", async () => {
    const host = fakeHost()
    host.registerServer()
    const auth = await registerAuth(host.ctx, { ...INPUT, appSlug: "jelly-dev" })
    await vi.advanceTimersByTimeAsync(0)
    const { credential } = await appSignIn(host, 0)
    expect(credential.metadata).toMatchObject({ installations: 0 })
    expect(host.implementation(DEVICE_METHOD_ID).label?.(credential)).toBe("octocat")
    await auth.dispose()
  })

  it("returns the rotated pair without waiting for an installation count that never answers", async () => {
    const { host, auth } = await signedOutHost()
    const { credential, calls } = await appSignIn(host, 0)
    await vi.advanceTimersByTimeAsync(2_000)
    // From now on the installation count would hang: the renewal must not touch it.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url === OAUTH_URL) return json({ access_token: NEW_TOKEN, expires_in: 28800, refresh_token: NEW_REFRESH, scope: "", token_type: "bearer" })
      return new Promise<Response>(() => undefined)
    })
    const renewed = await resolve(host, credential)
    expect(renewed).toMatchObject({ access: NEW_TOKEN, refresh: NEW_REFRESH, metadata: { installations: 0 } })
    expect(calls.map((call) => call.url).filter((url) => url === INSTALLATIONS_URL)).toHaveLength(1)
    await auth.dispose()
  })

  it("returns an OAuth App's credential unchanged, with no request, though OpenCode treats expires 0 as expiring", async () => {
    const { host, auth } = await signedOutHost()
    const calls = stubFetch({})
    const classic: Credential = { type: "oauth", methodID: DEVICE_METHOD_ID as Credential["methodID"], access: DEVICE_TOKEN, refresh: "", expires: 0, metadata: { tokenType: "Bearer", scope: "repo,read:org", login: "octocat" } }
    expect(await resolve(host, classic)).toBe(classic)
    expect(calls).toHaveLength(0)
    expect(host.implementation(TOKEN_METHOD_ID).refresh).toBeUndefined()
    await auth.dispose()
  })
})

describe("token sign-in", () => {
  it("links to a prefilled fine-grained token page and asks for the token", async () => {
    const { host, auth } = await signedOutHost()
    const authorization = await host.implementation(TOKEN_METHOD_ID).authorize({})
    expect(authorization.mode).toBe("code")
    expect(authorization.instructions).toBe(
      "Create a fine-grained token for the repositories you want, with read access to Metadata, Contents, Issues, Pull requests, Commit statuses, Actions, Code quality, Code scanning alerts, Dependabot alerts, Secret scanning alerts, Repository security advisories, Discussions (the page fills these in), then paste it here.",
    )
    const url = new URL(authorization.url)
    expect(url.origin + url.pathname).toBe("https://github.com/settings/personal-access-tokens/new")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
      statuses: "read",
      actions: "read",
      code_quality: "read",
      security_events: "read",
      vulnerability_alerts: "read",
      secret_scanning_alerts: "read",
      repository_advisories: "read",
      discussions: "read",
    })
    await auth.dispose()
  })

  it.each(["", "not-a-token", "ghp_short", "gho_" + "A".repeat(36), "github_pat_has space in it 1234567890", "Bearer " + PAT])(
    "rejects %j without calling GitHub",
    async (code) => {
      const { host, auth } = await signedOutHost()
      const calls = stubFetch({})
      const authorization = await host.implementation(TOKEN_METHOD_ID).authorize({})
      if (authorization.mode !== "code") throw new Error("expected code mode")
      await expect(authorization.callback(code)).rejects.toThrow("That does not look like a GitHub personal access token.")
      expect(calls).toHaveLength(0)
      await auth.dispose()
    },
  )

  it.each([PAT, "ghp_" + "b".repeat(36)])("accepts %s, checks it with GitHub, and stores it as an oauth credential", async (token) => {
    const { host, auth } = await signedOutHost()
    const calls = stubFetch({ "https://api.github.com/user": () => json({ login: "octocat" }) })
    const authorization = await host.implementation(TOKEN_METHOD_ID).authorize({})
    if (authorization.mode !== "code") throw new Error("expected code mode")
    await expect(authorization.callback(`  ${token}\n`)).resolves.toEqual({
      type: "oauth",
      methodID: TOKEN_METHOD_ID,
      access: token,
      refresh: "",
      expires: 0,
      metadata: { tokenType: "Bearer", login: "octocat" },
    })
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${token}`)
    await auth.dispose()
  })

  it("reports a token GitHub rejects without echoing it", async () => {
    const { host, auth } = await signedOutHost()
    stubFetch({ "https://api.github.com/user": () => json({ message: "Bad credentials" }, 401) })
    const authorization = await host.implementation(TOKEN_METHOD_ID).authorize({})
    if (authorization.mode !== "code") throw new Error("expected code mode")
    const error = await authorization.callback(PAT).catch((cause: Error) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/GitHub rejected the token/)
    expect((error as Error).message).not.toContain(PAT)
    await auth.dispose()
  })
})
