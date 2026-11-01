// npm run drift against a recorded fake catalog. GitHub's MCP server is a loopback fake that
// serves the catalog with three recorded changes. Like GitHub, it requires the session ID it
// issued; it answers some toolsets in JSON and others in SSE, and pages one. The script runs
// unchanged under Node, with route-preload.mjs sending GitHub's URL to the fake.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { KNOWN_TOOLS } from "../../src/tools.js"

// Each run starts Node and opens one MCP session per toolset; slow on a busy machine.
setDefaultTimeout(180_000)

const REPO = fileURLToPath(new URL("../../", import.meta.url))
const PRELOAD = fileURLToPath(new URL("./route-preload.mjs", import.meta.url))
const TOKEN = "drift-fixture-token"
const TOOLSETS = Object.keys(KNOWN_TOOLS) as (keyof typeof KNOWN_TOOLS)[]

/** The recorded changes: GitHub added a read, removed a tool and made a read a write. */
const ADDED = { toolset: "issues", name: "issue_summary_read" }
const REMOVED = { toolset: "repos", name: "get_tag" }
const RECLASSIFIED = { toolset: "pull_requests", name: "pull_request_read" }

function served(toolset: (typeof TOOLSETS)[number], drift: boolean) {
  const { read, write } = KNOWN_TOOLS[toolset]
  const tools = [...read.map((name) => ({ name, readOnly: true })), ...write.map((name) => ({ name, readOnly: false }))]
  if (!drift) return tools
  return [
    ...tools
      .filter((tool) => !(toolset === REMOVED.toolset && tool.name === REMOVED.name))
      .map((tool) => (toolset === RECLASSIFIED.toolset && tool.name === RECLASSIFIED.name ? { ...tool, readOnly: false } : tool)),
    ...(toolset === ADDED.toolset ? [{ name: ADDED.name, readOnly: true }] : []),
  ]
}

type Seen = { method: string; toolset: string; readonly?: string; authorized: boolean; session?: string; rpc?: string }

function startFake(options: { drift: boolean; status?: number }) {
  const seen: Seen[] = []
  let sessions = 0
  const reply = (toolset: string, id: unknown, result: unknown, headers: Record<string, string> = {}) => {
    const message = { jsonrpc: "2.0", id, result }
    if (TOOLSETS.indexOf(toolset as never) % 2 === 1) {
      return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { headers: { "content-type": "text/event-stream", ...headers } })
    }
    return Response.json(message, { headers })
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const toolset = request.headers.get("x-mcp-toolsets") ?? ""
      const session = request.headers.get("mcp-session-id") ?? undefined
      const body = request.method === "POST" ? ((await request.json()) as { id?: number; method: string; params?: { cursor?: string } }) : undefined
      const authorized = request.headers.get("authorization") === `Bearer ${TOKEN}`
      seen.push({ method: request.method, toolset, readonly: request.headers.get("x-mcp-readonly") ?? undefined, authorized, session, rpc: body?.method })
      if (options.status) return new Response("unavailable", { status: options.status })
      if (!authorized) return new Response("unauthorized", { status: 401 })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (body?.method === "initialize") {
        return reply(toolset, body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-github", version: "0" } }, { "mcp-session-id": `session-${++sessions}` })
      }
      if (!session) return new Response("missing Mcp-Session-Id", { status: 400 })
      if (body?.id === undefined) return new Response(null, { status: 202 })
      const tools = served(toolset as never, options.drift).map((tool) => ({
        name: tool.name,
        description: tool.name,
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: tool.readOnly },
      }))
      if (toolset !== "repos") return reply(toolset, body.id, { tools })
      const half = Math.ceil(tools.length / 2)
      return body.params?.cursor === "page-2" ? reply(toolset, body.id, { tools: tools.slice(half) }) : reply(toolset, body.id, { tools: tools.slice(0, half), nextCursor: "page-2" })
    },
  })
  return { origin: `http://127.0.0.1:${server.port}`, seen, close: () => server.stop(true) }
}

let fake: ReturnType<typeof startFake> | undefined
afterEach(() => fake?.close())

async function drift(env: Record<string, string>) {
  const child = Bun.spawn(["node", "--import", PRELOAD, "scripts/drift.mjs"], {
    cwd: REPO,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(`${stdout}${stderr}`).not.toContain(TOKEN)
  expect(stderr).not.toContain("EXTERNAL_FETCH_BLOCKED")
  return { code, stdout, stderr }
}

describe("npm run drift", () => {
  test("warns about each recorded change, and exits 0", async () => {
    fake = startFake({ drift: true })
    const { code, stdout, stderr } = await drift({ GITHUB_DRIFT_TOKEN: TOKEN, GITHUB_FAKE_ORIGIN: fake.origin })
    expect(code).toBe(0)
    expect(stdout).toBe(`Comparing ${TOOLSETS.length} toolsets in the catalog with https://api.githubcopilot.com/mcp/\n`)
    expect(stderr.trim().split("\n")).toEqual([
      "warning: issues: new tool issue_summary_read (read)",
      "warning: pull_requests: pull_request_read is now a write (catalogued as a read)",
      "warning: repos: get_tag is catalogued but GitHub no longer offers it",
      "3 difference(s). Update KNOWN_TOOLS in src/tools.ts, then run npm run drift again.",
    ])
    // One session per toolset, with writes listed, then closed; follow-ups carry the session ID.
    expect(fake.seen.filter((request) => request.rpc === "initialize").map((request) => request.toolset)).toEqual(TOOLSETS)
    expect(fake.seen.every((request) => request.authorized && request.readonly === "false")).toBe(true)
    expect(fake.seen.filter((request) => request.rpc !== "initialize").every((request) => request.session !== undefined)).toBe(true)
    expect(fake.seen.filter((request) => request.method === "DELETE")).toHaveLength(TOOLSETS.length)
    expect(fake.seen.filter((request) => request.toolset === "repos" && request.rpc === "tools/list")).toHaveLength(2)
  })

  test("says so when GitHub's tools match the catalog", async () => {
    fake = startFake({ drift: false })
    const { code, stdout, stderr } = await drift({ GITHUB_DRIFT_TOKEN: TOKEN, GITHUB_FAKE_ORIGIN: fake.origin })
    expect(code).toBe(0)
    expect(stdout).toEndWith("No drift: GitHub's tools match the catalog.\n")
    expect(stderr).toBe("")
  })

  test("exits 2 without a token, when GitHub refuses the token, and when GitHub fails", async () => {
    expect(await drift({})).toMatchObject({ code: 2, stderr: expect.stringContaining("GITHUB_DRIFT_TOKEN is not set.") })
    fake = startFake({ drift: false })
    expect(await drift({ GITHUB_DRIFT_TOKEN: "not-the-token", GITHUB_FAKE_ORIGIN: fake.origin })).toMatchObject({
      code: 2,
      stderr: "Drift check could not run: GitHub refused the token (HTTP 401). Check that it is valid and not blocked by an organization policy.\n",
    })
    fake.close()
    fake = startFake({ drift: false, status: 503 })
    expect(await drift({ GITHUB_DRIFT_TOKEN: TOKEN, GITHUB_FAKE_ORIGIN: fake.origin })).toMatchObject({
      code: 2,
      stderr: "Drift check could not run: GitHub's MCP server answered initialize with HTTP 503.\n",
    })
  })
})
