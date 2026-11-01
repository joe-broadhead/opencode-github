import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { API_ACTION, type ApiDeps, registerApiTool } from "../../src/api/tool.js"
import { GITHUB_COM } from "../../src/config.js"

type Ctx = Parameters<typeof registerApiTool>[0]
const ID = "mcp_0123456789abcdef"
const TOKEN = "gho_" + "t".repeat(36)
const CALL = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "github-api-tool-")))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function setUp(input: { readOnly?: boolean; signedIn?: boolean; decline?: boolean; status?: number } = {}) {
  const asserts: Array<Record<string, unknown>> = []
  const statuses: unknown[] = []
  const requests: Array<{ url: string; method: string }> = []
  let tool: { execute: (input: unknown, context: unknown) => Promise<{ output: any; content: string }>; options: Record<string, unknown>; name: string } | undefined
  let reported: unknown
  const ctx = {
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (value: typeof tool) => (tool = value) })
        return { dispose: async () => {} }
      },
    },
    permission: {
      assert: async (request: Record<string, unknown>) => {
        asserts.push(request)
        if (input.decline) throw new Error("declined")
      },
    },
    integration: {
      connection: {
        active: async () =>
          input.signedIn === false ? undefined : { type: "credential", id: "cred_1", label: "octocat", method: "oauth", ...(reported ? { status: reported } : {}) },
        resolve: async () => ({ type: "oauth", methodID: "github-token", access: TOKEN, refresh: "", expires: 0 }),
        status: async (value: { status: unknown }) => {
          statuses.push(value.status)
          reported = value.status
        },
      },
    },
  } as unknown as Ctx
  const deps: ApiDeps = {
    readOnly: input.readOnly ?? false,
    endpoints: GITHUB_COM,
    service: "GitHub",
    root,
    integrationID: () => ID,
    fetch: async (url, init) => {
      requests.push({ url, method: init.method ?? "GET" })
      const status = input.status ?? 200
      return new Response(JSON.stringify(status === 401 ? { message: "Bad credentials" } : { ok: 1 }), { status, headers: { "content-type": "application/json" } })
    },
  }
  return {
    ready: registerApiTool(ctx, deps),
    asserts,
    statuses,
    requests,
    run: async (value: unknown) => {
      await registerApiTool(ctx, deps)
      return tool!.execute(value, { ...CALL, signal: AbortSignal.timeout(5000) })
    },
    tool: () => tool!,
  }
}

const message = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: Error) => error.message)

describe("github_api", () => {
  it("registers as github_api: Code Mode in the github namespace, pinned, with its own permission action", async () => {
    const api = setUp()
    await api.ready
    expect(api.tool().name).toBe("api")
    expect(api.tool().options).toEqual({ namespace: "github", permission: API_ACTION, codemode: true, pinned: true })
  })

  it("runs reads without asking: GET, HEAD and a single GraphQL query", async () => {
    const api = setUp({ readOnly: true })
    expect((await api.run({ method: "GET", path: "/user" })).output).toMatchObject({ ok: true, status: 200, data: { ok: 1 } })
    await api.run({ method: "HEAD", path: "/user" })
    await api.run({ graphql: { query: "query { viewer { login } }" } })
    expect(api.asserts).toEqual([])
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.github.com/user",
      "HEAD https://api.github.com/user",
      "POST https://api.github.com/graphql",
    ])
  })

  it("asks before a write, as github_api on METHOD /path, saving that exact resource", async () => {
    const api = setUp()
    await api.run({ method: "POST", path: "/repos/o/r/releases?x=1", body: { tag_name: "v1", body: "secret-ish text" } })
    expect(api.asserts).toEqual([
      {
        sessionID: "ses_1",
        agent: "build",
        action: "github_api",
        resources: ["POST /repos/o/r/releases"],
        save: ["POST /repos/o/r/releases"],
        metadata: { method: "POST", path: "/repos/o/r/releases", body: { keys: ["tag_name", "body"], bytes: 42 } },
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
      },
    ])
    expect(JSON.stringify(api.asserts)).not.toContain("secret-ish")
  })

  it("asks before a GraphQL mutation as POST /graphql, naming its fields", async () => {
    const api = setUp()
    await api.run({ graphql: { query: "mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }" } })
    expect(api.asserts[0]).toMatchObject({ resources: ["POST /graphql"], metadata: { graphql: [{ type: "mutation", fields: ["enablePullRequestAutoMerge"] }] } })
  })

  it("sends nothing when the user declines", async () => {
    const api = setUp({ decline: true })
    expect(await message(api.run({ method: "DELETE", path: "/repos/o/r" }))).toBe("declined")
    expect(api.requests).toEqual([])
  })

  it("refuses writes while read-only, without asking", async () => {
    const api = setUp({ readOnly: true })
    for (const input of [{ method: "PATCH", path: "/repos/o/r" }, { graphql: { query: "mutation { addStar(input: {}) { clientMutationId } }" } }]) {
      expect(await message(api.run(input))).toMatch(/^READ_ONLY: .* changes GitHub, and the plugin is read-only\. Next step: Set the plugin option readOnly: false/)
    }
    expect(api.asserts).toEqual([])
    expect(api.requests).toEqual([])
  })

  it("asks before saving a download, with the file as the resource, even while read-only", async () => {
    const api = setUp({ readOnly: true })
    await api.run({ method: "GET", path: "/repos/o/r/zipball", download: { path: "out/r.zip" } })
    expect(api.asserts).toEqual([expect.objectContaining({ action: "github_api", resources: ["download out/r.zip"], save: ["download out/r.zip"] })])
  })

  it("refuses bad input with a coded error and sends nothing", async () => {
    const api = setUp()
    for (const [input, code] of [
      [{ method: "GET", path: "https://evil.example/x" }, "API_PATH_INVALID"],
      [{ method: "POST", path: "/graphql", body: { query: "{ x }" } }, "API_GRAPHQL_PATH"],
      [{ method: "POST", path: "/x", download: { path: "a" } }, "API_INPUT_INVALID"],
      [{ method: "GET", path: "/x", upload: { path: "a", contentType: "text/plain" } }, "API_INPUT_INVALID"],
      [{ method: "TRACE", path: "/x" }, "API_INPUT_INVALID"],
    ] as const) {
      expect(await message(api.run(input))).toMatch(new RegExp(`^${code}: .* Next step: `))
    }
    expect(api.requests).toEqual([])
  })

  it("needs a sign-in", async () => {
    const api = setUp({ signedIn: false })
    expect(await message(api.run({ method: "GET", path: "/user" }))).toBe("AUTH_REQUIRED: GitHub is not signed in. Next step: Run /connect and choose GitHub.")
  })

  it("marks the account for sign-in on a 401, and never shows the token", async () => {
    const api = setUp({ status: 401 })
    const result = await api.run({ method: "GET", path: "/user" })
    expect(api.statuses).toEqual([{ status: "needs_auth", message: "GitHub rejected the saved sign-in. Sign in again." }])
    expect(result.content).not.toContain(TOKEN)
    expect(JSON.stringify(result.output)).not.toContain(TOKEN)
  })
})
