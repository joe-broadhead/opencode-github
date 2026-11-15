/**
 * GitHub's part of the tools RPC (`github.platform.tools`): the plugin value and the method table that the source
 * contract's `tools-rpc` module takes. The module (`@we-the-rebel-alliance/source-contract/tools-rpc`, bundled into
 * `dist/index.js`) is the transport every plugin of the family shares:
 *
 *   POST /api/rpc/github.platform.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * A script runs as a session and the agent it names; the rule for the method's permission action is resolved before
 * dispatch, and only `allow` runs. An MCP method then runs through OpenCode's own executor, which checks
 * `github_<tool>` against the same rules and sends OpenCode's own credential; `api`, `events_list` and `probe` run
 * their own specs. `docs/scripting.md` describes the calls.
 */
import type { Failure, McpResult, MethodSpec, NextSteps, ShapeCall, ToolsRpcPlugin } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { toolsRpcId } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { DEFAULT_TOOLSETS } from "./config.js"
import { GitHubPluginError } from "./errors.js"
import { KNOWN_TOOLS, allReadTools, allWriteTools } from "./tools.js"

/** Toolsets with read methods that are off unless the toolsets option names them (QA LIVE-9). */
const OFF_BY_DEFAULT = Object.entries(KNOWN_TOOLS)
  .filter(([toolset, tools]) => !(DEFAULT_TOOLSETS as readonly string[]).includes(toolset) && tools.read.length > 0)
  .map(([toolset]) => toolset)

/** The plugin's id. The RPC id is `<PLUGIN_ID>.tools`. */
export const PLUGIN_ID = "github.platform"

/** The RPC's id: the plugin's id and `.tools`. Scripts call it by name, so it never changes. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/**
 * Every known GitHub tool, by its upstream name and with its class: the 61 catalogued reads (without the hidden
 * ui_get) as `read`, and the 37 catalogued writes as `write`. The class is what `describe` reports and what an approval
 * shows; the rules, not the class, decide whether a call runs. A toolset that is off leaves its methods unavailable,
 * and a tool GitHub adds later is not a method. The plugin's own `api`, `events_list` and `probe` are `kind: "plugin"`
 * methods, built in setup.
 */
export const METHODS: readonly MethodSpec[] = [
  ...allReadTools().map((name): MethodSpec => ({ kind: "mcp", name, class: "read" })),
  ...allWriteTools().map((name): MethodSpec => ({ kind: "mcp", name, class: "write" })),
]

/** What the model path's `execute.before` hooks do to an MCP call's arguments, which the executor skips. GitHub has none. */
export function shapeInput(_method: string, input: unknown, _call: ShapeCall): unknown {
  return input
}

/** What the model path's `execute.after` hooks do to a result, which the executor skips. GitHub has no such hook. */
export function shapeResult(_method: string, result: McpResult, _call: ShapeCall): McpResult {
  return result
}

/** The next step for each code. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the tool to the session's agent or to the session, or use a session whose agent allows it.",
  SERVER_CONFLICT: "Rename or remove the MCP server named github that your config or another plugin defines, so that this plugin manages GitHub's server.",
  AUTH_REQUIRED: "Run /connect and choose GitHub.",
  CONNECTING: "Wait a few seconds, then call the method again.",
  CONNECTION_FAILED: "Run /github-status and follow its next step.",
  DISABLED: "Turn the github server back on in /mcps.",
  NOT_REGISTERED: "Run /github-status and follow its next step; with the host option (GitHub Enterprise Server) there is no MCP server, so call the api method instead.",
  TOOL_UNAVAILABLE: `Add the method's toolset to the plugin's toolsets option and run opencode reload (off by default: ${OFF_BY_DEFAULT.join(", ")}); describe's detail names the method's toolset, or the feature flag that hides it.`,
  UPSTREAM_ERROR: "Check the input against the method's schema from describe, and run /github-status if it keeps failing.",
  CANCELLED: "Call the method again if you still need the result.",
}

/** The plugin's own errors, thrown by the api, events_list and probe methods' specs, as a code, what happened and the next step. */
export function pluginError(error: unknown): Failure | undefined {
  return error instanceof GitHubPluginError ? { code: error.code, what: error.detail, next: error.nextStep } : undefined
}

/** GitHub's plugin value for the tools RPC. */
export const PLUGIN: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, shapeInput, shapeResult, pluginError }
