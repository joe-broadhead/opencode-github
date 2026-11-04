import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { defaultRules } from "../../src/permissions.js"
import { GithubRpc, STATES, STATUS_SCHEMA, type Status, formatRules, formatStatus, isStatus } from "../../src/rpc.js"
import { jargonIn } from "./jargon.js"

const status = (overrides: Partial<Status> = {}): Status => ({
  version: "0.0.2",
  state: "sign_in_required",
  readOnly: true,
  toolsets: ["context", "repos", "issues", "pull_requests"],
  tools: { visible: 26, unknown: [], mode: "ask" },
  unguardedAgents: [],
  host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
  nextStep: "Run /connect and choose GitHub.",
  ...overrides,
})

describe("GithubRpc", () => {
  it("has one status method and no events", () => {
    expect(GithubRpc.id).toBe("github.platform")
    expect(Object.keys(GithubRpc.methods)).toEqual(["status"])
    expect(GithubRpc.events).toEqual({})
    expect(Object.keys(GithubRpc.methods.status.errors)).toEqual(["unavailable"])
  })

  it("takes an empty object as input, in plain JSON Schema", () => {
    expect(GithubRpc.methods.status.input).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false })
  })

  it("imports only the RPC helper, so the TUI bundle carries no zod", () => {
    const source = readFileSync(new URL("../../src/rpc.ts", import.meta.url), "utf8")
    const imports = [...source.matchAll(/^import .* from "([^"]+)"$/gm)].map((match) => match[1])
    expect(imports).toEqual(["@opencode/plugin/rpc"])
  })
})

describe("isStatus and the JSON Schema", () => {
  it.each(STATES)("accepts %s", (state) => {
    expect(isStatus(status({ state }))).toBe(true)
  })

  it("accepts the optional fields and rejects unknown, missing or wrong ones", () => {
    expect(
      isStatus(status({ account: "octocat", host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false }, hostWarning: "w", unguardedAgents: ["a"], permissionsBlock: defaultRules(), enterprise: "ghe.example.com" })),
    ).toBe(true)
    expect(isStatus({ ...status(), profileFingerprint: "x" })).toBe(false)
    expect(isStatus(status({ state: "busy" as Status["state"] }))).toBe(false)
    const { nextStep: _nextStep, ...missing } = status()
    expect(isStatus(missing)).toBe(false)
    expect(isStatus(status({ tools: { visible: -1, unknown: [], mode: "ask" } }))).toBe(false)
    expect(isStatus(status({ permissionsBlock: [{ action: "x", resource: "*", effect: "maybe" as "ask" }] }))).toBe(false)
    expect(isStatus(status({ host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true, extra: 1 } as unknown as Status["host"] }))).toBe(false)
    expect(isStatus(status({ host: { version: "2.2.3", range: ">=2.2.3 <2.3.0" } as unknown as Status["host"] }))).toBe(false)
    const { version: _version, ...unversioned } = status()
    expect(isStatus(unversioned)).toBe(false)
    expect(isStatus(null)).toBe(false)
  })

  it("states the same fields and required fields in its JSON Schema", () => {
    expect(Object.keys(STATUS_SCHEMA.properties).sort()).toEqual(
      ["account", "enterprise", "host", "hostWarning", "nextStep", "permissionsBlock", "readOnly", "state", "tools", "toolsets", "unguardedAgents", "version"],
    )
    expect([...STATUS_SCHEMA.required].sort()).toEqual(["host", "nextStep", "readOnly", "state", "tools", "toolsets", "unguardedAgents", "version"])
    expect(STATUS_SCHEMA.additionalProperties).toBe(false)
  })
})

describe("formatStatus", () => {
  it("shows the rows in the shared order, with one Next step line", () => {
    expect(formatStatus(status({ state: "connected", account: "octocat", nextStep: "Nothing to do." }))).toBe(
      [
        "GitHub status",
        "Connection: connected",
        "Account: octocat",
        "Access: read-only",
        "Toolsets: context, repos, issues, pull_requests",
        "Host: github.com",
        "Tools: 26 available",
        "Agents without default rules: none",
        "OpenCode: 2.2.3 (tested)",
        "Next step: Nothing to do.",
      ].join("\n"),
    )
  })

  // QA INSTALL-10: every shared row is printed, with none where it is empty.
  it("keeps the Account and Agents rows when they are empty", () => {
    const text = formatStatus(status())
    expect(text).toContain("\nAccount: none\n")
    expect(text).toContain("\nAgents without default rules: none\nOpenCode:")
    expect(text).not.toContain("Put the rules below")
  })

  it.each([
    ["sign_in_required", "sign-in required"],
    ["connecting", "connecting"],
    ["failed", "failed"],
    ["disabled", "disabled"],
    ["not_configured", "not configured"],
    ["conflict", "conflict"],
  ] as const)("labels %s as %s", (state, label) => {
    expect(formatStatus(status({ state }))).toContain(`Connection: ${label}\n`)
  })

  it("names unknown tools, writes and an untested OpenCode when they apply", () => {
    const range = ">=2.2.3 <2.3.0"
    const text = formatStatus(status({ readOnly: false, tools: { visible: 1, unknown: ["github_a", "github_b"], mode: "hide" }, host: { version: "2.3.0", range, tested: false }, hostWarning: "Untested OpenCode." }))
    expect(text).toContain("Access: reads and writes (writes ask first)")
    expect(text).toContain("Tools: 1 available, 2 unknown (hidden): github_a, github_b")
    expect(text).toContain("OpenCode: 2.3.0 (untested: Untested OpenCode.)")
    // QA INSTALL-4: a release in the range that is not tested says so, with the range.
    expect(formatStatus(status({ host: { version: "2.2.6", range, tested: false } }))).toContain("OpenCode: 2.2.6 (untested; supported range >=2.2.3 <2.3.0)")
    expect(formatStatus(status({ host: { version: "2.2.5", range, tested: true } }))).toContain("OpenCode: 2.2.5 (tested)")
    expect(formatStatus(status({ tools: { visible: 3, unknown: ["github_a"], mode: "ask" } }))).toContain("(they ask first): github_a")
  })

  it("names agents without the default rules, and gives the fix with the block before OpenCode and Next step", () => {
    const text = formatStatus(status({ unguardedAgents: ["reviewer", "docs"], permissionsBlock: defaultRules() }))
    expect(text).toContain("Agents without default rules: reviewer, docs\n")
    expect(text).toContain(`Put the rules below first in each one's own "permissions" list`)
    expect(text).toContain("followed by your top-level rules for github_ tools.")
    expect(text).toContain(formatRules(defaultRules()))
    expect(text.indexOf(formatRules(defaultRules()))).toBeLessThan(text.indexOf("OpenCode:"))
    expect(text.match(/Next step:/g)).toHaveLength(1)
  })

  it("formats the rules as JSON, one rule per line", () => {
    const rules = defaultRules()
    const text = formatRules(rules)
    expect(JSON.parse(text)).toEqual(rules)
    expect(text.split("\n")).toHaveLength(rules.length + 2)
  })

  it.each(STATES)("uses plain language for %s", (state) => {
    expect(jargonIn(formatStatus(status({ state, unguardedAgents: ["reviewer"], permissionsBlock: defaultRules() })))).toEqual([])
  })
})
