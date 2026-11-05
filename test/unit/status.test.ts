import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/config.js"
import { type Rule, defaultRules, insertDefaults } from "../../src/permissions.js"
import { STATES, formatStatus, isStatus } from "../../src/rpc.js"
import { PLUGIN_VERSION } from "../../src/version.js"
import { STATUS_COMMAND, type StatusDeps, computeStatus, registerStatus } from "../../src/status.js"
import { jargonIn } from "./jargon.js"

type Ctx = Parameters<typeof registerStatus>[0]
type ServerStatus = "connected" | "pending" | "disabled" | "failed" | "needs_auth"

const ID = "mcp_0123456789abcdef"
const LOCATION = { directory: "/workspace" }
const BASE: Rule = { action: "*", resource: "*", effect: "allow" }

const OWN = "/pkg/skills/github-pr-review/SKILL.md"

function fakeCtx(
  input: { server?: ServerStatus; label?: string; agents?: Array<{ id: string; permissions: Rule[] }>; fail?: boolean; skills?: Array<{ id: string; path: string }> | "fail" } = {},
) {
  const calls = { list: 0, synthetic: [] as unknown[] }
  const registered: { commands: Array<Record<string, any>>; rpc?: { definition: any; handlers: any } } = { commands: [] }
  const ctx = {
    mcp: {
      list: async () => {
        calls.list++
        if (input.fail) throw new Error("internal detail that must not leak")
        const status = input.server
        return {
          location: LOCATION,
          data: status ? [{ name: "github", status: status === "failed" || status === "needs_auth" ? { status, error: "raw upstream text" } : { status }, integrationID: ID }] : [],
        }
      },
    },
    agent: {
      list: async () => ({ location: LOCATION, data: input.agents ?? [{ id: "build", permissions: insertDefaults([BASE], defaultRules()) }] }),
    },
    skill: {
      list: async () => {
        if (input.skills === "fail") throw new Error("no skills")
        return { location: LOCATION, data: input.skills ?? [{ id: "github-pr-review", path: OWN }] }
      },
    },
    integration: {
      connection: {
        active: async (integrationID: string) =>
          integrationID === ID && input.label ? { type: "credential" as const, id: "cred_1", label: input.label, method: "oauth" as const } : undefined,
      },
    },
    command: { transform: async (callback: (editor: any) => void) => (callback({ add: (command: any) => registered.commands.push(command) }), { dispose: async () => {} }) },
    rpc: {
      register: async (definition: any, handlers: any) => {
        registered.rpc = { definition, handlers }
        return { dispose: async () => {}, events: { emit: async () => {} } }
      },
    },
    session: {
      synthetic: async (value: unknown) => {
        calls.synthetic.push(value)
        return {} as never
      },
    },
  } as unknown as Ctx
  return { ctx, calls, registered }
}

function deps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    options: loadOptions({}),
    conflict: () => false,
    integrationID: () => ID,
    tools: () => ({ visible: 26, unknown: [] }),
    hostVersion: "2.2.3",
    skills: [{ id: "github-pr-review", path: OWN }],
    ...overrides,
  }
}

describe("computeStatus", () => {
  it.each([
    ["connected", { server: "connected", label: "octocat" }, {}, "Nothing to do."],
    ["sign_in_required", { server: "needs_auth" }, {}, "Run /connect and choose GitHub."],
    ["connecting", { server: "pending" }, {}, "GitHub is still starting. Check again in a few seconds."],
    ["failed", { server: "failed" }, {}, "OpenCode could not reach GitHub's MCP server. Check your network connection, then reconnect github in /mcps."],
    ["disabled", { server: "disabled" }, {}, "Turn the github server back on in /mcps."],
    ["not_configured", {}, {}, "Restart OpenCode. If GitHub is still missing, check that no other plugin removes the MCP server named github."],
    ["conflict", { server: "connected", label: "octocat" }, { conflict: () => true }, expect.stringContaining("Rename or remove that server")],
  ] as const)("reports %s with its next step", async (state, ctxInput, override, nextStep) => {
    const { ctx } = fakeCtx(ctxInput as Parameters<typeof fakeCtx>[0])
    const status = await computeStatus(ctx, deps(override as Partial<StatusDeps>))
    expect(status.state).toBe(state)
    expect(status.nextStep).toEqual(nextStep)
    expect(isStatus(status)).toBe(true)
  })

  it("names the signed-in account and never reads the account of a server it does not own", async () => {
    expect((await computeStatus(fakeCtx({ server: "connected", label: "octocat" }).ctx, deps())).account).toBe("octocat")
    expect((await computeStatus(fakeCtx({ server: "connected", label: "octocat" }).ctx, deps({ conflict: () => true }))).account).toBeUndefined()
  })

  it("is connecting until OpenCode has applied the MCP config", async () => {
    const status = await computeStatus(fakeCtx().ctx, deps({ conflict: () => undefined }))
    expect(status.state).toBe("connecting")
  })

  it("is connecting while the sign-in methods are not attached yet", async () => {
    const status = await computeStatus(fakeCtx({ server: "needs_auth" }).ctx, deps({ integrationID: () => undefined }))
    expect(status.state).toBe("connecting")
    const connected = await computeStatus(fakeCtx({ server: "connected" }).ctx, deps({ integrationID: () => undefined }))
    expect(connected.state).toBe("connected")
  })

  it("reports options, the tools, the unknown tool names and the host check", async () => {
    const status = await computeStatus(
      fakeCtx({ server: "connected" }).ctx,
      deps({
        options: loadOptions({ toolsets: ["repos"], readOnly: false, unknownTools: "hide" }),
        tools: () => ({ visible: 12, unknown: ["github_a", "github_b"] }),
        hostVersion: "2.3.0",
        hostWarning: "OpenCode 2.3.0 is outside the supported range.",
      }),
    )
    expect(status).toMatchObject({
      readOnly: false,
      toolsets: ["repos"],
      tools: { visible: 12, unknown: ["github_a", "github_b"], mode: "hide" },
      host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false },
      hostWarning: "OpenCode 2.3.0 is outside the supported range.",
    })
  })

  // S13: the shared status fields, with the S9 labels in machine form.
  it("has the shared fields: version, host with range and tested, state, unguardedAgents and nextStep", async () => {
    const status = await computeStatus(fakeCtx({ server: "connected", label: "octocat" }).ctx, deps({ hostVersion: "2.2.5" }))
    expect(status).toMatchObject({ version: PLUGIN_VERSION, state: "connected", host: { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }, unguardedAgents: [], nextStep: "Nothing to do." })
    expect(PLUGIN_VERSION).toBe(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version)
    for (const state of STATES) expect(state).toMatch(/^[a-z_]+$/)
  })

  // S13 and TRIAGE decision 2: an untested release inside the range works normally, and its next step is unchanged.
  it("on a release in the range that is not tested, reports the working state and leaves the next step alone", async () => {
    const status = await computeStatus(fakeCtx({ server: "connected", label: "octocat" }).ctx, deps({ hostVersion: "2.2.6" }))
    expect(status).toMatchObject({ state: "connected", host: { version: "2.2.6", range: ">=2.2.3 <2.3.0", tested: false }, nextStep: "Nothing to do." })
    const outside = await computeStatus(fakeCtx({ server: "connected", label: "octocat" }).ctx, deps({ hostVersion: "2.3.0", hostWarning: "x" }))
    expect(outside.nextStep).toBe("If GitHub misbehaves, use OpenCode 2.2.3, 2.2.4 or 2.2.5, where it is tested.")
  })

  // QA LIVE-1: an agent whose own rules already ask or deny for GitHub's tools needs no fix.
  it("lists an agent only when its own rules would run an unknown GitHub tool without asking", async () => {
    const agents = [
      { id: "build", permissions: insertDefaults([BASE], defaultRules()) },
      { id: "open", permissions: [BASE] },
      { id: "asks", permissions: [BASE, { action: "*", resource: "*", effect: "ask" } as Rule] },
      { id: "denies-github", permissions: [BASE, { action: "github_*", resource: "*", effect: "deny" } as Rule] },
      { id: "asks-github-mcp", permissions: [BASE, { action: "github_*", resource: "*", effect: "ask" } as Rule] },
      { id: "no-base", permissions: [{ action: "read", resource: "*", effect: "allow" } as Rule] },
      { id: "allows-github", permissions: [{ action: "github_*", resource: "*", effect: "allow" } as Rule] },
      { id: "fixed-by-hand", permissions: [BASE, { action: "*", resource: "*", effect: "allow" } as Rule, ...defaultRules()] },
    ]
    const status = await computeStatus(fakeCtx({ server: "connected", agents }).ctx, deps())
    expect(status.unguardedAgents).toEqual(["open", "allows-github"])
  })

  // QA LIVE-2: the next step is never "Nothing to do." while agents are listed. TRIAGE decision 1: one fixed sentence, no names.
  it("gives the one fixed agent fix in the next step once the connection needs nothing", async () => {
    const open = (id: string) => ({ id, permissions: [BASE] })
    const fix = "Put the default rules shown by /github-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for GitHub tools."
    const one = await computeStatus(fakeCtx({ server: "connected", label: "octocat", agents: [open("reviewer")] }).ctx, deps())
    expect(one.nextStep).toBe(fix)
    const many = await computeStatus(fakeCtx({ server: "connected", label: "octocat", agents: ["a", "b", "c", "d", "e", "f", "g"].map(open) }).ctx, deps())
    expect(many.nextStep).toBe(fix)
    // A connection problem comes first; on GitHub Enterprise Server the agents count too.
    expect((await computeStatus(fakeCtx({ server: "needs_auth", agents: [open("reviewer")] }).ctx, deps())).nextStep).toBe("Run /connect and choose GitHub.")
    const enterprise = await computeStatus(fakeCtx({ label: "octocat", agents: [open("reviewer")] }).ctx, deps({ enterprise: "ghe.example.com" }))
    expect(enterprise.nextStep).toBe(fix)
    expect(formatStatus(one).match(/Next step: .*/g)).toEqual([`Next step: ${one.nextStep}`])
  })

  // QA GITHUB-1 follow-up: github_api checks owner and repo names in lower case, so a rule in another case never matches.
  it("warns about a github_api rule with an upper-case owner or repo, in a row and the next step", async () => {
    const rule = (action: string, resource: string, effect: Rule["effect"] = "deny") => ({ action, resource, effect }) as Rule
    const guarded = insertDefaults([BASE], defaultRules())
    const agents = [
      { id: "build", permissions: [...guarded, rule("github_api", "DELETE /repos/Owner/prod/*"), rule("github_api", "PUT /repos/owner/repo/pulls/*/merge", "allow")] },
      { id: "plan", permissions: [...guarded, rule("github_api", "DELETE /repos/Owner/prod/*"), rule("github_*", "POST /orgs/Acme/*", "ask"), rule("bash", "/repos/Owner/x")] },
    ]
    const status = await computeStatus(fakeCtx({ server: "connected", label: "octocat", agents }).ctx, deps())
    expect(status.unmatchedRules).toEqual(["DELETE /repos/Owner/prod/*", "POST /orgs/Acme/*"])
    expect(status.nextStep).toBe(
      'Write the github_api rule "DELETE /repos/Owner/prod/*" (and 1 more) with lower-case owner and repo names, as "DELETE /repos/owner/prod/*": as written it never matches.',
    )
    expect(formatStatus(status)).toContain("\nHost: github.com\nRules that never match: DELETE /repos/Owner/prod/*; POST /orgs/Acme/*\nTools:")
    expect(isStatus(status)).toBe(true)
    // A connection problem still comes first; lower-case rules give no row.
    expect((await computeStatus(fakeCtx({ server: "needs_auth", agents }).ctx, deps())).nextStep).toBe("Run /connect and choose GitHub.")
    const clean = await computeStatus(fakeCtx({ server: "connected", label: "octocat", agents: [agents[0]!].map((agent) => ({ ...agent, permissions: agent.permissions.slice(0, -2) })) }).ctx, deps())
    expect("unmatchedRules" in clean).toBe(false)
    expect(formatStatus(clean)).not.toContain("Rules that never match")
  })

  it("names agents without the default rules and includes the block for them", async () => {
    const agents = [
      { id: "build", permissions: insertDefaults([BASE], defaultRules()) },
      { id: "reviewer", permissions: [BASE] },
    ]
    const status = await computeStatus(fakeCtx({ server: "connected", agents }).ctx, deps())
    expect(status.unguardedAgents).toEqual(["reviewer"])
    expect(status.permissionsBlock).toEqual(defaultRules())
    const guarded = await computeStatus(fakeCtx({ server: "connected" }).ctx, deps())
    expect(guarded.unguardedAgents).toEqual([])
    expect("permissionsBlock" in guarded).toBe(false)
  })

  // TRIAGE decision 8: a user's skill with the plugin's id loads instead of the plugin's, so status names it.
  it("names a skill that replaces one of the plugin's, in a row and the next step", async () => {
    const theirs = "/home/me/.config/opencode/skills/github-pr-review/SKILL.md"
    const status = await computeStatus(fakeCtx({ server: "connected", label: "octocat", skills: [{ id: "github-pr-review", path: theirs }] }).ctx, deps())
    expect(status.shadowedSkills).toEqual([{ id: "github-pr-review", path: theirs }])
    expect(status.nextStep).toBe(`Rename or move the "github-pr-review" skill at ${theirs}, which OpenCode loads instead of the plugin's skill of the same name.`)
    expect(formatStatus(status)).toContain(`\nHost: github.com\nSkills: github-pr-review replaced by ${theirs}\nTools:`)
    expect(isStatus(status)).toBe(true)
    // The plugin's own, or a list that fails, gives nothing.
    for (const skills of [undefined, "fail"] as const) {
      const own = await computeStatus(fakeCtx({ server: "connected", label: "octocat", ...(skills ? { skills } : {}) }).ctx, deps())
      expect(own).toMatchObject({ state: "connected", nextStep: "Nothing to do." })
      expect("shadowedSkills" in own).toBe(false)
    }
  })

  it("leaves out empty optional fields", async () => {
    const status = await computeStatus(fakeCtx({ server: "needs_auth" }).ctx, deps())
    expect(Object.keys(status).sort()).toEqual(["host", "nextStep", "readOnly", "state", "tools", "toolsets", "unguardedAgents", "version"])
    expect(status.host).toEqual({ version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true })
  })

  it("answers 20 concurrent calls, each with fresh data", async () => {
    const { ctx, calls } = fakeCtx({ server: "connected", label: "octocat" })
    const results = await Promise.all(Array.from({ length: 20 }, () => computeStatus(ctx, deps())))
    expect(results.every((status) => status.state === "connected")).toBe(true)
    expect(calls.list).toBe(20)
  })

  it("on GitHub Enterprise Server, reports the sign-in on the plugin's integration and says only github_api works", async () => {
    const enterprise = { enterprise: "ghe.example.com", integrationID: () => ID, conflict: () => false }
    const signedOut = await computeStatus(fakeCtx().ctx, deps(enterprise))
    expect(signedOut).toMatchObject({ state: "sign_in_required", enterprise: "ghe.example.com", nextStep: "Run /connect and choose GitHub Enterprise." })
    const signedIn = await computeStatus(fakeCtx({ label: "octocat" }).ctx, deps(enterprise))
    expect(signedIn).toMatchObject({ state: "connected", account: "octocat", nextStep: "Nothing to do." })
    expect(formatStatus(signedIn)).toContain("Host: ghe.example.com (GitHub Enterprise Server)\nTools: github_api only. GitHub's hosted MCP tools do not support GitHub Enterprise Server; run github-mcp-server yourself for them.")
    expect(isStatus(signedIn)).toBe(true)
  })

  it("covers every state", () => {
    expect([...STATES].sort()).toEqual(["conflict", "connected", "connecting", "disabled", "failed", "not_configured", "sign_in_required"])
  })
})

describe("registerStatus", () => {
  it("registers /github-status, which posts the status into the session without starting a turn", async () => {
    const { ctx, registered, calls } = fakeCtx({ server: "needs_auth" })
    await registerStatus(ctx, deps())
    const command = registered.commands[0]!
    expect(command.name).toBe(STATUS_COMMAND)
    await command.execute({ sessionID: "ses_1", delivery: "queue", prompt: {} })
    expect(calls.synthetic).toEqual([
      { sessionID: "ses_1", delivery: "queue", text: expect.stringContaining("Connection: sign-in required"), description: "GitHub status", resume: false },
    ])
  })

  it("posts a plain notice when the status cannot be computed", async () => {
    const { ctx, registered, calls } = fakeCtx({ fail: true })
    await registerStatus(ctx, deps())
    await registered.commands[0]!.execute({ sessionID: "ses_1", delivery: "queue", prompt: {} })
    const text = (calls.synthetic[0] as { text: string }).text
    expect(text).toBe("STATUS_UNAVAILABLE: GitHub status is unavailable right now. Next step: Try again in a few seconds; if it persists, restart OpenCode.")
  })

  it("answers the status RPC, and reports failures as unavailable without raw error text", async () => {
    const { ctx, registered } = fakeCtx({ server: "connected", label: "octocat" })
    await registerStatus(ctx, deps())
    expect(registered.rpc?.definition.id).toBe("github.platform")
    const error = (type: string, message: string, data: unknown) => ({ type, message, data })
    expect((await registered.rpc!.handlers.status(undefined, { signal: AbortSignal.timeout(1000), error })).account).toBe("octocat")

    const failing = fakeCtx({ fail: true })
    await registerStatus(failing.ctx, deps())
    const result = await failing.registered.rpc!.handlers.status({}, { signal: AbortSignal.timeout(1000), error })
    expect(result.type).toBe("unavailable")
    expect(JSON.stringify(result)).not.toContain("internal detail")
  })

  it("never puts jargon in what the model or the user reads", async () => {
    for (const server of ["connected", "needs_auth", "pending", "failed", "disabled"] as const) {
      const status = await computeStatus(fakeCtx({ server, agents: [{ id: "reviewer", permissions: [BASE] }] }).ctx, deps({ hostWarning: "x" }))
      expect(jargonIn(formatStatus(status))).toEqual([])
    }
  })
})
