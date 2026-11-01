// The status contract shared by the server part, the /github-status command and the TUI
// view. Portable and small: it imports only the RPC definition helper, and the contract is
// plain JSON Schema, so the TUI bundle carries no zod. The TypeScript type is written out
// by hand, and isStatus checks a value against the same rules the schema states.
import { Rpc } from "@opencode/plugin/rpc"

/** The MCP server name; GitHub's tools are named `github_<tool>`. */
export const SERVER_NAME = "github"

export const STATES = ["connected", "needs_auth", "pending", "failed", "disabled", "not_registered", "conflict"] as const
const EFFECTS = ["allow", "ask", "deny"] as const
const UNKNOWN_TOOL_MODES = ["ask", "hide"] as const

export type Rule = { readonly action: string; readonly resource: string; readonly effect: (typeof EFFECTS)[number] }

/** In the order the dialog and /github-status show it. */
export type Status = {
  readonly state: (typeof STATES)[number]
  /** The GitHub login of the active sign-in. */
  readonly account?: string
  readonly readOnly: boolean
  readonly toolsets: readonly string[]
  /** The github server's tools that agents can use, the ones this plugin does not know yet, and whether those ask first or are hidden. */
  readonly tools: { readonly visible: number; readonly unknown: readonly string[]; readonly mode: (typeof UNKNOWN_TOOL_MODES)[number] }
  /** Agents that run GitHub tools without the default rules (defined only in the user's config). */
  readonly unguardedAgents: readonly string[]
  /** The default rules to add to those agents; present only when there are any. */
  readonly permissionsBlock?: readonly Rule[]
  /** The OpenCode release, and a warning when it is outside the tested range. */
  readonly host: { readonly version: string; readonly warning?: string }
  /** The GitHub Enterprise Server host. GitHub's hosted MCP server does not serve it, so only github_api works there. */
  readonly enterprise?: string
  readonly nextStep: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const object = (properties: Record<string, object>, required: readonly string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const

const rule = object({ action: text, resource: text, effect: { enum: EFFECTS } }, ["action", "resource", "effect"])

export const STATUS_SCHEMA = object(
  {
    state: { enum: STATES },
    account: text,
    readOnly: { type: "boolean" },
    toolsets: texts,
    tools: object({ visible: { type: "integer", minimum: 0 }, unknown: texts, mode: { enum: UNKNOWN_TOOL_MODES } }, ["visible", "unknown", "mode"]),
    unguardedAgents: texts,
    permissionsBlock: { type: "array", items: rule },
    host: object({ version: text, warning: text }, ["version"]),
    enterprise: text,
    nextStep: text,
  },
  ["state", "readOnly", "toolsets", "tools", "unguardedAgents", "host", "nextStep"],
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
const isRule = (value: unknown) =>
  isRecord(value) && only(value, ["action", "resource", "effect"]) && isText(value.action) && isText(value.resource) && (EFFECTS as readonly unknown[]).includes(value.effect)

/** JSON Schema outputs reach clients unchecked, so readers check a status against the schema's rules. */
export function isStatus(value: unknown): value is Status {
  if (!isRecord(value) || !only(value, Object.keys(STATUS_SCHEMA.properties))) return false
  const { tools, host } = value
  return (
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
    optional(value.permissionsBlock, (block) => Array.isArray(block) && block.every(isRule)) &&
    isRecord(host) &&
    only(host, ["version", "warning"]) &&
    isText(host.version) &&
    optional(host.warning, isText) &&
    optional(value.enterprise, isText) &&
    isText(value.nextStep)
  )
}

/** The connection label for each state, shared by every plugin's status. */
export const STATE_LABELS: Record<Status["state"], string> = {
  connected: "connected",
  needs_auth: "sign-in required",
  pending: "connecting",
  failed: "failed",
  disabled: "disabled",
  not_registered: "not configured",
  conflict: "conflict",
}

export const NOTHING_TO_DO = "Nothing to do."

/** The fix for agents without the default rules, after their names. */
export const AGENT_FIX =
  'These agents run GitHub tools, including writes, without asking. Put the rules below first in each one\'s own "permissions" list, in opencode.json or in its Markdown file, followed by your top-level rules for github_ tools.'

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

export function describeHost(host: Status["host"]): string {
  return host.warning ? `${host.version} (untested: ${host.warning})` : `${host.version} (tested)`
}

/** The status as labelled rows, in the order the dialog and /github-status show them. */
export function statusRows(status: Status): StatusRow[] {
  return [
    { label: "Connection", value: STATE_LABELS[status.state] },
    ...(status.account ? [{ label: "Account", value: status.account }] : []),
    { label: "Access", value: status.readOnly ? "read-only" : "reads and writes (writes ask first)" },
    ...(status.enterprise ? [] : [{ label: "Toolsets", value: status.toolsets.join(", ") }]),
    { label: "Host", value: status.enterprise ? `${status.enterprise} (GitHub Enterprise Server)` : "github.com" },
    { label: "Tools", value: describeTools(status) },
    ...(status.unguardedAgents.length > 0 ? [{ label: "Agents without default rules", value: status.unguardedAgents.join(", ") }] : []),
    { label: "OpenCode", value: describeHost(status.host) },
    { label: "Next step", value: status.nextStep },
  ]
}

export function formatStatus(status: Status): string {
  const lines: string[] = []
  for (const row of statusRows(status)) {
    lines.push(`${row.label}: ${row.value}`)
    if (row.label === "Agents without default rules") lines.push(AGENT_FIX, formatRules(status.permissionsBlock ?? []))
  }
  return lines.join("\n")
}
