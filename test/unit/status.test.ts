import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/config.js"
import { type Rule, defaultRules, insertDefaults } from "../../src/permissions.js"
import { STATES, formatStatus, isStatus } from "../../src/rpc.js"
import { STATUS_COMMAND, type StatusDeps, computeStatus, registerStatus } from "../../src/status.js"
import { jargonIn } from "./jargon.js"

type Ctx = Parameters<typeof registerStatus>[0]
type ServerStatus = "connected" | "pending" | "disabled" | "failed" | "needs_auth"

const ID = "mcp_0123456789abcdef"
const LOCATION = { directory: "/workspace" }
const BASE: Rule = { action: "*", resource: "*", effect: "allow" }

function fakeCtx(input: { server?: ServerStatus; label?: string; agents?: Array<{ id: string; permissions: Rule[] }>; fail?: boolean } = {}) {
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
    ...overrides,
  }
}

describe("computeStatus", () => {
  it.each([
    ["connected", { server: "connected", label: "octocat" }, {}, "Nothing to do."],
    ["needs_auth", { server: "needs_auth" }, {}, "Run /connect and choose GitHub."],
    ["pending", { server: "pending" }, {}, "GitHub is still starting. Check again in a few seconds."],
    ["failed", { server: "failed" }, {}, "OpenCode could not reach GitHub's MCP server. Check your network connection, then reconnect github in /mcps."],
    ["disabled", { server: "disabled" }, {}, "Turn the github server back on in /mcps."],
    ["not_registered", {}, {}, "Restart OpenCode. If GitHub is still missing, check that no other plugin removes the MCP server named github."],
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

  it("is pending until OpenCode has applied the MCP config", async () => {
    const status = await computeStatus(fakeCtx().ctx, deps({ conflict: () => undefined }))
    expect(status.state).toBe("pending")
  })

  it("is pending while the sign-in methods are not attached yet", async () => {
    const status = await computeStatus(fakeCtx({ server: "needs_auth" }).ctx, deps({ integrationID: () => undefined }))
    expect(status.state).toBe("pending")
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
        hostWarning: "OpenCode 2.3.0 is not a tested host.",
      }),
    )
    expect(status).toMatchObject({
      readOnly: false,
      toolsets: ["repos"],
      tools: { visible: 12, unknown: ["github_a", "github_b"], mode: "hide" },
      host: { version: "2.3.0", warning: "OpenCode 2.3.0 is not a tested host." },
    })
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

  it("leaves out empty optional fields", async () => {
    const status = await computeStatus(fakeCtx({ server: "needs_auth" }).ctx, deps())
    expect(Object.keys(status).sort()).toEqual(["host", "nextStep", "readOnly", "state", "tools", "toolsets", "unguardedAgents"])
    expect(status.host).toEqual({ version: "2.2.3" })
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
    expect(signedOut).toMatchObject({ state: "needs_auth", enterprise: "ghe.example.com", nextStep: "Run /connect and choose GitHub Enterprise." })
    const signedIn = await computeStatus(fakeCtx({ label: "octocat" }).ctx, deps(enterprise))
    expect(signedIn).toMatchObject({ state: "connected", account: "octocat", nextStep: "Nothing to do." })
    expect(formatStatus(signedIn)).toContain("Host: ghe.example.com (GitHub Enterprise Server)\nTools: github_api only. GitHub's hosted MCP tools do not support GitHub Enterprise Server; run github-mcp-server yourself for them.")
    expect(isStatus(signedIn)).toBe(true)
  })

  it("covers every state", () => {
    expect([...STATES].sort()).toEqual(["conflict", "connected", "disabled", "failed", "needs_auth", "not_registered", "pending"])
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
    expect(text).toBe("STATUS_UNAVAILABLE: GitHub status is unavailable right now. Next step: Run /github-status again.")
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
