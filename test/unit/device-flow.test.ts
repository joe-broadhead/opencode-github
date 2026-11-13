import { describe, expect, it, vi } from "vitest"
import { type Fetch, fetchInstallationCount, fetchLogin, pollAccessToken, refreshAccessToken, requestDeviceCode } from "../../src/device-flow.js"

const TOKEN = "gho_" + "S".repeat(36)
const DEVICE_CODE = "device-code-secret"

type Call = { url: string; init: RequestInit; form?: URLSearchParams }

function fakeFetch(responses: Array<Response | Error | ((call: Call) => Response)>) {
  const calls: Call[] = []
  const fetch: Fetch = async (url, init) => {
    const call: Call = { url, init, ...(typeof init.body === "string" ? { form: new URLSearchParams(init.body) } : {}) }
    calls.push(call)
    init.signal?.throwIfAborted()
    const next = responses.shift()
    if (!next) throw new Error("unexpected request")
    if (next instanceof Error) throw next
    return typeof next === "function" ? next(call) : next
  }
  return { fetch, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// A clock that only moves when the poller sleeps.
function clock(start = 1_000_000) {
  let now = start
  const sleeps: number[] = []
  return {
    now: () => now,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      sleeps.push(ms)
      now += ms
    },
  }
}

function poll(fetch: Fetch, time: ReturnType<typeof clock>, overrides: Partial<Parameters<typeof pollAccessToken>[0]> = {}) {
  return pollAccessToken({
    clientId: "Iv1.client",
    deviceCode: DEVICE_CODE,
    interval: 5,
    expiresAt: time.now() + 900_000,
    fetch,
    sleep: time.sleep,
    now: time.now,
    ...overrides,
  })
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(Error)
  return (error as Error).message
}

function expectNoSecrets(message: string) {
  expect(message).not.toContain(TOKEN)
  expect(message).not.toContain(DEVICE_CODE)
}

describe("GitHub Enterprise Server", () => {
  it("signs in and checks the token on the server", async () => {
    const endpoints = { web: "https://ghe.example.com", api: "https://ghe.example.com/api/v3", graphql: "https://ghe.example.com/api/graphql", uploads: "https://ghe.example.com/api/uploads" }
    const urls: string[] = []
    const fetch: Fetch = async (url) => {
      urls.push(url)
      if (url.endsWith("/login/device/code")) return json({ device_code: "d", user_code: "ABCD-EFGH", verification_uri: "https://ghe.example.com/login/device", expires_in: 900, interval: 5 })
      if (url.endsWith("/login/oauth/access_token")) return json({ access_token: TOKEN, token_type: "bearer", scope: "repo" })
      return json({ login: "octocat" })
    }
    const code = await requestDeviceCode({ clientId: "Iv1.client", scopes: ["repo"], fetch, endpoints })
    await pollAccessToken({ clientId: "Iv1.client", deviceCode: code.deviceCode, interval: 0, expiresAt: Date.now() + 60_000, fetch, endpoints, sleep: async () => {} })
    expect(await fetchLogin(TOKEN, { fetch, endpoints })).toBe("octocat")
    expect(urls).toEqual(["https://ghe.example.com/login/device/code", "https://ghe.example.com/login/oauth/access_token", "https://ghe.example.com/api/v3/user"])
    const unreachable: Fetch = async () => {
      throw new TypeError("fetch failed")
    }
    expect(await messageOf(fetchLogin(TOKEN, { fetch: unreachable, endpoints }))).toMatch(/^TOKEN_CHECK_UNREACHABLE: Could not reach ghe\.example\.com to check the token\./)
  })
})

describe("requestDeviceCode", () => {
  it("posts only the client ID and scopes (no client secret) and maps the response", async () => {
    const { fetch, calls } = fakeFetch([
      json({ device_code: DEVICE_CODE, user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }),
    ])
    const code = await requestDeviceCode({ clientId: "Iv1.client", scopes: ["repo", "read:org"], fetch, now: () => 1_000 })
    expect(code).toEqual({ deviceCode: DEVICE_CODE, userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: 901_000, interval: 5 })
    expect(calls[0]?.url).toBe("https://github.com/login/device/code")
    expect(calls[0]?.init.method).toBe("POST")
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe("application/json")
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ client_id: "Iv1.client", scope: "repo read:org" })
  })

  it("explains a disabled device flow and an unknown client ID", async () => {
    const disabled = fakeFetch([json({ error: "device_flow_disabled" }, 400)])
    expect(await messageOf(requestDeviceCode({ clientId: "Iv1.client", scopes: [], fetch: disabled.fetch }))).toMatch(/Device sign-in is turned off/)
    const unknown = fakeFetch([json({ error: "incorrect_client_credentials" }, 404)])
    expect(await messageOf(requestDeviceCode({ clientId: "Iv1.client", scopes: [], fetch: unknown.fetch }))).toMatch(/clientId/)
  })

  it("explains a request that timed out, but passes a cancellation through", async () => {
    const timedOut = AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"))
    const slow = fakeFetch([new DOMException("The operation timed out.", "TimeoutError")])
    expect(await messageOf(requestDeviceCode({ clientId: "Iv1.client", scopes: [], fetch: slow.fetch, signal: timedOut }))).toMatch(/Could not reach github.com/)
    const cancelled = AbortSignal.abort(new Error("stopped"))
    await expect(requestDeviceCode({ clientId: "Iv1.client", scopes: [], fetch: fakeFetch([]).fetch, signal: cancelled })).rejects.toThrow("stopped")
  })

  it("rejects a response without an https verification URL", async () => {
    const { fetch } = fakeFetch([json({ device_code: "d", user_code: "u", verification_uri: "http://example.test/device" })])
    expect(await messageOf(requestDeviceCode({ clientId: "Iv1.client", scopes: [], fetch }))).toMatch(/incomplete sign-in code/)
  })
})

describe("pollAccessToken", () => {
  it("returns the token on success", async () => {
    const time = clock()
    const { fetch, calls } = fakeFetch([json({ access_token: TOKEN, token_type: "bearer", scope: "repo,read:org" })])
    await expect(poll(fetch, time)).resolves.toEqual({ accessToken: TOKEN, scope: "repo,read:org" })
    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token")
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      client_id: "Iv1.client",
      device_code: DEVICE_CODE,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
    expect(time.sleeps).toEqual([5000])
  })

  it("keeps a refresh token and lifetime when GitHub returns them", async () => {
    const time = clock()
    const { fetch } = fakeFetch([json({ access_token: TOKEN, scope: "", refresh_token: "ghr_x", expires_in: 28800 })])
    await expect(poll(fetch, time)).resolves.toEqual({ accessToken: TOKEN, scope: "", refreshToken: "ghr_x", expiresIn: 28800 })
  })

  it("waits the interval while authorization is pending", async () => {
    const time = clock()
    const { fetch, calls } = fakeFetch([
      json({ error: "authorization_pending" }),
      json({ error: "authorization_pending" }),
      json({ access_token: TOKEN, scope: "repo" }),
    ])
    await expect(poll(fetch, time)).resolves.toMatchObject({ accessToken: TOKEN })
    expect(calls).toHaveLength(3)
    expect(time.sleeps).toEqual([5000, 5000, 5000])
  })

  it("adds 5 seconds to the interval on slow_down", async () => {
    const time = clock()
    const { fetch } = fakeFetch([json({ error: "slow_down" }), json({ error: "slow_down" }), json({ access_token: TOKEN, scope: "" })])
    await poll(fetch, time)
    expect(time.sleeps).toEqual([5000, 10000, 15000])
  })

  it.each([
    ["expired_token", /^SIGN_IN_EXPIRED: The GitHub sign-in code expired before it was entered\./],
    ["access_denied", /^SIGN_IN_CANCELLED: Sign-in was cancelled on GitHub\./],
    ["incorrect_device_code", /^SIGN_IN_CODE_UNKNOWN: GitHub did not recognise the sign-in code\./],
    ["something_new", /^SIGN_IN_FAILED: GitHub sign-in failed \(something_new\)\./],
  ])("stops with a coded error and one next step on %s", async (code, message) => {
    const time = clock()
    const { fetch } = fakeFetch([json({ error: code }, 400)])
    const text = await messageOf(poll(fetch, time))
    expect(text).toMatch(message)
    expect(text).toMatch(/ Next step: Start the sign-in again\.$/)
    expectNoSecrets(text)
  })

  it("stops at expiresAt without polling past it", async () => {
    const time = clock()
    const responses = Array.from({ length: 10 }, () => json({ error: "authorization_pending" }))
    const { fetch, calls } = fakeFetch(responses)
    const text = await messageOf(poll(fetch, time, { expiresAt: time.now() + 12_000 }))
    expect(text).toMatch(/expired before it was entered/)
    expect(calls).toHaveLength(2)
    expect(time.sleeps).toEqual([5000, 5000, 2000])
  })

  it("honours an abort signal during the wait", async () => {
    const controller = new AbortController()
    const { fetch, calls } = fakeFetch([json({ error: "authorization_pending" })])
    const pending = pollAccessToken({ clientId: "Iv1.client", deviceCode: DEVICE_CODE, interval: 5, expiresAt: Date.now() + 900_000, fetch, signal: controller.signal })
    controller.abort(new Error("stopped"))
    await expect(pending).rejects.toThrow("stopped")
    expect(calls).toHaveLength(0)
  })

  it("honours an abort signal between polls", async () => {
    const time = clock()
    const controller = new AbortController()
    const { fetch, calls } = fakeFetch([
      () => {
        controller.abort(new Error("stopped"))
        return json({ error: "authorization_pending" })
      },
    ])
    await expect(poll(fetch, time, { signal: controller.signal })).rejects.toThrow("stopped")
    expect(calls).toHaveLength(1)
  })

  it("reports an unexpected response without its body", async () => {
    const time = clock()
    const { fetch } = fakeFetch([new Response(`<html>${TOKEN}</html>`, { status: 502 })])
    const text = await messageOf(poll(fetch, time))
    expect(text).toBe("SIGN_IN_UNEXPECTED_RESPONSE: GitHub returned an unexpected response (HTTP 502). Next step: Start the sign-in again.")
  })

  it("reports a network failure without the request details", async () => {
    const time = clock()
    const { fetch } = fakeFetch([new TypeError(`fetch failed for ${DEVICE_CODE}`)])
    const text = await messageOf(poll(fetch, time))
    expect(text).toMatch(/Could not reach github.com/)
    expectNoSecrets(text)
  })
})

describe("fetchLogin", () => {
  it("returns the login for a valid token", async () => {
    const { fetch, calls } = fakeFetch([json({ login: "octocat", id: 1 })])
    await expect(fetchLogin(TOKEN, { fetch })).resolves.toBe("octocat")
    const headers = new Headers(calls[0]?.init.headers)
    expect(calls[0]?.url).toBe("https://api.github.com/user")
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(headers.get("accept")).toBe("application/vnd.github+json")
    expect(headers.get("x-github-api-version")).toBe("2022-11-28")
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it("explains a rejected token without echoing it", async () => {
    const { fetch } = fakeFetch([json({ message: "Bad credentials" }, 401)])
    const text = await messageOf(fetchLogin(TOKEN, { fetch }))
    expect(text).toMatch(/GitHub rejected the token/)
    expectNoSecrets(text)
  })

  it("explains a refused token and other failures", async () => {
    expect(await messageOf(fetchLogin(TOKEN, { fetch: fakeFetch([json({}, 403)]).fetch }))).toMatch(/HTTP 403/)
    expect(await messageOf(fetchLogin(TOKEN, { fetch: fakeFetch([json({}, 500)]).fetch }))).toMatch(/HTTP 500/)
    expect(await messageOf(fetchLogin(TOKEN, { fetch: fakeFetch([json({})]).fetch }))).toMatch(/did not return an account name/)
  })

  it("gives up after 10 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
    try {
      const fetch: Fetch = async () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      }
      expect(await messageOf(fetchLogin(TOKEN, { fetch }))).toMatch(/did not answer within 10 seconds/)
      expect(timeout).toHaveBeenCalledWith(10_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it("passes the caller's abort through", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stopped"))
    await expect(fetchLogin(TOKEN, { fetch: fakeFetch([json({ login: "octocat" })]).fetch, signal: controller.signal })).rejects.toThrow("stopped")
  })
})

describe("refreshing a GitHub App's user token", () => {
  const REFRESH = "ghr_" + "R".repeat(40)
  const NEW_REFRESH = "ghr_" + "N".repeat(40)
  const NEW_TOKEN = "ghu_" + "U".repeat(36)

  it("exchanges the refresh token for a new pair, with no client secret", async () => {
    const { fetch, calls } = fakeFetch([
      json({ access_token: NEW_TOKEN, expires_in: 28800, refresh_token: NEW_REFRESH, refresh_token_expires_in: 15897600, scope: "", token_type: "bearer" }),
    ])
    await expect(refreshAccessToken({ clientId: "Iv23.client", refreshToken: REFRESH, service: "GitHub", fetch })).resolves.toEqual({
      accessToken: NEW_TOKEN,
      scope: "",
      refreshToken: NEW_REFRESH,
      expiresIn: 28800,
      refreshTokenExpiresIn: 15897600,
    })
    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token")
    expect(Object.fromEntries(calls[0]!.form!)).toEqual({ client_id: "Iv23.client", grant_type: "refresh_token", refresh_token: REFRESH })
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe("application/json")
  })

  it("asks for a new sign-in when GitHub refuses the refresh token, and never shows it", async () => {
    const { fetch } = fakeFetch([json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." })])
    const message = await messageOf(refreshAccessToken({ clientId: "Iv23.client", refreshToken: REFRESH, service: "GitHub", fetch }))
    expect(message).toBe("SIGN_IN_REJECTED: GitHub rejected the saved sign-in. Next step: Run /connect and choose GitHub to sign in again.")
    expect(message).not.toContain(REFRESH)
  })

  it("asks to try again, not to sign in again, when GitHub cannot be reached or fails", async () => {
    const unreachable = fakeFetch([new TypeError("fetch failed")])
    expect(await messageOf(refreshAccessToken({ clientId: "c", refreshToken: REFRESH, service: "GitHub", fetch: unreachable.fetch }))).toMatch(/^REFRESH_UNREACHABLE: /)
    const failing = fakeFetch([new Response("<html>", { status: 502 })])
    expect(await messageOf(refreshAccessToken({ clientId: "c", refreshToken: REFRESH, service: "GitHub", fetch: failing.fetch }))).toMatch(/^REFRESH_FAILED: /)
  })
})

describe("the device code request", () => {
  it("sends the scopes, and no scope at all when the list is empty", async () => {
    const answer = () => json({ device_code: "d", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device" })
    const { fetch, calls } = fakeFetch([answer(), answer()])
    await requestDeviceCode({ clientId: "Ov23.client", scopes: ["repo", "read:org"], fetch })
    await requestDeviceCode({ clientId: "Iv23.client", scopes: [], fetch })
    expect(Object.fromEntries(calls[0]!.form!)).toEqual({ client_id: "Ov23.client", scope: "repo read:org" })
    expect(Object.fromEntries(calls[1]!.form!)).toEqual({ client_id: "Iv23.client" })
  })
})

describe("installation count", () => {
  it("reads total_count, and is undefined when GitHub does not say", async () => {
    const { fetch, calls } = fakeFetch([json({ total_count: 0, installations: [] }), json({ message: "Forbidden" }, 403)])
    expect(await fetchInstallationCount("ghu_x", { fetch })).toBe(0)
    expect(calls[0]?.url).toBe("https://api.github.com/user/installations?per_page=1")
    expect(await fetchInstallationCount("ghu_x", { fetch })).toBeUndefined()
  })
})
