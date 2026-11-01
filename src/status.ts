// One status, computed fresh on every call (no locks, caches or caps), behind the
// /github-status command and the RPC method the TUI view uses.
import type { Plugin } from "@opencode/plugin"
import type { Options } from "./config.js"
import { GitHubPluginError } from "./errors.js"
import { defaultRules, unguardedAgents } from "./permissions.js"
import { GithubRpc, NOTHING_TO_DO, SERVER_NAME, type Status, formatStatus } from "./rpc.js"

export const STATUS_COMMAND = "github-status"
const UNAVAILABLE = new GitHubPluginError("STATUS_UNAVAILABLE", "GitHub status is unavailable right now.", "Run /github-status again.").message

type StatusContext = {
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
  readonly integration: { readonly connection: Pick<Plugin.Context["integration"]["connection"], "active"> }
  readonly agent: Pick<Plugin.Context["agent"], "list">
}

export type StatusDeps = {
  readonly options: Pick<Options, "readOnly" | "toolsets" | "unknownTools">
  readonly hostVersion: string
  readonly hostWarning?: string
  /** From registerMcp: undefined until known, true while another server named github is used. */
  readonly conflict: () => boolean | undefined
  /** From registerAuth: set once the sign-in methods are attached to the server's integration. */
  readonly integrationID: () => string | undefined
  /** From registerToolFilter. */
  readonly tools: () => { readonly visible: number; readonly unknown: readonly string[] }
  /** The GitHub Enterprise Server host, where no MCP server is registered. */
  readonly enterprise?: string
}

export async function computeStatus(ctx: StatusContext, deps: StatusDeps): Promise<Status> {
  const [servers, agents] = await Promise.all([ctx.mcp.list(), ctx.agent.list()])
  let state: Status["state"]
  let account: string | undefined
  if (deps.enterprise) {
    // No MCP server: the sign-in on the plugin's own integration is the whole state.
    const integrationID = deps.integrationID()
    account = integrationID ? await accountOf(ctx, integrationID) : undefined
    state = account ? "connected" : "needs_auth"
  } else {
    const server = servers.data.find((item) => item.name === SERVER_NAME)
    state = stateOf(server?.status.status, deps.conflict(), deps.integrationID() !== undefined)
    account = server?.integrationID && state !== "conflict" ? await accountOf(ctx, server.integrationID) : undefined
  }
  const unguarded = unguardedAgents(agents.data)
  const tools = deps.tools()
  return {
    state,
    ...(account ? { account } : {}),
    readOnly: deps.options.readOnly,
    toolsets: [...deps.options.toolsets],
    tools: { visible: tools.visible, unknown: [...tools.unknown], mode: deps.options.unknownTools },
    unguardedAgents: unguarded,
    ...(unguarded.length > 0 ? { permissionsBlock: defaultRules() } : {}),
    host: { version: deps.hostVersion, ...(deps.hostWarning ? { warning: deps.hostWarning } : {}) },
    ...(deps.enterprise ? { enterprise: deps.enterprise } : {}),
    nextStep: deps.enterprise ? enterpriseStep(state) : nextStep(state),
  }
}

type ServerState = "connected" | "pending" | "disabled" | "failed" | "needs_auth"

function stateOf(server: ServerState | undefined, conflict: boolean | undefined, attached: boolean): Status["state"] {
  if (conflict === true) return "conflict"
  if (server === undefined) return conflict === undefined ? "pending" : "not_registered"
  // The sign-in methods attach about a second after OpenCode registers the server.
  if (server === "needs_auth" && !attached) return "pending"
  return server
}

async function accountOf(ctx: StatusContext, integrationID: string): Promise<string | undefined> {
  const connection = await ctx.integration.connection.active(integrationID).catch(() => undefined)
  return connection?.type === "credential" ? connection.label : undefined
}

function enterpriseStep(state: Status["state"]): string {
  return state === "connected" ? NOTHING_TO_DO : "Run /connect and choose GitHub Enterprise."
}

function nextStep(state: Status["state"]): string {
  switch (state) {
    case "connected":
      return NOTHING_TO_DO
    case "needs_auth":
      return "Run /connect and choose GitHub."
    case "pending":
      return "GitHub is still starting. Check again in a few seconds."
    case "failed":
      return "OpenCode could not reach GitHub's MCP server. Check your network connection, then reconnect github in /mcps."
    case "disabled":
      return "Turn the github server back on in /mcps."
    case "not_registered":
      return "Restart OpenCode. If GitHub is still missing, check that no other plugin removes the MCP server named github."
    case "conflict":
      return "Your OpenCode config or another plugin defines its own MCP server named github, so this plugin left it unchanged. Rename or remove that server to use this plugin's GitHub sign-in."
  }
}

type RegisterContext = StatusContext & {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly rpc: Pick<Plugin.Context["rpc"], "register">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
}

export async function registerStatus(ctx: RegisterContext, deps: StatusDeps): Promise<{ dispose(): Promise<void> }> {
  const compute = () => computeStatus(ctx, deps)
  const registrations: Array<{ dispose(): Promise<void> }> = []
  try {
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: STATUS_COMMAND,
          description: "Show whether GitHub is connected and what to do next",
          execute: async ({ sessionID, delivery }) => {
            const text = await compute().then(formatStatus, () => UNAVAILABLE)
            await ctx.session.synthetic({ sessionID, delivery, text, description: "GitHub status", resume: false })
          },
        })
      }),
    )
    registrations.push(
      await ctx.rpc.register(GithubRpc, {
        status: async (_input, { error }) => {
          try {
            return await compute()
          } catch {
            return error("unavailable", UNAVAILABLE, { reason: "OpenCode did not report the GitHub server's state." })
          }
        },
      }),
    )
  } catch (cause) {
    await disposeAll(registrations)
    throw cause
  }
  return { dispose: () => disposeAll(registrations) }
}

async function disposeAll(registrations: Array<{ dispose(): Promise<void> }>): Promise<void> {
  for (const registration of registrations.splice(0).reverse()) await registration.dispose()
}
