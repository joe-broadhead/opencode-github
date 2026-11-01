// Sign-in for the GitHub MCP server. OpenCode registers every remote MCP server as an
// integration. This replaces the host's generic MCP OAuth method on that integration
// (GitHub has no dynamic client registration, so it cannot succeed) with GitHub device
// flow and a fine-grained personal access token (src/sign-in.ts). The MCP transport sends the
// integration's active oauth-type credential as a Bearer token, whichever method made it,
// and reconnects when it changes. No refresh hook is registered: OAuth App tokens do not
// expire, a personal token is replaced by signing in again, and OpenCode treats
// `expires: 0` as expiring when a refresh hook exists.
//
// The device method is offered only when there is an OAuth App client ID; without one only
// the token method appears. A server named github that the user configured is not this
// plugin's: its integration and its own sign-in are left alone.
import type { Plugin } from "@opencode/plugin"
import { delay, forEachEvent } from "./events.js"
import { type IntegrationEditor, type SignInInput, isOwnMethod, signIn } from "./sign-in.js"

const STARTUP_POLL_MS = 250
const STARTUP_WINDOW_MS = 10_000
const RESUBSCRIBE_MS = 5_000

type AuthContext = {
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
  readonly integration: Pick<Plugin.Context["integration"], "transform" | "get">
  readonly event: Pick<Plugin.Context["event"], "subscribe">
}
type Registration = Awaited<ReturnType<Plugin.Context["integration"]["transform"]>>

export async function registerAuth(
  ctx: AuthContext,
  input: SignInInput & {
    serverName: string
    /** Undefined until OpenCode has applied the MCP config, then true while the server named `serverName` is not this plugin's. */
    conflict: () => boolean | undefined
  },
): Promise<{ dispose(): Promise<void>; integrationID(): string | undefined }> {
  const stopped = new AbortController()
  const methods = signIn(input, stopped.signal)
  let integrationID: string | undefined

  const attachMethods = (editor: IntegrationEditor, id: string) => {
    // Leave a server that is not this plugin's alone. Never create the integration: it
    // belongs to the MCP server and goes away with it.
    if (input.conflict() !== false || !editor.get(id)) return
    editor.update(id, (integration) => {
      integration.name = "GitHub"
    })
    for (const method of editor.method.list(id)) {
      if (method.type === "oauth" && !isOwnMethod(method.id)) editor.method.remove(id, method)
    }
    methods.attach(editor, id)
  }

  // Transforms replay in registration order, and the host registers the server's
  // integration (with its built-in method) only after plugin setup finishes, and again
  // whenever the server's config changes. So the transform is registered once the
  // integration exists, and registered again whenever the host's method reappears, to stay
  // after the host's own transform. OpenCode publishes `integration.updated` whenever an
  // integration or its methods change, so each event triggers a check. A subscription has
  // no start acknowledgement, so the first 10 s are also polled every 250 ms.
  let registration: Registration | undefined
  const attach = async (id: string) => {
    const next = await ctx.integration.transform((editor) => attachMethods(editor, id))
    const previous = registration
    registration = next
    integrationID = id
    await previous?.dispose()
  }
  const detach = async () => {
    const previous = registration
    registration = undefined
    integrationID = undefined
    await previous?.dispose()
  }
  const check = async () => {
    const conflict = input.conflict()
    if (conflict === true) return detach()
    if (conflict === undefined) return
    const found = await lookup(ctx, input.serverName)
    if (found && !stopped.signal.aborted && (found !== integrationID || (await hostMethodReturned(ctx, found)))) {
      await attach(found)
    }
  }
  // One check at a time; triggers that arrive meanwhile cause one more check after it.
  let checking: Promise<void> | undefined
  let again = false
  const schedule = (): Promise<void> => {
    if (checking) {
      again = true
      return checking
    }
    checking = (async () => {
      do {
        again = false
        if (!stopped.signal.aborted) await check().catch(() => undefined)
      } while (again)
    })().finally(() => {
      checking = undefined
    })
    return checking
  }
  const listen = (async () => {
    while (!stopped.signal.aborted) {
      await forEachEvent(ctx.event.subscribe, ["integration.updated"], stopped.signal, () => void schedule()).catch(() => undefined)
      // The stream ended without dispose: check, then subscribe again.
      if (!stopped.signal.aborted) void schedule()
      await delay(RESUBSCRIBE_MS, stopped.signal)
    }
  })()
  const startup = (async () => {
    const until = Date.now() + STARTUP_WINDOW_MS
    while (!stopped.signal.aborted && Date.now() < until) {
      await schedule()
      await delay(STARTUP_POLL_MS, stopped.signal)
    }
  })()

  return {
    integrationID: () => integrationID,
    async dispose() {
      stopped.abort()
      await Promise.all([listen, startup, checking])
      await registration?.dispose()
      registration = undefined
    },
  }
}

async function lookup(ctx: AuthContext, serverName: string): Promise<string | undefined> {
  try {
    return (await ctx.mcp.list()).data.find((server) => server.name === serverName)?.integrationID
  } catch {
    return undefined
  }
}

async function hostMethodReturned(ctx: AuthContext, integrationID: string): Promise<boolean> {
  try {
    const { data } = await ctx.integration.get({ integrationID })
    return data.methods.some((method) => method.type === "oauth" && !isOwnMethod(method.id))
  } catch {
    return false
  }
}
