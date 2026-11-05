// The status contract shared by the server part, the /github-status command and the TUI
// view. Portable and small: it imports only the RPC definition helper, and the contract is
// plain JSON Schema, so the TUI bundle carries no zod. The TypeScript type is written out
// by hand, and isStatus checks a value against the same rules the schema states.
import { Rpc } from "@opencode/plugin/rpc"

/** The MCP server name; GitHub's tools are named `github_<tool>`. */
export const SERVER_NAME = "github"

/**
 * The S13 machine names of the shared status labels. GitHub never reports host_untested: outside
 * the supported range the plugin does not load unless allowUntestedHost is set, and then it works.
 */
export const STATES = ["connected", "sign_in_required", "connecting", "failed", "disabled", "not_configured", "conflict"] as const
const EFFECTS = ["allow", "ask", "deny"] as const
const UNKNOWN_TOOL_MODES = ["ask", "hide"] as const

export type Rule = { readonly action: string; readonly resource: string; readonly effect: (typeof EFFECTS)[number] }
export type SkillPath = { readonly id: string; readonly path: string }

/** In the order the dialog and /github-status show it. version, host, state, unguardedAgents and nextStep are the shared fields. */
export type Status = {
  /** The plugin's version. */
  readonly version: string
  readonly state: (typeof STATES)[number]
  /** The GitHub login of the active sign-in. */
  readonly account?: string
  readonly readOnly: boolean
  readonly toolsets: readonly string[]
  /** The github server's tools that agents can use, the ones this plugin does not know yet, and whether those ask first or are hidden. */
  readonly tools: { readonly visible: number; readonly unknown: readonly string[]; readonly mode: (typeof UNKNOWN_TOOL_MODES)[number] }
  /** Agents whose own rules let GitHub tools run without asking, because they lack the default rules (defined only in the user's config). */
  readonly unguardedAgents: readonly string[]
  /** github_api rule resources with an owner, repo or other name not in lower case: they never match. Present only when there are any. */
  readonly unmatchedRules?: readonly string[]
  /** The plugin's skills that OpenCode loads from another file with the same id, and that file. Present only when there are any. */
  readonly shadowedSkills?: readonly SkillPath[]
  /** The default rules to add to those agents; present only when there are any. */
  readonly permissionsBlock?: readonly Rule[]
  /** The OpenCode release, the supported range, and whether this release is a tested one. */
  readonly host: { readonly version: string; readonly range: string; readonly tested: boolean }
  /** Present when OpenCode is outside the supported range and allowUntestedHost let the plugin load. */
  readonly hostWarning?: string
  /** The GitHub Enterprise Server host. GitHub's hosted MCP server does not serve it, so only github_api works there. */
  readonly enterprise?: string
  readonly nextStep: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const object = (properties: Record<string, object>, required: readonly string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const rule = object({ action: text, resource: text, effect: { enum: EFFECTS } }, ["action", "resource", "effect"])
const skillPath = object({ id: text, path: text }, ["id", "path"])

export const STATUS_SCHEMA = object(
  {
    version: text,
    state: { enum: STATES },
    account: text,
    readOnly: { type: "boolean" },
    toolsets: texts,
    tools: object({ visible: { type: "integer", minimum: 0 }, unknown: texts, mode: { enum: UNKNOWN_TOOL_MODES } }, ["visible", "unknown", "mode"]),
    unguardedAgents: texts,
    unmatchedRules: texts,
    shadowedSkills: { type: "array", items: skillPath },
    permissionsBlock: { type: "array", items: rule },
    host: object({ version: text, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    hostWarning: text,
    enterprise: text,
    nextStep: text,
  },
  ["version", "state", "readOnly", "toolsets", "tools", "unguardedAgents", "host", "nextStep"],
)

export const GithubRpc = Rpc.define({
  id: "github.platform",
  methods: {
    status: {
      input: object({}, []),
      output: STATUS_SCHEMA,
      errors: { unavailable: object({ reason: text }, ["reason"]) },
    },
  },
  events: {},
})

type Record_ = Record<string, unknown>
const isRecord = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === "string"
const isTexts = (value: unknown) => Array.isArray(value) && value.every(isText)
const only = (value: Record_, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const isSkillPath = (value: unknown) => isRecord(value) && only(value, ["id", "path"]) && isText(value.id) && isText(value.path)
const isRule = (value: unknown) =>
  isRecord(value) && only(value, ["action", "resource", "effect"]) && isText(value.action) && isText(value.resource) && (EFFECTS as readonly unknown[]).includes(value.effect)

/** JSON Schema outputs reach clients unchecked, so readers check a status against the schema's rules. */
export function isStatus(value: unknown): value is Status {
  if (!isRecord(value) || !only(value, Object.keys(STATUS_SCHEMA.properties))) return false
  const { tools, host } = value
  return (
    isText(value.version) &&
    (STATES as readonly unknown[]).includes(value.state) &&
    optional(value.account, isText) &&
    typeof value.readOnly === "boolean" &&
    isTexts(value.toolsets) &&
    isRecord(tools) &&
    only(tools, ["visible", "unknown", "mode"]) &&
    Number.isInteger(tools.visible) &&
    (tools.visible as number) >= 0 &&
    isTexts(tools.unknown) &&
    (UNKNOWN_TOOL_MODES as readonly unknown[]).includes(tools.mode) &&
    isTexts(value.unguardedAgents) &&
    optional(value.unmatchedRules, isTexts) &&
    optional(value.shadowedSkills, (skills) => Array.isArray(skills) && skills.every(isSkillPath)) &&
    optional(value.permissionsBlock, (block) => Array.isArray(block) && block.every(isRule)) &&
    isRecord(host) &&
    only(host, ["version", "range", "tested"]) &&
    isText(host.version) &&
    isText(host.range) &&
    typeof host.tested === "boolean" &&
    optional(value.hostWarning, isText) &&
    optional(value.enterprise, isText) &&
    isText(value.nextStep)
  )
}

/** The connection label for each state, shared by every plugin's status. */
export const STATE_LABELS: Record<Status["state"], string> = {
  connected: "connected",
  sign_in_required: "sign-in required",
  connecting: "connecting",
  failed: "failed",
  disabled: "disabled",
  not_configured: "not configured",
  conflict: "conflict",
}

export const NOTHING_TO_DO = "Nothing to do."

/** The next step for agents without the default rules: one fixed sentence across the plugins, with no names. */
export const AGENT_STEP =
  "Put the default rules shown by /github-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for GitHub tools."

/** The value of a row that has nothing to show. */
export const NONE = "none"

export type StatusRow = { readonly label: string; readonly value: string }

/** The rules as JSON, one rule per line, ready to paste into an agent's "permissions". */
export function formatRules(rules: readonly Rule[]): string {
  return `[\n${rules.map((rule) => `  ${JSON.stringify(rule)}`).join(",\n")}\n]`
}

/** The tools line; on GitHub Enterprise Server there are no MCP tools, only github_api. */
export function describeTools(status: Pick<Status, "tools" | "enterprise">): string {
  if (status.enterprise) return "github_api only. GitHub's hosted MCP tools do not support GitHub Enterprise Server; run github-mcp-server yourself for them."
  const tools = status.tools
  const visible = `${tools.visible} available`
  if (tools.unknown.length === 0) return visible
  const handling = tools.mode === "hide" ? "hidden" : "they ask first"
  return `${visible}, ${tools.unknown.length} unknown (${handling}): ${tools.unknown.join(", ")}`
}

export function describeHost(status: Pick<Status, "host" | "hostWarning">): string {
  const { host } = status
  if (host.tested) return `${host.version} (tested)`
  if (status.hostWarning) return `${host.version} (untested: ${status.hostWarning})`
  return `${host.version} (untested; supported range ${host.range})`
}

/** The status as labelled rows, in the order the dialog and /github-status show them. */
export function statusRows(status: Status): StatusRow[] {
  return [
    { label: "Connection", value: STATE_LABELS[status.state] },
    { label: "Account", value: status.account ?? NONE },
    { label: "Access", value: status.readOnly ? "read-only" : "reads and writes (writes ask first)" },
    ...(status.enterprise ? [] : [{ label: "Toolsets", value: status.toolsets.join(", ") }]),
    { label: "Host", value: status.enterprise ? `${status.enterprise} (GitHub Enterprise Server)` : "github.com" },
    ...(status.unmatchedRules?.length ? [{ label: "Rules that never match", value: status.unmatchedRules.join("; ") }] : []),
    ...(status.shadowedSkills?.length ? [{ label: "Skills", value: status.shadowedSkills.map((skill) => `${skill.id} replaced by ${skill.path}`).join("; ") }] : []),
    { label: "Tools", value: describeTools(status) },
    { label: "Agents without default rules", value: status.unguardedAgents.length > 0 ? status.unguardedAgents.join(", ") : NONE },
    { label: "OpenCode", value: describeHost(status) },
    { label: "Next step", value: status.nextStep },
  ]
}

/** The title line of /github-status and the dialog. */
export const STATUS_TITLE = "GitHub status"

export function formatStatus(status: Status): string {
  const lines: string[] = [STATUS_TITLE]
  for (const row of statusRows(status)) {
    lines.push(`${row.label}: ${row.value}`)
    if (row.label === "Agents without default rules" && status.unguardedAgents.length > 0) lines.push(formatRules(status.permissionsBlock ?? []))
  }
  return lines.join("\n")
}
