// GitHub's part of the tools RPC: its plugin block (the known reads, the next steps, its own errors) and the api
// method, which runs github_api's own spec for reads only. The shared module's own tests are in tools-rpc.test.ts.
import { describe, expect, it } from "vitest"
import { SCRIPT_API_METHOD, scriptApi } from "../../src/api/script.js"
import { API_ACTION, registerApiTool } from "../../src/api/tool.js"
import { DEFAULT_TOOLSETS, GITHUB_COM } from "../../src/config.js"
import { GitHubPluginError } from "../../src/errors.js"
import { KNOWN_READS, NEXT_STEPS, PLUGIN_ID, pluginError, registerToolsRpc, TOOLS_RPC_ID, type ToolCall } from "../../src/host/tools-rpc.js"
import { HIDDEN, KNOWN_TOOLS, allReadTools } from "../../src/tools.js"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
type Handler = (input: unknown, context: { signal: AbortSignal; error: (type: string, message: string, data: unknown) => unknown }) => Promise<any>

const TOKEN = "gho_" + "t".repeat(36)
const LOCATION = { directory: "/workspace" }
const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })
const BASE = [rule("*", "allow"), rule("github_*", "ask")]
const writes = Object.values(KNOWN_TOOLS).flatMap((toolset) => [...toolset.write] as string[])

/**
 * The tools RPC with the real github_api spec behind its api method, against fakes: GitHub's API answers every request
 * with 200 and records it, and the github server lists `listed` tools. Asserts and requests are recorded.
 */
async function setUp(
  input: {
    agents?: Record<string, Rule[]>
    listed?: string[]
    managed?: boolean
    servers?: { name: string; status: { status: string } }[]
    signedIn?: boolean
    /** GitHub's answer per URL; anything else is 200. */
    answers?: Record<string, () => Response>
    /** Asserts refused as the tools RPC's hook refuses an ask: a Tool.Error with the request as its cause. */
    refuse?: boolean
  } = {},
) {
  const agents = input.agents ?? { build: BASE }
  const requests: { url: string; method: string }[] = []
  const asserts: unknown[] = []
  const runs: ToolCall[] = []
  let contract: { methods: Record<string, { input: any; output: any }> } | undefined
  let handlers: Record<string, Handler> = {}
  const ctx = {
    location: LOCATION,
    rpc: {
      register: async (definition: typeof contract, registered: Record<string, Handler>) => {
        contract = definition
        handlers = registered
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: async () => ({ dispose: async () => {} }),
      assert: async (request: { action: string }) => {
        asserts.push(request)
        if (input.refuse) throw Object.assign(new Error("A script cannot answer an approval prompt."), { _tag: "Tool.Error", error: { request } })
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: sessionID.replace(/^ses_/, ""), location: LOCATION }),
    },
    agent: { get: async ({ agentID }: { agentID: string }) => ({ location: LOCATION, data: { id: agentID, permissions: agents[agentID] ?? [] } }) },
    tool: {
      list: async () =>
        (input.listed ?? []).map((name) => ({ id: `github_${name}`, name, description: name, input: { type: "object" }, execute: async () => ({ output: { name }, content: [{ type: "text", text: name }] }) })),
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: () => {}, namespace: () => {} })
        return { dispose: async () => {} }
      },
    },
    mcp: { list: async () => ({ data: input.servers ?? [{ name: "github", status: { status: "connected" } }] }) },
    integration: {
      connection: {
        active: async () => (input.signedIn === false ? undefined : { type: "credential", id: "cred_1", label: "octocat", method: "oauth" }),
        resolve: async () => ({ type: "oauth", methodID: "github-token", access: TOKEN, refresh: "", expires: 0 }),
        status: async () => {},
      },
    },
  }
  const api = await registerApiTool(ctx as never, {
    readOnly: false,
    endpoints: GITHUB_COM,
    service: "GitHub",
    toolsets: DEFAULT_TOOLSETS,
    root: "/workspace",
    integrationID: () => "mcp_github",
    fetch: async (url, init) => {
      requests.push({ url, method: init.method ?? "GET" })
      return input.answers?.[url]?.() ?? Response.json({ full_name: "octo/repo" })
    },
  })
  const spy = { ...api, run: (...[value, call, caller]: Parameters<typeof api.run>) => (runs.push(call as ToolCall), api.run(value, call, caller)) }
  await registerToolsRpc(ctx as never, { mcp: { server: "github", managed: () => input.managed ?? true }, owned: [scriptApi(spy, GITHUB_COM)] })
  const call = (method: string, value: unknown, agent = "build") =>
    handlers[method]!({ sessionID: `ses_${agent}`, input: value }, { signal: new AbortController().signal, error: (type, message, data) => ({ type, message, data }) })
  return { contract: contract!, handlers, call, requests, asserts, runs }
}

describe("GitHub's tools RPC", () => {
  it("is github.platform.tools", () => {
    expect(PLUGIN_ID).toBe("github.platform")
    expect(TOOLS_RPC_ID).toBe("github.platform.tools")
  })

  it("makes every known read of every toolset a method, and never ui_get, a write or an unknown tool", async () => {
    expect(KNOWN_READS).toEqual(allReadTools())
    expect(KNOWN_READS).toHaveLength(61)
    expect(KNOWN_READS).toContain("check_dependency_vulnerabilities")
    // QA GITHUB-8: github-mcp-server v2.1.0's issue artifact tools.
    expect(KNOWN_READS).toContain("issue_artifact_read")
    expect(writes).toContain("issue_artifact_write")
    const { contract } = await setUp({ listed: [...KNOWN_READS, ...writes, ...HIDDEN, "brand_new_tool"] })
    expect(Object.keys(contract.methods).sort()).toEqual(["describe", SCRIPT_API_METHOD, ...KNOWN_READS].sort())
    for (const excluded of [...writes, ...HIDDEN, "brand_new_tool"]) expect(contract.methods).not.toHaveProperty(excluded)
    expect(writes).toHaveLength(37)
  })

  it("gives every code a next step in GitHub's own words", () => {
    expect(NEXT_STEPS.AUTH_REQUIRED).toBe("Run /connect and choose GitHub.")
    expect(NEXT_STEPS.NOT_REGISTERED).toContain("call the api method")
    expect(NEXT_STEPS.TOOL_UNAVAILABLE).toContain("toolsets option")
    // QA LIVE-9: it names the toolsets that are off by default; GITHUB-R18: and where to read what else hides a method.
    expect(NEXT_STEPS.TOOL_UNAVAILABLE).toBe(
      "Add the method's toolset to the plugin's toolsets option and run opencode reload (off by default: copilot_spaces, gists, github_support_docs_search, governance, notifications, projects, stargazers); describe's detail names the method's toolset, or the feature flag that hides it.",
    )
  })

  it("maps the plugin's own errors to their code, what happened and the next step", () => {
    const error = new GitHubPluginError("API_PATH_INVALID", "The path is wrong.", "Pass a relative API path.")
    expect(pluginError(error)).toEqual({ code: "API_PATH_INVALID", what: "The path is wrong.", next: "Pass a relative API path." })
    expect(pluginError(new Error("other"))).toBeUndefined()
  })

  it("describes api as github_api for reads, with the read-only input schema", async () => {
    const { handlers } = await setUp()
    const description = await handlers["describe"]!({}, { signal: new AbortController().signal, error: () => undefined })
    const method = description.methods.find((entry: { name: string }) => entry.name === SCRIPT_API_METHOD)
    expect(method).toMatchObject({ tool: SCRIPT_API_METHOD, kind: "plugin", action: API_ACTION, available: true })
    const rest = method.input.anyOf[0]
    expect(rest.properties.method.enum).toEqual(["GET", "HEAD"])
    expect(Object.keys(rest.properties).sort()).toEqual(["accept", "maxItems", "maxPages", "method", "paginate", "path", "query"])
    expect(method.input.anyOf[1].properties).toHaveProperty("graphql")
  })

  it("describes api as unavailable without a GitHub sign-in, and a read then fails with AUTH_REQUIRED", async () => {
    const h = await setUp({ signedIn: false })
    const description = await h.handlers["describe"]!({}, { signal: new AbortController().signal, error: () => undefined })
    expect(description.methods.find((entry: { name: string }) => entry.name === SCRIPT_API_METHOD)).toMatchObject({ available: false, reason: "AUTH_REQUIRED" })
    expect(await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/user" })).toMatchObject({ type: "failed", data: { code: "AUTH_REQUIRED", next: "Run /connect and choose GitHub." } })
    expect(h.requests).toEqual([])
  })
})

describe("the api method", () => {
  it("runs a REST read through github_api's spec as the session, with no assert", async () => {
    const h = await setUp()
    const output = await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/repos/octo/repo", query: { per_page: 5 } })
    expect(output).toMatchObject({ ok: true, status: 200, data: { full_name: "octo/repo" }, trust: { githubContent: "untrusted" } })
    expect(h.requests).toEqual([{ url: "https://api.github.com/repos/octo/repo?per_page=5", method: "GET" }])
    expect(h.asserts).toEqual([])
    expect(h.runs).toEqual([expect.objectContaining({ sessionID: "ses_build", agent: "build", id: expect.stringMatching(/^script:/) })])
    expect(JSON.stringify(output)).not.toContain(TOKEN)
  })

  // it3: a read one of GitHub's tools covers names that tool; for a script it is a method of this RPC.
  it("names the method that covers a read in nextStep, and still answers", async () => {
    const h = await setUp()
    const output = await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/repos/octo/repo/pulls" })
    expect(output).toMatchObject({ ok: true, data: { full_name: "octo/repo" }, nextStep: "The list_pull_requests method covers this read: call it instead of api." })
    expect(h.requests).toHaveLength(1)
  })

  it("runs a single GraphQL query", async () => {
    const h = await setUp()
    expect(await h.call(SCRIPT_API_METHOD, { graphql: { query: "query { viewer { login } }" } })).toMatchObject({ ok: true })
    expect(h.requests).toEqual([{ url: "https://api.github.com/graphql", method: "POST" }])
  })

  it.each([
    ["a REST write", { method: "POST", path: "/repos/octo/repo/issues", body: { title: "x" } }, "POST /repos/octo/repo/issues changes GitHub"],
    ["a DELETE", { method: "DELETE", path: "/repos/octo/repo" }, "DELETE /repos/octo/repo changes GitHub"],
    ["a GraphQL mutation", { graphql: { query: "mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }" } }, "not a single query"],
    ["two GraphQL operations", { graphql: { query: "query A { viewer { login } } query B { viewer { id } }" } }, "not a single query"],
    ["a download", { method: "GET", path: "/repos/octo/repo/zipball", download: { path: "repo.zip" } }, "scripts never write files"],
    ["an upload", { method: "POST", path: "/repos/octo/repo/releases/1/assets", upload: { path: "a.zip", contentType: "application/zip" } }, "upload sends a file"],
    ["POST /markdown, a read with a body", { method: "POST", path: "/markdown", body: { text: "x" } }, "POST /markdown is not a GET or HEAD"],
  ])("refuses %s with SCRIPT_READ_ONLY before any request, even when the agent allows github_api", async (_name, input, what) => {
    const h = await setUp({ agents: { build: [...BASE, rule("github_api", "allow")] } })
    const result = await h.call(SCRIPT_API_METHOD, input)
    expect(result).toMatchObject({ type: "failed", data: { code: "SCRIPT_READ_ONLY", next: expect.stringContaining("GET, HEAD or a single GraphQL query") } })
    expect(result.message).toContain(what)
    expect(h.requests).toEqual([])
    expect(h.asserts).toEqual([])
  })

  // GITHUB-R2: a script's read follows a redirect within the API with no assert, as the model's does; never one off the API.
  it("follows a script's redirect within the API without an assert, and never one off the API", async () => {
    const answers = {
      "https://api.github.com/repos/Old/Name": () => new Response(null, { status: 301, headers: { location: "/repositories/10" } }),
      "https://api.github.com/repos/o/r/actions/jobs/1/logs": () => new Response(null, { status: 302, headers: { location: "https://blob.example.net/l?sig=x" } }),
    }
    const h = await setUp({ answers, refuse: true })
    expect(await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/repos/Old/Name" })).toMatchObject({ ok: true })
    expect(h.asserts).toEqual([])
    expect(h.requests.map((request) => request.url)).toEqual(["https://api.github.com/repos/Old/Name", "https://api.github.com/repositories/10"])
    expect(await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/repos/o/r/actions/jobs/1/logs" })).toMatchObject({
      type: "failed",
      data: { code: "API_REDIRECT_OFF_HOST", next: "For job logs, call the get_job_logs method; other files need github_api's download in an OpenCode session." },
    })
  })

  it("refuses a read with a body, and an input github_api would not take, as API_INPUT_INVALID", async () => {
    const h = await setUp()
    expect(await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/repos/octo/repo", body: {} })).toMatchObject({ type: "failed", data: { code: "API_INPUT_INVALID" } })
    expect(await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/repos/octo/repo", extra: 1 })).toMatchObject({ type: "failed", data: { code: "API_INPUT_INVALID" } })
    expect(await h.call(SCRIPT_API_METHOD, { method: "GET", path: "https://example.com/x" })).toMatchObject({ type: "failed", data: { code: "API_PATH_INVALID" } })
    expect(h.requests).toEqual([])
  })

  it("is refused when a deny rule hides github_api from the agent, before any request", async () => {
    const h = await setUp({ agents: { build: BASE, locked: [...BASE, rule("github_*", "deny")], narrow: [...BASE, rule("github_api", "deny")] } })
    for (const agent of ["locked", "narrow"]) {
      expect(await h.call(SCRIPT_API_METHOD, { method: "GET", path: "/repos/octo/repo" }, agent)).toMatchObject({ type: "failed", data: { code: "PERMISSION_DENIED" } })
    }
    expect(h.requests).toEqual([])
  })
})

describe("the MCP methods", () => {
  it("call the github server's tool while the plugin manages it", async () => {
    const h = await setUp({ listed: ["get_me"] })
    expect(await h.call("get_me", {})).toEqual({ output: { name: "get_me" }, text: "get_me" })
  })

  it("are unavailable while a toolset is off, and with host, where there is no github server", async () => {
    const off = await setUp({ listed: [] })
    expect(await off.call("list_gists", {})).toMatchObject({ type: "failed", data: { code: "TOOL_UNAVAILABLE" } })
    const enterprise = await setUp({ servers: [] })
    expect(await enterprise.call("get_me", {})).toMatchObject({ type: "failed", data: { code: "NOT_REGISTERED", next: NEXT_STEPS.NOT_REGISTERED } })
  })

  it("never call a server named github that the plugin does not manage", async () => {
    const h = await setUp({ listed: ["get_me"], managed: false })
    expect(await h.call("get_me", {})).toMatchObject({ type: "failed", data: { code: "SERVER_CONFLICT" } })
  })
})
