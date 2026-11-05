// A loopback fake of the GitHub endpoints the plugin and the host use: GitHub's MCP server
// (Streamable HTTP, JSON responses), the device-flow endpoints and GET /user. It accepts only
// the fixture tokens below and records each request's method, path, JSON-RPC method, tool,
// MCP headers and whether Authorization was present, never a token value. A tools/call answers
// with the tool and its arguments as structured content, or, for a `query` argument that starts
// with "fail", with an upstream error (`isError`) whose first line holds a signed URL.

export const FIXTURE_PAT = `github_pat_${"x".repeat(40)}`
const FIXTURE_DEVICE_TOKEN = `gho_${"d".repeat(36)}`
export const PAT_LOGIN = "fixture"
export const DEVICE_LOGIN = "fixture-device"
export const USER_CODE = "WDJB-MJHT"
/** Text in every tools/call result, so a test can check that output never shows response content. */
export const CONTENT_MARKER = "fake-response-content"
/** The upstream error a "fail" query gets: two lines, the first with a signed URL. */
export const UPSTREAM_FAILURE = "Validation failed for https://objects.example.invalid/log.txt?X-Amz-Signature=fake-signature-123\nstack: second line"

/** Each fake tool's input schema. */
export const FAKE_INPUT = { type: "object", properties: { query: { type: "string" } } } as const

export type FakeTool = { readonly name: string; readonly readOnly: boolean }

/** Catalogued reads, catalogued writes, and one tool the plugin's catalog does not know. */
const FAKE_TOOLS: readonly FakeTool[] = [
  { name: "get_me", readOnly: true },
  { name: "issue_read", readOnly: true },
  { name: "issue_write", readOnly: false },
  { name: "create_pull_request", readOnly: false },
  { name: "brand_new_tool", readOnly: true },
]

interface FakeRequest {
  readonly method: string
  readonly path: string
  readonly authorized: boolean
  readonly rpc?: string
  readonly tool?: string
  readonly toolsets?: string
  readonly readonly?: string
  readonly lockdown?: string
  readonly toolsHeader?: boolean
  readonly clientId?: string
  readonly scope?: string
  readonly clientSecret?: boolean
}

export interface FakeGitHub {
  readonly origin: string
  readonly requests: FakeRequest[]
  /** Tool names called through MCP tools/call, in order. */
  calls(): string[]
  /** From now on GitHub rejects every token, as after a revocation. */
  revoke(): void
  close(): Promise<void>
}

type Message = {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
}

const loginFor = (authorization: string | null, revoked = false) => {
  if (revoked) return undefined
  const token = authorization?.replace(/^Bearer\s+/i, "")
  if (token === FIXTURE_PAT) return PAT_LOGIN
  if (token === FIXTURE_DEVICE_TOKEN) return DEVICE_LOGIN
  return undefined
}

export function startFakeGitHub(tools: readonly FakeTool[] = FAKE_TOOLS): FakeGitHub {
  const requests: FakeRequest[] = []
  let polls = 0
  let revoked = false

  const mcp = async (request: Request, path: string): Promise<Response> => {
    const login = loginFor(request.headers.get("authorization"), revoked)
    const body = request.method === "POST" ? ((await request.json().catch(() => undefined)) as Message | Message[] | undefined) : undefined
    const messages = body === undefined ? [] : Array.isArray(body) ? body : [body]
    const headers = {
      toolsets: request.headers.get("x-mcp-toolsets") ?? undefined,
      readonly: request.headers.get("x-mcp-readonly") ?? undefined,
      lockdown: request.headers.get("x-mcp-lockdown") ?? undefined,
      toolsHeader: request.headers.has("x-mcp-tools"),
    }
    const base = { method: request.method, path, authorized: login !== undefined, ...headers }
    if (messages.length === 0) requests.push(base)
    for (const message of messages) requests.push({ ...base, rpc: message.method, ...(message.params?.name ? { tool: message.params.name } : {}) })

    // Like GitHub: no token, no MCP. OpenCode then reports the server as needing sign-in.
    if (!login) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_request"' } })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
    // JSON-RPC ids can be 0; only a missing or null id makes a notification.
    const replies = messages.filter((message) => message.id !== undefined && message.id !== null).map((message) => answer(message, tools, headers.readonly === "true", login))
    if (replies.length === 0) return new Response(null, { status: 202 })
    return Response.json(Array.isArray(body) ? replies : replies[0], { headers: { "mcp-session-id": "fake-session" } })
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      // A GitHub Enterprise Server serves the REST API under /api/v3.
      const path = url.pathname.replace(/^\/api\/v3(?=\/)/, "")
      if (path.startsWith("/mcp") || path.startsWith("/user-mcp")) return mcp(request, path)
      if (path === "/login/device/code" && request.method === "POST") {
        const form = new URLSearchParams(await request.text())
        requests.push({ method: request.method, path, authorized: false, clientId: form.get("client_id") ?? "", scope: form.get("scope") ?? "", clientSecret: form.has("client_secret") })
        // A fractional interval keeps the test fast; GitHub sends whole seconds.
        return Response.json({ device_code: "fixture-device-code", user_code: USER_CODE, verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0.1 })
      }
      if (path === "/login/oauth/access_token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text())
        requests.push({ method: request.method, path, authorized: false, clientId: form.get("client_id") ?? "", clientSecret: form.has("client_secret") })
        if (++polls < 2) return Response.json({ error: "authorization_pending" })
        return Response.json({ access_token: FIXTURE_DEVICE_TOKEN, token_type: "bearer", scope: "repo,read:org" })
      }
      const login = loginFor(request.headers.get("authorization"), revoked)
      requests.push({ method: request.method, path, authorized: login !== undefined })
      if (path === "/user" && request.method === "GET") {
        return login ? Response.json({ login, id: 1 }) : Response.json({ message: "Bad credentials" }, { status: 401 })
      }
      // GitHub's REST API for github_api: any repository path answers, writes with 201.
      if (path.startsWith("/repos/")) {
        if (!login) return Response.json({ message: "Bad credentials" }, { status: 401 })
        return request.method === "GET" ? Response.json({ full_name: path.split("/").slice(2, 4).join("/") }) : Response.json({ id: 1 }, { status: 201 })
      }
      // OAuth discovery and everything else.
      return Response.json({ message: "Not Found" }, { status: 404 })
    },
  })

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    calls: () => requests.filter((request) => request.rpc === "tools/call").map((request) => request.tool ?? ""),
    revoke: () => {
      revoked = true
    },
    close: () => server.stop(true),
  }
}

function answer(message: Message, tools: readonly FakeTool[], readOnly: boolean, login: string) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-github", version: "0.0.0" },
      })
    case "tools/list":
      // Like GitHub with X-MCP-Readonly: true, write tools are not offered.
      return reply({
        tools: tools.filter((tool) => !readOnly || tool.readOnly).map((tool) => ({
          name: tool.name,
          description: `Fake ${tool.name}`,
          inputSchema: FAKE_INPUT,
          annotations: { readOnlyHint: tool.readOnly },
        })),
      })
    case "tools/call": {
      const args = message.params?.arguments ?? {}
      if (String(args["query"] ?? "").startsWith("fail")) return reply({ content: [{ type: "text", text: UPSTREAM_FAILURE }], isError: true })
      return reply({
        content: [{ type: "text", text: JSON.stringify({ tool: message.params?.name, login, body: CONTENT_MARKER }) }],
        structuredContent: { tool: message.params?.name, arguments: args },
      })
    }
    case "ping":
      return reply({})
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }
  }
}
