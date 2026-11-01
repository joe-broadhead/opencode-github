// Default permission rules for GitHub's tools, inserted into each agent right after its
// base `* * allow` rule. OpenCode applies the last matching rule, so the agent's own
// stricter rules (Plan, Explore), the user's `permissions` rules and saved "Always allow"
// approvals all still win. Writes and unknown tools ask; known reads run without a prompt.
import type { Plugin } from "@opencode/plugin"
import { TOOL_PREFIX, allReadTools } from "./tools.js"

export type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }

export function defaultRules(): Rule[] {
  return [
    { action: `${TOOL_PREFIX}*`, resource: "*", effect: "ask" },
    ...allReadTools().map((name): Rule => ({ action: `${TOOL_PREFIX}${name}`, resource: "*", effect: "allow" })),
  ]
}

const isBaseAllow = (rule: Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"
const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect

/**
 * Inserts `defaults` right after the first base allow rule, unless the block is already
 * somewhere after it (other plugins insert at the same place). Agents without one are unchanged.
 */
export function insertDefaults<R extends Rule>(rules: readonly R[], defaults: readonly R[]): R[] {
  const base = rules.findIndex(isBaseAllow)
  if (base === -1 || hasBlockAfter(rules, base, defaults)) return [...rules]
  return [...rules.slice(0, base + 1), ...defaults.map((rule) => ({ ...rule })), ...rules.slice(base + 1)]
}

/**
 * Agents with a base allow rule but no default block after it. OpenCode creates agents
 * defined only in the user's config after plugins run, so they never receive the block.
 * An agent fixed by hand carries the block in its own rules, after the top-level ones.
 */
export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]): string[] {
  const defaults = defaultRules()
  return agents
    .filter((agent) => {
      const base = agent.permissions.findIndex(isBaseAllow)
      return base !== -1 && !hasBlockAfter(agent.permissions, base, defaults)
    })
    .map((agent) => agent.id)
}

function hasBlockAfter(rules: readonly Rule[], base: number, defaults: readonly Rule[]): boolean {
  for (let start = base + 1; start + defaults.length <= rules.length; start++) {
    if (hasDefaultsAt(rules, start, defaults)) return true
  }
  return false
}

function hasDefaultsAt(rules: readonly Rule[], start: number, defaults: readonly Rule[]): boolean {
  return defaults.every((rule, index) => {
    const candidate = rules[start + index]
    return candidate !== undefined && same(candidate, rule)
  })
}

type AgentContext = { readonly agent: Pick<Plugin.Context["agent"], "transform"> }

export async function registerPermissionDefaults(ctx: AgentContext): Promise<{ dispose(): Promise<void> }> {
  const defaults = defaultRules()
  return ctx.agent.transform((editor) => {
    for (const agent of editor.list()) {
      editor.update(agent.id, (item) => {
        item.permissions = insertDefaults(item.permissions, defaults)
      })
    }
  })
}
