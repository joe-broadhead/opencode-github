import { describe, expect, it } from "vitest"
import { type Rule, defaultRules, insertDefaults, registerPermissionDefaults, unguardedAgents } from "../../src/permissions.js"
import { allReadTools } from "../../src/tools.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const ENV: Rule = { action: "read", resource: "*.env", effect: "ask" }

// OpenCode's evaluation: `*` matches anything, the last matching rule wins, no match asks.
function evaluate(rules: readonly Rule[], action: string): Rule["effect"] {
  const matches = (pattern: string, value: string) =>
    new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value)
  let effect: Rule["effect"] = "ask"
  for (const rule of rules) if (matches(rule.action, action) && matches(rule.resource, "*")) effect = rule.effect
  return effect
}

describe("defaultRules", () => {
  it("asks for every GitHub tool, then allows the known reads", () => {
    const rules = defaultRules()
    expect(rules[0]).toEqual({ action: "github_*", resource: "*", effect: "ask" })
    expect(rules.slice(1)).toEqual(allReadTools().map((name) => ({ action: `github_${name}`, resource: "*", effect: "allow" })))
    expect(rules).toHaveLength(allReadTools().length + 1)
  })

  it("lets reads run, and makes writes and unknown tools ask", () => {
    const rules = [BASE, ...defaultRules()]
    expect(evaluate(rules, "github_get_me")).toBe("allow")
    expect(evaluate(rules, "github_pull_request_read")).toBe("allow")
    expect(evaluate(rules, "github_create_pull_request")).toBe("ask")
    expect(evaluate(rules, "github_merge_pull_request")).toBe("ask")
    expect(evaluate(rules, "github_brand_new_tool")).toBe("ask")
    expect(evaluate(rules, "bash")).toBe("allow")
  })
})

describe("insertDefaults", () => {
  const defaults = defaultRules()

  it("inserts the block directly after the base allow rule", () => {
    const rules = insertDefaults([BASE, ENV], defaults)
    expect(rules).toEqual([BASE, ...defaults, ENV])
  })

  it("uses the first base allow rule", () => {
    const later: Rule = { action: "edit", resource: "*", effect: "deny" }
    expect(insertDefaults([ENV, BASE, later, BASE], defaults)).toEqual([ENV, BASE, ...defaults, later, BASE])
  })

  it("leaves agents without a base allow rule unchanged", () => {
    const rules: Rule[] = [{ action: "*", resource: "*", effect: "deny" }, ENV]
    expect(insertDefaults(rules, defaults)).toEqual(rules)
    expect(insertDefaults([], defaults)).toEqual([])
  })

  it("is idempotent", () => {
    const once = insertDefaults([BASE, ENV], defaults)
    expect(insertDefaults(once, defaults)).toEqual(once)
  })

  it("does not add the block again when another plugin inserted its rules in front of it", () => {
    const other: Rule = { action: "linear_*", resource: "*", effect: "ask" }
    const rules = [BASE, other, ...defaults, ENV]
    expect(insertDefaults(rules, defaults)).toEqual(rules)
  })

  it("does not mutate its input or share rule objects", () => {
    const rules = [BASE, ENV]
    const result = insertDefaults(rules, defaults)
    expect(rules).toEqual([BASE, ENV])
    expect(result[1]).not.toBe(defaults[0])
  })

  it("keeps a stricter agent strict: Explore-style deny and Plan-style rules still win", () => {
    const explore = insertDefaults([BASE, { action: "*", resource: "*", effect: "deny" }], defaults)
    expect(evaluate(explore, "github_get_me")).toBe("deny")
    expect(evaluate(explore, "github_create_pull_request")).toBe("deny")

    const plan = insertDefaults([BASE, ENV, { action: "github_*", resource: "*", effect: "deny" }], defaults)
    expect(evaluate(plan, "github_get_me")).toBe("deny")
  })

  it("lets the user's later rules win in both directions", () => {
    const user: Rule[] = [
      { action: "github_create_issue", resource: "*", effect: "allow" },
      { action: "github_merge_pull_request", resource: "*", effect: "deny" },
      { action: "github_get_me", resource: "*", effect: "deny" },
    ]
    const rules = [...insertDefaults([BASE, ENV], defaults), ...user]
    expect(evaluate(rules, "github_create_issue")).toBe("allow")
    expect(evaluate(rules, "github_merge_pull_request")).toBe("deny")
    expect(evaluate(rules, "github_get_me")).toBe("deny")
    expect(evaluate(rules, "github_issue_write")).toBe("ask")
  })
})

describe("unguardedAgents", () => {
  // QA LIVE-1: "custom" already asks for every GitHub tool, so it needs no fix.
  it("names agents without the default block whose rules would run an unknown GitHub tool without asking", () => {
    const defaults = defaultRules()
    const agents = [
      { id: "build", permissions: insertDefaults([BASE, ENV], defaults) },
      { id: "reviewer", permissions: [BASE, ENV] },
      { id: "title", permissions: [{ action: "*", resource: "*", effect: "deny" } as Rule] },
      { id: "custom", permissions: [BASE, { action: "github_*", resource: "*", effect: "ask" } as Rule] },
    ]
    expect(unguardedAgents(agents)).toEqual(["reviewer"])
  })

  it("accepts the per-agent fix: the block in the agent's own rules, after the top-level ones", () => {
    const topLevel: Rule = { action: "github_merge_pull_request", resource: "*", effect: "deny" }
    const fixed = [BASE, ENV, topLevel, ...defaultRules(), topLevel]
    expect(unguardedAgents([{ id: "reviewer", permissions: fixed }])).toEqual([])
    expect(unguardedAgents([{ id: "reviewer", permissions: [BASE, ENV, ...defaultRules().slice(1)] }])).toEqual(["reviewer"])
  })
})

describe("registerPermissionDefaults", () => {
  it("updates every agent through one transform, on every replay", async () => {
    type Ctx = Parameters<typeof registerPermissionDefaults>[0]
    type Editor = Parameters<Parameters<Ctx["agent"]["transform"]>[0]>[0]
    const transforms: Array<(editor: Editor) => void> = []
    const ctx: Ctx = {
      agent: {
        transform: async (callback) => {
          transforms.push(callback)
          return { dispose: async () => void transforms.splice(transforms.indexOf(callback), 1) }
        },
      },
    }
    const build = () => {
      const agents = new Map([
        ["build", { id: "build", permissions: [BASE, ENV] }],
        ["explore", { id: "explore", permissions: [BASE, { action: "*", resource: "*", effect: "deny" } as Rule] }],
        ["locked", { id: "locked", permissions: [{ action: "*", resource: "*", effect: "deny" } as Rule] }],
      ])
      const editor = {
        list: () => [...agents.values()],
        update: (id: string, update: (agent: { permissions: Rule[] }) => void) => update(agents.get(id)!),
      } as unknown as Editor
      for (const transform of transforms) transform(editor)
      return Object.fromEntries([...agents].map(([id, agent]) => [id, agent.permissions]))
    }

    const registration = await registerPermissionDefaults(ctx)
    const defaults = defaultRules()
    const first = build()
    expect(first.build).toEqual([BASE, ...defaults, ENV])
    expect(first.explore).toEqual([BASE, ...defaults, { action: "*", resource: "*", effect: "deny" }])
    expect(first.locked).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    expect(build()).toEqual(first)
    await registration.dispose()
    expect(build().build).toEqual([BASE, ENV])
  })
})
