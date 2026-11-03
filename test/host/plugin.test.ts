// The built plugin on a public @opencode/sdk host, with GitHub replaced by a loopback fake and
// every other request blocked. Each describe owns one host. Run with `npm run test:host`,
// which builds first; set HOST_SDK_DIR to run another SDK release (see harness.ts).
import { ROOT } from "./isolate.js"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { Plugin } from "@opencode/plugin"
import { defaultRules } from "../../src/permissions.js"
import { type Status, formatRules } from "../../src/rpc.js"
import { DEVICE_LOGIN, FIXTURE_PAT, PAT_LOGIN, USER_CODE } from "./fake-github.js"
import {
  agentRules,
  attempt,
  cleanup,
  connected,
  effect,
  githubServer,
  GithubRpc,
  type Host,
  integrationID,
  ownMethods,
  pluginState,
  type Rule,
  script,
  SDK_VERSION,
  session,
  settledAttempt,
  signInWithToken,
  startHost,
  statusCommand,
  tool,
  toolIDs,
  unattended,
  until,
} from "./harness.js"

// Starting a host takes several seconds, much more on a busy machine.
setDefaultTimeout(180_000)
afterAll(cleanup)

const BUILT_IN = ["build", "general", "explore", "compaction", "title", "summary", "plan"]
const SKILLS = ["github-code-research", "github-issue-triage", "github-pr-review"]
const isBaseAllow = (rule: Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"
const nobodyPresent = (action: string) => `Permission ${action} needs approval, and nobody is present to give it`
const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })
const deny = (action: string): Rule => ({ action, resource: "*", effect: "deny" })

const status = (host: Host) => host.probe().rpc(GithubRpc).status({}) as Promise<Status>

const mcpRequests = (host: Host) => host.fake.requests.filter((request) => request.path === "/mcp/")

describe(`defaults on OpenCode ${SDK_VERSION}`, () => {
  let host: Host
  beforeAll(async () => {
    // reviewer exists only in the user's config, so OpenCode creates it after plugins run.
    host = await startHost({ config: () => ({ agents: { reviewer: { description: "Reviews changes", mode: "subagent" } } }) })
  })
  afterAll(() => host?.close())

  test("the plugin is active and registers github with GitHub's headers", async () => {
    expect(await pluginState(host)).toEqual({ status: "active" })
    expect(await integrationID(host)).toBeString()
    await until("OpenCode has contacted github", async () => mcpRequests(host).length > 0)
    for (const request of mcpRequests(host)) {
      expect(request).toMatchObject({ toolsets: "context,repos,issues,pull_requests,users,actions,git,labels,code_quality,code_security,secret_protection,dependabot,security_advisories,discussions,orgs", readonly: "true", toolsHeader: false })
      expect(request.lockdown).toBeUndefined()
    }
  })

  test("without a client ID, only token sign-in is offered", async () => {
    expect(await ownMethods(host, ["github-token"])).toEqual({ name: "GitHub", ids: ["github-token"] })
    const id = await integrationID(host)
    await expect(host.client.integration.oauth.connect({ integrationID: id, methodID: "github-device", location: host.location })).rejects.toBeDefined()
  })

  test("signed out, the RPC and /github-status say how to sign in and name the unguarded agent", async () => {
    await until("github needs sign-in", async () => (await githubServer(host))?.status.status === "needs_auth")
    const fromRpc = await status(host)
    expect(fromRpc).toMatchObject({ state: "needs_auth", readOnly: true, unguardedAgents: ["reviewer"], permissionsBlock: defaultRules() })
    expect(fromRpc.account).toBeUndefined()
    expect(fromRpc.nextStep).toBe("Run /connect and choose GitHub.")
    const text = await statusCommand(host, await session(host))
    expect(text).toStartWith("Connection: sign-in required\n")
    expect(text).toContain("Agents without default rules: reviewer\n")
    expect(text).toContain(`Put the rules below first in each one's own "permissions" list`)
    expect(text).toContain(formatRules(defaultRules()))
  })

  test("token sign-in connects github, and later MCP requests carry the token", async () => {
    const before = host.fake.requests.length
    const { started, settled } = await signInWithToken(host)
    expect(started.mode).toBe("code")
    expect(started.url).toStartWith("https://github.com/settings/personal-access-tokens/new?")
    expect(settled.status).toBe("complete")
    await connected(host)
    const after = host.fake.requests.slice(before)
    expect(after.find((request) => request.path === "/user")).toMatchObject({ method: "GET", authorized: true })
    expect(after.filter((request) => request.path === "/mcp/").map((request) => request.rpc)).toContain("tools/list")
    expect(after.filter((request) => request.path === "/mcp/").every((request) => request.authorized)).toBe(true)
    await tool(host, "github_get_me")
  })

  test("the RPC reports the account, and 20 concurrent calls succeed", async () => {
    await until("the unknown tool is listed", async () => (await status(host)).tools.unknown.length === 1)
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => status(host)))
    expect(results.filter((result) => result.status === "rejected")).toEqual([])
    for (const result of results) {
      expect(result.status === "fulfilled" && result.value).toMatchObject({
        state: "connected",
        account: PAT_LOGIN,
        tools: { visible: 3, unknown: ["github_brand_new_tool"], mode: "ask" },
        host: { version: SDK_VERSION },
      })
    }
  })

  test("github_api reads without asking, and refuses writes while read-only", async () => {
    const sessionID = await session(host)
    const before = host.fake.requests.length
    expect(await attempt(host, sessionID, "build", "github_api", "reject", { method: "GET", path: "/repos/octo/hello" })).toEqual({ asked: undefined, ok: true })
    expect(await attempt(host, sessionID, "build", "github_api", "reject", { method: "POST", path: "/repos/octo/hello/releases", body: { tag_name: "v1" } })).toEqual({
      asked: undefined,
      ok: false,
      error: expect.stringContaining("READ_ONLY: POST /repos/octo/hello/releases changes GitHub"),
    })
    expect(host.fake.requests.slice(before).map((request) => `${request.method} ${request.path} ${request.authorized}`)).toEqual(["GET /repos/octo/hello true"])
  })

  test("every built-in agent gets the default block right after its base allow, once", async () => {
    const rules = await agentRules(host)
    for (const id of BUILT_IN) {
      const permissions = rules.get(id)!
      const base = permissions.findIndex(isBaseAllow)
      expect(base).toBeGreaterThanOrEqual(0)
      expect(permissions.slice(base + 1, base + 1 + defaultRules().length)).toEqual(defaultRules())
      expect(permissions.filter((rule) => rule.action === "github_*")).toHaveLength(1)
    }
    expect(rules.get("reviewer")!.some((rule) => rule.action.startsWith("github_"))).toBe(false)
  })

  test("Plan keeps its own rules, and Explore still denies GitHub tools", async () => {
    const plan = (await agentRules(host)).get("plan")!
    expect(plan.findIndex((rule) => rule.action === "edit" && rule.effect === "deny")).toBeGreaterThan(plan.findIndex((rule) => rule.action === "github_*"))
    expect(await effect(host, "plan", "edit")).toBe("deny")
    expect(await effect(host, "plan", "github_brand_new_tool")).toBe("ask")
    const before = host.fake.calls().length
    expect(await attempt(host, await session(host, "explore"), "explore", "github_get_me")).toEqual({
      asked: undefined,
      ok: false,
      error: "Tool.Error: Permission denied: github_get_me",
    })
    expect(host.fake.calls().slice(before)).toEqual([])
  })

  test("known reads run without a prompt, attended and unattended", async () => {
    const sessionID = await session(host)
    const before = host.fake.calls().length
    expect(await attempt(host, sessionID, "build", "github_get_me")).toEqual({ asked: undefined, ok: true })
    expect(await unattended(host, sessionID, "await tools.github.get_me({})\nawait tools.github.issue_read({})\nreturn false")).toEqual({ ok: true })
    expect(host.fake.calls().slice(before)).toEqual(["get_me", "get_me", "issue_read"])
  })

  test("an unknown tool is denied unattended and asks when someone is present", async () => {
    const sessionID = await session(host)
    const before = host.fake.calls().length
    expect(await unattended(host, sessionID, "await tools.github.brand_new_tool({})\nreturn false")).toEqual({
      ok: false,
      error: nobodyPresent("github_brand_new_tool"),
    })
    expect(await attempt(host, sessionID, "build", "github_brand_new_tool")).toEqual({
      asked: "github_brand_new_tool",
      ok: false,
      error: "Permission.DeclinedError: ",
    })
    expect(host.fake.calls().slice(before)).toEqual([])
  })

  test("a saved 'Always allow' wins over the default ask, for every agent in the project", async () => {
    const sessionID = await session(host)
    expect(await attempt(host, sessionID, "build", "github_brand_new_tool", "always")).toEqual({ asked: "github_brand_new_tool", ok: true })
    expect(await attempt(host, sessionID, "build", "github_brand_new_tool")).toEqual({ asked: undefined, ok: true })
    expect(await attempt(host, await session(host, "plan"), "plan", "github_brand_new_tool")).toEqual({ asked: undefined, ok: true })
    const { projectID } = await host.client.sessions.get({ sessionID })
    const saved = await host.client.permission.saved.list({ projectID })
    expect(saved.map(({ action, resource }) => ({ action, resource }))).toEqual([{ action: "github_brand_new_tool", resource: "*" }])
  })

  test("the /github-status command and the three skills are registered", async () => {
    const { data: commands } = await host.client.command.list({ location: host.location })
    expect(commands.map((command) => command.name).filter((name) => name.startsWith("github"))).toEqual(["github-status"])
    const { data: skills } = await host.client.skill.list({ location: host.location })
    expect(skills.map((skill) => skill.id as string).filter((id) => id.startsWith("github")).sort()).toEqual(SKILLS)
  })

  test("a reload sets the plugin up again without duplicates, and the sign-in survives", async () => {
    await host.client.location.reload()
    await until("the plugin is active again", async () => (await pluginState(host))?.status === "active")
    await until("github reconnects", async () => (await githubServer(host))?.status.status === "connected", 60_000)
    const rules = await agentRules(host)
    for (const id of BUILT_IN) expect(rules.get(id)!.filter((rule) => rule.action === "github_*")).toHaveLength(1)
    expect(await ownMethods(host, ["github-token"])).toEqual({ name: "GitHub", ids: ["github-token"] })
    const { data: commands } = await host.client.command.list({ location: host.location })
    expect(commands.filter((command) => command.name === "github-status")).toHaveLength(1)
    expect(await status(host)).toMatchObject({ state: "connected", account: PAT_LOGIN })
  })

  test("OpenCode's global folders, temp folder, working directory and locations stay in the test's temp root", async () => {
    const global = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((key) => join(process.env[key]!, "opencode"))
    expect(global.filter((path) => !existsSync(path))).toEqual([])
    const { paths } = await host.client.server.info()
    const locations = (await host.client.debug.location.list()).map((location) => location.directory as string)
    const used = [...global, realpathSync(paths.tmp), process.env.OPENCODE_TEST_HOME!, tmpdir(), process.cwd(), ...locations]
    expect(used.filter((path) => !path.startsWith(ROOT + sep))).toEqual([])
  })
})

describe("writes, lockdown and the user's own rules", () => {
  const userRules = [allow("github_create_pull_request"), deny("github_issue_read")]
  let host: Host
  beforeAll(async () => {
    host = await startHost({
      options: { readOnly: false, lockdown: true, toolsets: ["context", "issues", "pull_requests"] },
      config: () => ({
        permissions: userRules,
        // The documented fix for an agent defined only in the user's config: the plugin's
        // block in that agent's own list, then the user's top-level rules for GitHub again.
        agents: {
          reviewer: { description: "Reviews changes", mode: "subagent", permissions: [...defaultRules(), ...userRules] },
          // A user deny on github_api hides the tool from that agent.
          auditor: { description: "Audits", mode: "subagent", permissions: [...defaultRules(), deny("github_api")] },
        },
      }),
    })
    await ownMethods(host, ["github-token"])
    await signInWithToken(host)
    await connected(host)
    await tool(host, "github_issue_write")
  })
  afterAll(() => host?.close())

  test("the options set GitHub's toolsets, read-only and lockdown headers", () => {
    expect(mcpRequests(host).length).toBeGreaterThan(0)
    for (const request of mcpRequests(host)) {
      expect(request).toMatchObject({ toolsets: "context,issues,pull_requests", readonly: "false", lockdown: "true", toolsHeader: false })
    }
  })

  test("a catalogued write is denied unattended and asks when someone is present", async () => {
    const sessionID = await session(host)
    const before = host.fake.calls().length
    expect(await unattended(host, sessionID, "await tools.github.issue_write({})\nreturn false")).toEqual({ ok: false, error: nobodyPresent("github_issue_write") })
    expect(await attempt(host, sessionID, "build", "github_issue_write")).toEqual({ asked: "github_issue_write", ok: false, error: "Permission.DeclinedError: " })
    expect(await attempt(host, sessionID, "build", "github_issue_write", "once")).toEqual({ asked: "github_issue_write", ok: true })
    expect(host.fake.calls().slice(before)).toEqual(["issue_write"])
  })

  test("a user allow rule runs a write without a prompt, and a user deny blocks a read", async () => {
    const sessionID = await session(host)
    const before = host.fake.calls().length
    expect(await attempt(host, sessionID, "build", "github_create_pull_request")).toEqual({ asked: undefined, ok: true })
    expect(await unattended(host, sessionID, "await tools.github.create_pull_request({})\nreturn false")).toEqual({ ok: true })
    expect(await attempt(host, sessionID, "build", "github_issue_read")).toEqual({ asked: undefined, ok: false, error: "Tool.Error: Permission denied: github_issue_read" })
    expect(host.fake.calls().slice(before)).toEqual(["create_pull_request", "create_pull_request"])
  })

  test("github_api asks before a POST and sends nothing on a decline; a user deny hides it", async () => {
    const sessionID = await session(host)
    const before = host.fake.requests.length
    const write = { method: "POST", path: "/repos/octo/hello/releases", body: { tag_name: "v1" } }
    expect(await attempt(host, sessionID, "build", "github_api", "reject", write)).toMatchObject({ asked: "github_api", ok: false })
    expect(await attempt(host, sessionID, "build", "github_api", "once", write)).toEqual({ asked: "github_api", ok: true })
    expect(host.fake.requests.slice(before).map((request) => `${request.method} ${request.path} ${request.authorized}`)).toEqual([
      "POST /repos/octo/hello/releases true",
    ])
    // OpenCode leaves a tool out of an agent's tools when its last matching rule denies it on every resource.
    expect(await effect(host, "build", "github_api")).toBe("ask")
    expect(await effect(host, "auditor", "github_api")).toBe("deny")
  })

  test("the per-agent fix guards a config-only agent and keeps the user's rules winning", async () => {
    const sessionID = await session(host, "reviewer")
    expect(await attempt(host, sessionID, "reviewer", "github_brand_new_tool")).toMatchObject({ asked: "github_brand_new_tool", ok: false })
    expect(await attempt(host, sessionID, "reviewer", "github_issue_write")).toMatchObject({ asked: "github_issue_write", ok: false })
    expect(await attempt(host, sessionID, "reviewer", "github_create_pull_request")).toEqual({ asked: undefined, ok: true })
    expect(await attempt(host, sessionID, "reviewer", "github_issue_read")).toMatchObject({ asked: undefined, ok: false })
    expect(await status(host)).toMatchObject({ state: "connected", readOnly: false, toolsets: ["context", "issues", "pull_requests"], unguardedAgents: [] })
  })
})

describe("device sign-in with a configured client ID, and hidden unknown tools", () => {
  const clientId = "Ov23liHostTestClient"
  let host: Host
  beforeAll(async () => {
    host = await startHost({ options: { clientId, unknownTools: "hide" } })
  })
  afterAll(() => host?.close())

  test("device and token sign-in are offered", async () => {
    expect(await ownMethods(host, ["github-device", "github-token"])).toEqual({ name: "GitHub", ids: ["github-device", "github-token"] })
  })

  test("device sign-in shows the code, connects github and never sends a client secret", async () => {
    const id = await integrationID(host)
    const { data: started } = await host.client.integration.oauth.connect({ integrationID: id, methodID: "github-device", location: host.location })
    expect(started).toMatchObject({ mode: "auto", url: "https://github.com/login/device" })
    expect(started.instructions).toContain(USER_CODE)
    expect(await settledAttempt(host, id, started.attemptID)).toMatchObject({ status: "complete" })
    await connected(host)
    const login = host.fake.requests.filter((request) => request.path.startsWith("/login/"))
    expect(login[0]).toMatchObject({ path: "/login/device/code", clientId, scope: "repo read:org" })
    expect(login.slice(1).every((request) => request.path === "/login/oauth/access_token" && request.clientId === clientId)).toBe(true)
    expect(login.some((request) => request.clientSecret)).toBe(false)
    expect(await status(host)).toMatchObject({ state: "connected", account: DEVICE_LOGIN })
  })

  test("unknownTools: hide removes GitHub tools the catalog does not know", async () => {
    await until("the unknown tool is listed", async () => (await status(host)).tools.unknown.length === 1)
    expect(await toolIDs(host)).toEqual(["github_api", "github_get_me", "github_issue_read"])
    expect(await status(host)).toMatchObject({ tools: { visible: 2, unknown: ["github_brand_new_tool"], mode: "hide" } })
  })
})

describe(`a revoked sign-in on OpenCode ${SDK_VERSION}`, () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost()
    await ownMethods(host, ["github-token"])
    await signInWithToken(host)
    await connected(host)
  })
  afterAll(() => host?.close())

  test("GitHub rejecting the token marks the account in /connect as needing sign-in", async () => {
    const id = await integrationID(host)
    host.fake.revoke()
    await host.client.experimental.mcp.disconnect({ server: "github", location: host.location })
    await host.client.experimental.mcp.connect({ server: "github", location: host.location })
    await until("github needs sign-in", async () => (await githubServer(host))?.status.status === "needs_auth")
    const account = await until("the account is marked", async () => {
      const { data } = await host.client.integration.get({ integrationID: id, location: host.location })
      const found = data.connections.find((connection) => connection.type === "credential")
      return found?.status && found
    })
    expect(account).toMatchObject({ label: PAT_LOGIN, status: { status: "needs_auth", message: "GitHub rejected the saved sign-in. Sign in again." } })
  })
})

describe(`GitHub Enterprise Server on OpenCode ${SDK_VERSION}`, () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ options: { host: "ghe.example.com", readOnly: false } })
  })
  afterAll(() => host?.close())

  test("registers no MCP server, offers token sign-in on GitHub Enterprise, and github_api reaches the server", async () => {
    const id = "github-enterprise"
    const integration = await until("the GitHub Enterprise integration is listed", async () => {
      const { data } = await host.client.integration.get({ integrationID: id, location: host.location }).catch(() => ({ data: undefined }))
      return data
    })
    expect(integration.name).toBe("GitHub Enterprise")
    expect(integration.methods.map((method) => (method.type === "oauth" ? method.id : method.type))).toEqual(["github-token"])
    expect(await githubServer(host)).toBeUndefined()
    expect(await status(host)).toMatchObject({ state: "needs_auth", enterprise: "ghe.example.com", nextStep: "Run /connect and choose GitHub Enterprise." })

    const { data: started } = await host.client.integration.oauth.connect({ integrationID: id, methodID: "github-token", location: host.location })
    expect(started.url).toStartWith("https://ghe.example.com/settings/personal-access-tokens/new?")
    await host.client.integration.oauth.complete({ integrationID: id, attemptID: started.attemptID, code: FIXTURE_PAT, location: host.location })
    expect(await settledAttempt(host, id, started.attemptID)).toMatchObject({ status: "complete" })
    expect(await status(host)).toMatchObject({ state: "connected", account: PAT_LOGIN, enterprise: "ghe.example.com" })

    const before = host.fake.requests.length
    expect(await attempt(host, await session(host), "build", "github_api", "reject", { method: "GET", path: "/repos/octo/hello" })).toEqual({ asked: undefined, ok: true })
    expect(host.fake.requests.slice(before).map((request) => `${request.method} ${request.path} ${request.authorized}`)).toEqual(["GET /repos/octo/hello true"])
    expect(mcpRequests(host)).toEqual([])
  })

  test("a script reads through api with the GitHub Enterprise sign-in; GitHub's MCP methods are not registered", async () => {
    const sessionID = await session(host)
    const before = host.fake.requests.length
    const read = await script(host, "api", { sessionID, input: { method: "GET", path: "/repos/octo/hello" } })
    expect(read.value).toMatchObject({ ok: true, status: 200, data: { full_name: "octo/hello" } })
    // readOnly is off, and a script's write is still refused before any request.
    expect(await script(host, "api", { sessionID, input: { method: "POST", path: "/repos/octo/hello/releases", body: { tag_name: "v1" } } })).toMatchObject({
      type: "failed",
      code: "SCRIPT_READ_ONLY",
    })
    expect(host.fake.requests.slice(before).map((request) => `${request.method} ${request.path} ${request.authorized}`)).toEqual(["GET /repos/octo/hello true"])
    const refused = await script(host, "get_me", { sessionID, input: {} })
    expect(refused).toMatchObject({ type: "failed", code: "NOT_REGISTERED" })
    expect(refused.message).toContain("call the api method instead")
  })
})

describe(`the tools RPC on OpenCode ${SDK_VERSION}`, () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ config: () => ({ agents: { locked: { mode: "primary", permissions: [deny("github_*")] } } }) })
    expect((await signInWithToken(host)).settled).toMatchObject({ status: "complete" })
    await connected(host)
    await tool(host, "github_get_me")
  })
  afterAll(() => host?.close())

  test("runs a known read through OpenCode's own GitHub sign-in, as the session's agent", async () => {
    const sessionID = await session(host)
    const before = host.fake.requests.length
    const result = await script(host, "get_me", { sessionID, input: { query: "hello" } })
    expect(result.value).toEqual({ output: { tool: "get_me", arguments: { query: "hello" } }, text: expect.stringContaining(`"login":"${PAT_LOGIN}"`) })
    expect(host.fake.requests.slice(before).filter((request) => request.rpc === "tools/call").map((request) => [request.tool, request.authorized])).toEqual([["get_me", true]])
    expect(JSON.stringify(result)).not.toContain(FIXTURE_PAT)
  })

  test("api reads GitHub's REST and GraphQL API with the same sign-in, and refuses a write before any request", async () => {
    const sessionID = await session(host)
    const description = await script(host, "describe", {})
    expect(description.value.methods.find((method: { name: string }) => method.name === "api")).toMatchObject({ kind: "plugin", action: "github_api", available: true })
    const before = host.fake.requests.length
    const read = await script(host, "api", { sessionID, input: { method: "GET", path: "/repos/octo/hello" } })
    expect(read.value).toMatchObject({ ok: true, status: 200, data: { full_name: "octo/hello" }, trust: { githubContent: "untrusted" } })
    expect(JSON.stringify(read)).not.toContain(FIXTURE_PAT)
    for (const input of [
      { method: "DELETE", path: "/repos/octo/hello" },
      { method: "GET", path: "/repos/octo/hello/zipball", download: { path: "hello.zip" } },
      { graphql: { query: "mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }" } },
    ])
      expect(await script(host, "api", { sessionID, input })).toMatchObject({ type: "failed", code: "SCRIPT_READ_ONLY" })
    expect(host.fake.requests.slice(before).map((request) => `${request.method} ${request.path} ${request.authorized}`)).toEqual(["GET /repos/octo/hello true"])
  })

  test("refuses an agent that denies GitHub, for both kinds of method, before anything is called", async () => {
    const sessionID = await session(host, "locked")
    const before = host.fake.requests.length
    expect(await script(host, "get_me", { sessionID, input: {} })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(await script(host, "api", { sessionID, input: { method: "GET", path: "/repos/octo/hello" } })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(host.fake.requests.slice(before)).toEqual([])
  })
})

describe("a github server the user already configured", () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ config: (origin) => ({ mcp: { servers: { github: { type: "remote", url: `${origin}/user-mcp/` } } } }) })
  })
  afterAll(() => host?.close())

  test("is left unchanged, keeps OpenCode's own sign-in, and status reports the conflict", async () => {
    const id = await integrationID(host)
    await until("OpenCode has contacted the user's server", async () => host.fake.requests.some((request) => request.path === "/user-mcp/"))
    const fromRpc = await until("status reports the conflict", async () => {
      const value = await status(host)
      return value.state === "conflict" && value
    })
    expect(fromRpc.nextStep).toContain("defines its own MCP server named github")
    expect(mcpRequests(host)).toEqual([])
    expect(host.fake.requests.filter((request) => request.path === "/user-mcp/").every((request) => request.toolsets === undefined && request.readonly === undefined)).toBe(true)
    const { data } = await host.client.integration.get({ integrationID: id, location: host.location })
    expect(data.name).toBe("github")
    expect(data.methods.map((method) => (method.type === "oauth" ? method.id : method.type))).toEqual([id])
  })

  test("is never called by a script", async () => {
    const before = host.fake.requests.length
    expect(await script(host, "get_me", { sessionID: await session(host), input: {} })).toMatchObject({ type: "failed", code: "SERVER_CONFLICT" })
    expect(host.fake.requests.slice(before).filter((request) => request.rpc === "tools/call")).toEqual([])
  })
})

describe("an untested OpenCode release", () => {
  test("2.3.0 refuses to load the plugin and says how to override", async () => {
    const host = await startHost({ version: "2.3.0" })
    try {
      const state = await pluginState(host)
      expect(state?.status).toBe("failed")
      const error = state?.status === "failed" ? state.error : ""
      expect(error).toStartWith(
        "GitHubPluginError: HOST_UNTESTED: OpenCode 2.3.0 is not a tested host for this plugin (tested: >=2.2.3 <2.3.0). Next step: Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.",
      )
      expect(await githubServer(host)).toBeUndefined()
    } finally {
      await host.close()
    }
  })

  test("2.3.0 with allowUntestedHost loads the plugin, and status warns", async () => {
    const host = await startHost({ version: "2.3.0", options: { allowUntestedHost: true } })
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      expect((await status(host)).host.warning).toBe(
        "OpenCode 2.3.0 is not a tested host for this plugin (tested: >=2.2.3 <2.3.0). It loaded because allowUntestedHost is set.",
      )
      expect(await statusCommand(host, await session(host))).toContain("OpenCode: 2.3.0 (untested: OpenCode 2.3.0 is not a tested host")
    } finally {
      await host.close()
    }
  })
})

describe("unloading the plugin", () => {
  let host: Host
  beforeAll(async () => {
    // Registered with the SDK (default options), so another plugin with its ID replaces it.
    host = await startHost({ load: "sdk" })
    await ownMethods(host, ["github-token"])
    await signInWithToken(host)
    await connected(host)
    await tool(host, "github_get_me")
  })
  afterAll(() => host?.close())

  test("removes its server, tools, rules, command, skills and RPC handler, and stops its work", async () => {
    await host.client.plugin(Plugin.define({ id: "github.platform", setup: () => {} }))
    await until("the github server and its tools are gone", async () => (await githubServer(host)) === undefined && (await toolIDs(host)).length === 0)
    const before = host.fake.requests.length
    const rules = await agentRules(host)
    for (const id of BUILT_IN) expect(rules.get(id)!.some((rule) => rule.action.startsWith("github_"))).toBe(false)
    const { data: commands } = await host.client.command.list({ location: host.location })
    expect(commands.some((command) => command.name.startsWith("github"))).toBe(false)
    const { data: skills } = await host.client.skill.list({ location: host.location })
    expect(skills.some((skill) => (skill.id as string).startsWith("github"))).toBe(false)
    await expect(status(host)).rejects.toBeDefined()
    // Nothing the plugin started, such as the sign-in check, reaches GitHub after cleanup.
    await Bun.sleep(1_000)
    expect(host.fake.requests.slice(before)).toEqual([])
  })
})
