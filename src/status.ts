// One status, computed fresh on every call (no locks, caches or caps), behind the
// /github-status command and the RPC method the TUI view uses.
import type { Plugin } from "@opencode/plugin"
import type { Options } from "./config.js"
import { GitHubPluginError } from "./errors.js"
import { HOST_RANGE, TESTED_HOSTS, isTestedHost } from "./host-version.js"
import { lowerResource, neverMatches } from "./api/names.js"
import { API_ACTION } from "./api/tool.js"
import { type Rule, defaultRules, matches, unguardedAgents } from "./permissions.js"
import { GithubRpc, NOTHING_TO_DO, SERVER_NAME, type Status, formatStatus } from "./rpc.js"
import { PLUGIN_VERSION } from "./version.js"

export const STATUS_COMMAND = "github-status"
const UNAVAILABLE = new GitHubPluginError("STATUS_UNAVAILABLE", "GitHub status is unavailable right now.", "Try again in a few seconds; if it persists, restart OpenCode.").message

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
    state = account ? "connected" : "sign_in_required"
  } else {
    const server = servers.data.find((item) => item.name === SERVER_NAME)
    state = stateOf(server?.status.status, deps.conflict(), deps.integrationID() !== undefined)
    account = server?.integrationID && state !== "conflict" ? await accountOf(ctx, server.integrationID) : undefined
  }
  const unguarded = unguardedAgents(agents.data)
  const unmatched = unmatchedRules(agents.data)
  const tools = deps.tools()
  const tested = isTestedHost(deps.hostVersion)
  return {
    version: PLUGIN_VERSION,
    state,
    ...(account ? { account } : {}),
    readOnly: deps.options.readOnly,
    toolsets: [...deps.options.toolsets],
    tools: { visible: tools.visible, unknown: [...tools.unknown], mode: deps.options.unknownTools },
    unguardedAgents: unguarded,
    ...(unmatched.length > 0 ? { unmatchedRules: unmatched } : {}),
    ...(unguarded.length > 0 ? { permissionsBlock: defaultRules() } : {}),
    host: { version: deps.hostVersion, range: HOST_RANGE, tested },
    ...(deps.hostWarning ? { hostWarning: deps.hostWarning } : {}),
    ...(deps.enterprise ? { enterprise: deps.enterprise } : {}),
    nextStep: (deps.enterprise ? enterpriseStep(state) : connectionStep(state)) ?? ruleStep(unmatched) ?? agentStep(unguarded) ?? hostStep(tested) ?? NOTHING_TO_DO,
  }
}

/**
 * github_api rule resources, in any agent's rules (which hold the top-level rules too), whose owner, repo or other
 * name is not in lower case. github_api checks those names in lower case, so such a rule never matches.
 */
function unmatchedRules(agents: readonly { readonly permissions: readonly Rule[] }[]): string[] {
  const found = agents.flatMap((agent) => agent.permissions.filter((rule) => matches(rule.action, API_ACTION) && neverMatches(rule.resource)).map((rule) => rule.resource))
  return [...new Set(found)]
}

function ruleStep(unmatched: readonly string[]): string | undefined {
  const first = unmatched[0]
  if (first === undefined) return undefined
  const more = unmatched.length > 1 ? ` (and ${unmatched.length - 1} more)` : ""
  return `Write the github_api rule "${first}"${more} with lower-case owner and repo names, as "${lowerResource(first)}": as written it never matches.`
}

/** Agent names in a next step: at most this many, then a count. */
const NAMED_AGENTS = 5

/** The fix for agents without the default rules, naming them (QA LIVE-2). */
function agentStep(unguarded: readonly string[]): string | undefined {
  if (unguarded.length === 0) return undefined
  const shown = unguarded.slice(0, NAMED_AGENTS)
  const rest = unguarded.length - shown.length
  const names = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]
  const where = unguarded.length === 1 ? "the agent's" : "each agent's"
  return `Add the default rules to ${names}: first in ${where} own permissions, followed by your top-level rules for github_ tools.`
}

function hostStep(tested: boolean): string | undefined {
  return tested ? undefined : `If GitHub misbehaves, use OpenCode ${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}, where it is tested.`
}

type ServerState = "connected" | "pending" | "disabled" | "failed" | "needs_auth"

function stateOf(server: ServerState | undefined, conflict: boolean | undefined, attached: boolean): Status["state"] {
  if (conflict === true) return "conflict"
  if (server === undefined) return conflict === undefined ? "connecting" : "not_configured"
  // The sign-in methods attach about a second after OpenCode registers the server.
  if (server === "pending" || (server === "needs_auth" && !attached)) return "connecting"
  return server === "needs_auth" ? "sign_in_required" : server
}

async function accountOf(ctx: StatusContext, integrationID: string): Promise<string | undefined> {
  const connection = await ctx.integration.connection.active(integrationID).catch(() => undefined)
  return connection?.type === "credential" ? connection.label : undefined
}

function enterpriseStep(state: Status["state"]): string | undefined {
  return state === "connected" ? undefined : "Run /connect and choose GitHub Enterprise."
}

/** The next step for the connection, or undefined when it needs nothing. */
function connectionStep(state: Status["state"]): string | undefined {
  switch (state) {
    case "connected":
      return undefined
    case "sign_in_required":
      return "Run /connect and choose GitHub."
    case "connecting":
      return "GitHub is still starting. Check again in a few seconds."
    case "failed":
      return "OpenCode could not reach GitHub's MCP server. Check your network connection, then reconnect github in /mcps."
    case "disabled":
      return "Turn the github server back on in /mcps."
    case "not_configured":
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
