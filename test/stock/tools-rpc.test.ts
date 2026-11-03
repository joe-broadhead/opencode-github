// The tools RPC on each stock OpenCode release (`opencode serve`), against the loopback fake GitHub, with no model.
// Run with `npm run test:stock`, which builds first. It pins what the RPC relies on and OpenCode does not document:
// the executors from `ctx.tool.list()` check the agent's and the session's rules, an evaluate hook can refuse a
// script's ask, and a plain JSON Schema contract with a strict validator refuses a bad envelope.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { SCRIPT_API_METHOD } from "../../src/api/script.js"
import { KNOWN_READS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { FAKE_INPUT, type FakeGitHub, FIXTURE_PAT, PAT_LOGIN, startFakeGitHub, UPSTREAM_FAILURE } from "../host/fake-github.js"
import { cleanupStock, startStock, STOCK_VERSIONS, type StockHost, until } from "./harness.js"

// Installing and starting a stock host takes minutes on a busy machine.
setDefaultTimeout(300_000)
afterAll(cleanupStock)

/** Two known reads, two writes, the hidden ui_get and one tool the plugin does not know. */
const READS = ["get_me", "issue_read"]
const EXCLUDED = ["issue_write", "create_pull_request", "ui_get", "brand_new_tool"]

const rule = (action: string, effect: "allow" | "deny" | "ask") => ({ action, resource: "*", effect })

/** The plugin's status RPC, which counts the github server's tools that OpenCode lists. */
const status = async (host: StockHost) =>
  (await host.client.rpc.call({ rpcID: "github.platform", method: "status", input: {}, location: host.location })).output as { tools: { visible: number; unknown: string[]; mode: string } }

/** A tools RPC call's result, or its error's `{ type, code, message }`. */
async function script(host: StockHost, method: string, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method, input: input as never, location: host.location })).output }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

for (const version of STOCK_VERSIONS)
  describe(`the tools RPC on stock OpenCode ${version}`, () => {
    const sessions: Record<string, string> = {}
    let fake: FakeGitHub
    let host: StockHost
    const calls = (from: number) => fake.calls().slice(from)
    const call = (session: string, method: string, input: unknown) => script(host, method, { sessionID: sessions[session] ?? session, input })

    beforeAll(async () => {
      fake = startFakeGitHub([...READS, ...EXCLUDED].map((name) => ({ name, readOnly: !name.includes("write") && name !== "create_pull_request" })))
      host = await startStock(version, {
        // With readOnly off GitHub lists the writes too, so the test shows they are no methods even when listed.
        options: { readOnly: false },
        fake: { url: `${fake.origin}/mcp/`, token: FIXTURE_PAT },
        // Config-only agents carry exactly these rules after the host's defaults.
        agents: { locked: { mode: "primary", permissions: [rule("github_*", "deny")] }, careful: { mode: "primary", permissions: [rule("github_get_me", "ask")] } },
      })
      // OpenCode lists the server's tools a moment after it reports the server connected.
      await until("OpenCode lists the five tools the plugin keeps", async () => (await status(host)).tools.visible === 5)
      const create = async (input: Record<string, unknown>) => (await host.client.session.create({ location: host.location, ...input })).id
      sessions["build"] = await create({ agent: "build" })
      sessions["locked"] = await create({ agent: "locked" })
      sessions["careful"] = await create({ agent: "careful" })
      sessions["agentless"] = await create({})
      // Session rules come after the agent's: one narrows build, the other reopens one tool for locked.
      sessions["narrow"] = await create({ agent: "build", permissions: [rule("github_get_me", "deny")] })
      sessions["reopen"] = await create({ agent: "locked", permissions: [rule("github_get_me", "allow")] })
    })
    afterAll(async () => {
      await host?.close()
      await fake?.close()
    })

    test("describes the known reads and api; the listed reads are available with their live schemas", async () => {
      const { value } = await script(host, "describe", {})
      expect(value.id).toBe(TOOLS_RPC_ID)
      expect(value.methods.map((method: { name: string }) => method.name)).toEqual([...KNOWN_READS, SCRIPT_API_METHOD])
      const byName = new Map(value.methods.map((method: { name: string }) => [method.name, method]))
      for (const name of READS) expect(byName.get(name)).toMatchObject({ kind: "mcp", tool: `github_${name}`, action: `github_${name}`, available: true, input: FAKE_INPUT })
      expect(byName.get("list_issues")).toMatchObject({ available: false, reason: "TOOL_UNAVAILABLE" })
      // The probe's server has no sign-in of its own, so github_api has none.
      expect(byName.get(SCRIPT_API_METHOD)).toMatchObject({ kind: "plugin", action: "github_api", available: false, reason: "AUTH_REQUIRED" })
    })

    test("never makes a write, ui_get or an unknown tool a method, though GitHub lists them", async () => {
      // The status RPC counts what the server lists: the two reads, the two writes and the unknown tool (ui_get is removed).
      expect((await status(host)).tools).toEqual({ visible: 5, unknown: ["github_brand_new_tool"], mode: "ask" })
      const from = fake.calls().length
      for (const name of EXCLUDED) {
        const refused = await call("build", name, {})
        expect(refused.type).not.toBe("failed")
        expect(refused.message).toMatch(/not.?found|unknown/i)
      }
      expect(calls(from)).toEqual([])
    })

    test("runs a known read as a session whose agent allows it, through the github server, with no model turn", async () => {
      const from = fake.requests.length
      const result = await call("build", "get_me", { query: "hello" })
      expect(result.value).toEqual({ output: { tool: "get_me", arguments: { query: "hello" } }, text: expect.stringContaining(`"login":"${PAT_LOGIN}"`) })
      expect(fake.requests.slice(from).filter((request) => request.rpc === "tools/call").map((request) => [request.tool, request.authorized])).toEqual([["get_me", true]])
      const session = await host.client.session.get({ sessionID: sessions["build"]! })
      expect(session.tokens).toMatchObject({ input: 0, output: 0 })
      expect(JSON.stringify(result)).not.toContain(FIXTURE_PAT)
    })

    test("refuses a session whose agent denies GitHub, before GitHub or the API is called", async () => {
      const from = fake.calls().length
      expect(await call("locked", "get_me", { query: "q" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect(await call("locked", SCRIPT_API_METHOD, { method: "GET", path: "/user" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect(calls(from)).toEqual([])
    })

    test("refuses an ask at once, and leaves no approval prompt waiting", async () => {
      const from = fake.calls().length
      const started = Date.now()
      const result = await call("careful", "get_me", { query: "q" })
      expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect(result.message).toMatch(/cannot answer an approval prompt/)
      expect(Date.now() - started).toBeLessThan(5000)
      const { data: pending } = await host.client.permission.request.list({ location: host.location })
      expect(pending.filter((request) => JSON.stringify(request).includes(sessions["careful"]!))).toEqual([])
      expect(calls(from)).toEqual([])
      // The same agent's other tools have no ask, so they run.
      expect((await call("careful", "issue_read", { query: "q" })).value).toMatchObject({ output: { tool: "issue_read" } })
    })

    test("applies the session's rules after the agent's", async () => {
      expect(await call("narrow", "get_me", { query: "q" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect((await call("narrow", "issue_read", { query: "q" })).value).toMatchObject({ output: { tool: "issue_read" } })
      expect((await call("reopen", "get_me", { query: "q" })).value).toMatchObject({ output: { tool: "get_me" } })
      expect(await call("reopen", "issue_read", { query: "q" })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    })

    test("gives GitHub's own error as UPSTREAM_ERROR: its first line, with the signed URL redacted", async () => {
      const result = await call("build", "get_me", { query: "fail" })
      expect(result).toMatchObject({ type: "failed", code: "UPSTREAM_ERROR" })
      expect(result.message).toContain("https://objects.example.invalid/log.txt?[redacted]")
      for (const hidden of ["fake-signature-123", "second line"]) expect(result.message).not.toContain(hidden)
      expect(UPSTREAM_FAILURE).toContain("fake-signature-123")
    })

    test("refuses api writes, downloads and GraphQL mutations before any request; a read runs github_api's own spec", async () => {
      const refusals = [
        { method: "POST", path: "/repos/octo/hello/issues", body: { title: "x" } },
        { method: "GET", path: "/repos/octo/hello/zipball", download: { path: "hello.zip" } },
        { graphql: { query: "mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }" } },
      ]
      for (const input of refusals) expect(await call("build", SCRIPT_API_METHOD, input)).toMatchObject({ type: "failed", code: "SCRIPT_READ_ONLY" })
      // The probe's server has no sign-in of its own, so github_api's read stops at its sign-in check.
      expect(await call("build", SCRIPT_API_METHOD, { method: "GET", path: "/user" })).toMatchObject({ type: "failed", code: "AUTH_REQUIRED" })
      expect(host.attempts.filter((line) => line.includes("api.github.com"))).toEqual([])
    })

    test("names an unknown session, a session without an agent, and rejects an envelope with extra keys", async () => {
      expect(await call("ses_does_not_exist", "get_me", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_UNKNOWN" })
      expect(await call("agentless", "get_me", { query: "q" })).toMatchObject({ type: "failed", code: "SESSION_AGENT_REQUIRED" })
      const from = fake.calls().length
      for (const envelope of [{ sessionID: sessions["build"], input: { query: "q" }, extra: true }, { input: { query: "q" } }, { sessionID: sessions["build"], input: "q" }])
        expect(await script(host, "get_me", envelope)).toMatchObject({ type: "rpc.invalid_input" })
      expect(calls(from)).toEqual([])
      expect(host.attempts).toEqual([])
    })
  })
