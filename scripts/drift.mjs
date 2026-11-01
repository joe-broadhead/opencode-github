// Maintainer-run drift check (Node): compares GitHub's live MCP tools with the catalog in
// src/tools.ts and warns about changes. It changes nothing, and it
// is not a runtime check: unknown tools ask by default whatever it reports.
//   GITHUB_DRIFT_TOKEN=<token> npm run drift
// For each catalogued toolset it opens an MCP session with X-MCP-Toolsets: <toolset> and
// X-MCP-Readonly: false, lists the tools (JSON or SSE responses, following nextCursor) and
// reports tools that are new, catalogued but missing, or whose readOnlyHint disagrees with
// the catalog. The token is never printed.
// Exit codes: 0 the comparison completed, with or without drift; 2 no token, or GitHub could
// not be reached or refused the token.
import { loadSource } from "./source.mjs"

const { MCP_URL } = await loadSource("config.ts")
const { KNOWN_TOOLS } = await loadSource("tools.ts")

const PROTOCOL_VERSION = "2025-06-18"
const TIMEOUT_MS = 30_000

/** A network or sign-in failure: the comparison could not run. */
class Unreachable extends Error {}

const token = process.env.GITHUB_DRIFT_TOKEN
if (!token) {
  console.error("GITHUB_DRIFT_TOKEN is not set. Use a GitHub token that can read any repository, then run: GITHUB_DRIFT_TOKEN=<token> npm run drift")
  process.exit(2)
}

async function send(session, method, message) {
  let response
  try {
    response = await fetch(MCP_URL, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "X-MCP-Toolsets": session.toolset,
        "X-MCP-Readonly": "false",
        ...(message ? { "Content-Type": "application/json" } : {}),
        ...(session.id ? { "Mcp-Session-Id": session.id } : {}),
        ...(session.protocol ? { "MCP-Protocol-Version": session.protocol } : {}),
      },
      ...(message ? { body: JSON.stringify(message) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Unreachable(`Could not reach ${new URL(MCP_URL).host}: ${error instanceof Error ? error.message : error}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new Unreachable(`GitHub refused the token (HTTP ${response.status}). Check that it is valid and not blocked by an organization policy.`)
  }
  return response
}

/** A server error stops the check; any other refusal is reported for that toolset. */
function refused(response, method) {
  const message = `GitHub's MCP server answered ${method} with HTTP ${response.status}.`
  return response.status >= 500 ? new Unreachable(message) : new Error(message)
}

/** Sends a JSON-RPC request and returns its result from a JSON or SSE response. */
async function request(session, id, method, params) {
  const response = await send(session, "POST", { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
  if (!response.ok) throw refused(response, method)
  session.id ??= response.headers.get("mcp-session-id") ?? undefined
  const type = response.headers.get("content-type") ?? ""
  const text = await response.text()
  const messages = type.includes("text/event-stream") ? events(text) : [JSON.parse(text)].flat()
  const reply = messages.find((message) => message?.id === id)
  if (!reply) throw new Unreachable(`GitHub's MCP server sent no answer to ${method}.`)
  if (reply.error) throw new Error(`${method} failed: ${reply.error.message ?? "unknown error"}`)
  return reply.result
}

function events(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data))
}

/** The live tools for one toolset, by name, with whether GitHub marks each read-only. */
async function liveTools(toolset) {
  const session = { toolset, id: undefined, protocol: undefined }
  const initialized = await request(session, 0, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "opencode-github-drift", version: "0" },
  })
  session.protocol = initialized?.protocolVersion ?? PROTOCOL_VERSION
  const notified = await send(session, "POST", { jsonrpc: "2.0", method: "notifications/initialized" })
  if (!notified.ok) throw refused(notified, "notifications/initialized")
  const tools = new Map()
  try {
    let cursor
    let id = 1
    do {
      const page = await request(session, id++, "tools/list", cursor ? { cursor } : undefined)
      for (const tool of page?.tools ?? []) tools.set(tool.name, tool.annotations?.readOnlyHint === true)
      cursor = page?.nextCursor
    } while (cursor)
  } finally {
    if (session.id) await send(session, "DELETE").catch(() => undefined)
  }
  return tools
}

function compare(toolset, live, findings) {
  const known = KNOWN_TOOLS[toolset]
  const catalogued = new Map([...known.read.map((name) => [name, true]), ...known.write.map((name) => [name, false])])
  for (const [name, readOnly] of live) {
    const kind = readOnly ? "read" : "write"
    if (!catalogued.has(name)) {
      // A catalogued tool that GitHub also serves with this toolset is not new.
      const elsewhere = Object.values(KNOWN_TOOLS).some((other) => other.read.includes(name) || other.write.includes(name))
      if (!elsewhere) findings.push(`${toolset}: new tool ${name} (${kind})`)
    } else if (catalogued.get(name) !== readOnly) {
      findings.push(`${toolset}: ${name} is now a ${kind} (catalogued as a ${readOnly ? "write" : "read"})`)
    }
  }
  for (const name of catalogued.keys()) if (!live.has(name)) findings.push(`${toolset}: ${name} is catalogued but GitHub no longer offers it`)
}

const toolsets = Object.keys(KNOWN_TOOLS)
console.log(`Comparing ${toolsets.length} toolsets in the catalog with ${MCP_URL}`)
const findings = []
try {
  for (const toolset of toolsets) {
    let live
    try {
      live = await liveTools(toolset)
    } catch (error) {
      if (error instanceof Unreachable) throw error
      findings.push(`${toolset}: GitHub returned an error: ${error instanceof Error ? error.message : error}`)
      continue
    }
    compare(toolset, live, findings)
  }
} catch (error) {
  console.error(`Drift check could not run: ${error instanceof Error ? error.message : error}`)
  process.exit(2)
}

if (findings.length === 0) {
  console.log("No drift: GitHub's tools match the catalog.")
} else {
  for (const finding of findings) console.warn(`warning: ${finding}`)
  console.warn(`${findings.length} difference(s). Update KNOWN_TOOLS in src/tools.ts, then run npm run drift again.`)
}
