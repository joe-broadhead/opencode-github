// Reports a rejected sign-in on the GitHub integration's active account, so /connect shows
// "Sign in required" for it, and clears the report once the github server connects again.
// OpenCode marks the server needs_auth when GitHub refuses the stored token.
import type { Plugin } from "@opencode/plugin"
import { delay, forEachEvent } from "./events.js"

export const REJECTED_MESSAGE = "GitHub rejected the saved sign-in. Sign in again."
const RESUBSCRIBE_MS = 5_000

type SignInStatusContext = {
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
  readonly integration: { readonly connection: Pick<Plugin.Context["integration"]["connection"], "active" | "status"> }
  readonly event: Pick<Plugin.Context["event"], "subscribe">
}

export async function registerSignInStatus(
  ctx: SignInStatusContext,
  input: {
    readonly serverName: string
    /** From registerAuth: set while the sign-in methods are attached to this plugin's server. */
    readonly integrationID: () => string | undefined
  },
): Promise<{ dispose(): Promise<void> }> {
  const stopped = new AbortController()

  const sync = async () => {
    const id = input.integrationID()
    if (!id || stopped.signal.aborted) return
    const [servers, connection] = await Promise.all([ctx.mcp.list(), ctx.integration.connection.active(id)])
    if (connection?.type !== "credential") return
    const rejected = servers.data.find((server) => server.name === input.serverName)?.status.status === "needs_auth"
    if (rejected === (connection.status !== undefined)) return
    await ctx.integration.connection.status({
      integrationID: id,
      connection,
      status: rejected ? { status: "needs_auth", message: REJECTED_MESSAGE } : undefined,
    })
  }

  const listen = (async () => {
    while (!stopped.signal.aborted) {
      await forEachEvent(ctx.event.subscribe, ["mcp.status.changed"], stopped.signal, (event) => {
        if (event.data.server === input.serverName) void sync().catch(() => undefined)
      }).catch(() => undefined)
      await delay(RESUBSCRIBE_MS, stopped.signal)
    }
  })()

  return {
    async dispose() {
      stopped.abort()
      await listen
    },
  }
}
