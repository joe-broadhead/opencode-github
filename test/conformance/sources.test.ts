// The source contract's conformance kit over the source this plugin declares in package.json's `sources`, run on the
// plugin's own events_list and probe methods against recorded GitHub answers (test/fixtures/sources.json, all
// invented): no GitHub call, no sign-in. Every GET goes through github_api's real spec, as a script call in a session
// whose rules are exactly what a consumer's fenced session holds (the package's `sessionRules` and `probeRules`), and
// asserts on the kit's recording permission, so the kit sees exactly what each read asserts. The report is written to
// reports/conformance-report.json, for a release to attach.
import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { declarationProblems, sourceConformance, type ConformanceReport, type PageCase, type SessionContext } from "@we-the-rebel-alliance/source-contract/conformance"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { probeRules, sessionRules } from "@we-the-rebel-alliance/source-contract/permission"
import { SOURCES_SCHEMA, type Sources } from "@we-the-rebel-alliance/source-contract/schema"
import type { ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { registerApiTool } from "../../src/api/tool.js"
import { DEFAULT_TOOLSETS, GITHUB_COM } from "../../src/config.js"
import { NAMESPACE, PACKAGE, SOURCE, eventsMethod, probeMethod } from "../../src/source-events.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; sources: unknown; jelly: { tools: { name: string; readOnly: boolean }[] } }
/** The declaration as Memory's schema parses it, which is what the kit takes (source-contract#30, item 8). */
const checked = SOURCES_SCHEMA.check(pkg.sources)
if (!checked.ok) throw new Error(`the sources declaration is invalid: ${checked.problems.join("; ")}`)
const sources: Sources = checked.value
const source = sources.items.find((item) => item.id === `${NAMESPACE}.activity`)!
const tools = pkg.jelly.tools.map((tool) => ({ id: tool.name.replace(/^github\./, ""), readOnly: tool.readOnly }))
const GITHUB = JSON.parse(readFileSync(join(root, "test/fixtures/sources.json"), "utf8")) as Record<string, any>

const NOW = Date.parse("2026-11-08T12:00:00Z")
const SINCE = "2026-11-01T00:00:00Z"
const LOGIN: string = GITHUB["user"].login
const ACCOUNT = LOGIN.toLowerCase()
/** Each read is one GitHub page in one call, so no single event can fail on its own. */
const ATOMIC = "GitHub answers each search and notifications read as one page in one call, so no single event can fail on its own"
const TOKEN = "gho_" + "t".repeat(36)

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/** GitHub's REST answers from the recorded data: searches by their qualifier, oldest first, paged; notifications newest first. */
function answer(url: URL): Response {
  const query = url.searchParams
  const page = Number(query.get("page") ?? 1)
  const per = Number(query.get("per_page") ?? 30)
  const qualifier = (name: string) => new RegExp(`${name}:>=(\\S+)`).exec(query.get("q") ?? "")?.[1]
  const paged = (all: unknown[]) => json({ total_count: all.length, incomplete_results: false, items: all.slice((page - 1) * per, page * per) })
  switch (url.pathname) {
    case "/user":
      return json(GITHUB["user"])
    case "/search/issues": {
      if (!(query.get("q") ?? "").includes(`involves:${LOGIN}`)) return json({ total_count: 0, incomplete_results: false, items: [] })
      // A GitHub App user token gets 422 for a search of issues and pull requests together.
      const kind = /(?:^|\s)is:(issue|pull-request)(?:\s|$)/.exec(query.get("q") ?? "")?.[1]
      if (kind === undefined) return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })
      const from = Date.parse(qualifier("updated")!)
      return paged(
        (GITHUB["issues"] as { updated_at: string }[])
          .filter((item) => Date.parse(item.updated_at) >= from && ("pull_request" in item) === (kind === "pull-request"))
          .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at)),
      )
    }
    case "/search/commits": {
      const from = Date.parse(qualifier("committer-date")!)
      return paged((GITHUB["commits"] as { commit: { committer: { date: string } } }[]).filter((item) => Date.parse(item.commit.committer.date) >= from))
    }
    case "/notifications": {
      const since = Date.parse(query.get("since")!)
      const all = (GITHUB["notifications"] as { updated_at: string }[]).filter((item) => Date.parse(item.updated_at) >= since)
      return json(all.slice((page - 1) * per, page * per))
    }
    default:
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
  }
}

/**
 * The plugin's methods over github_api's real spec. The script session's rules are the fenced session's, from the
 * declaration; each request's assert goes to the kit's recording permission, as OpenCode's would.
 */
async function methods(context: SessionContext) {
  const listing = sessionRules(source as never, { source: source.id, account: ACCOUNT })
  const probing = probeRules(source as never, ACCOUNT, [], sources.probe?.action)
  if (!listing.ok || !probing.ok) throw new Error("the declaration derives no session rules")
  const rules = [...listing.value, ...probing.value.slice(1)]
  const ctx = {
    tool: { transform: async () => ({ dispose: async () => {} }) },
    permission: context.permission,
    integration: {
      get: async () => ({ data: { connections: [] } }),
      connection: {
        active: async () => ({ type: "credential", id: "cred_conformance", label: LOGIN, method: "oauth" }),
        resolve: async () => ({ type: "oauth", access: TOKEN, refresh: "", expires: 0, metadata: { login: LOGIN } }),
        status: async () => {},
      },
    },
    session: { get: async () => ({ permissions: rules }) },
    agent: { get: async () => ({ data: { permissions: [] } }) },
  }
  const api = await registerApiTool(ctx as never, {
    access: "all",
    readOnly: false,
    endpoints: GITHUB_COM,
    service: "GitHub",
    root,
    toolsets: DEFAULT_TOOLSETS,
    integrationID: () => "mcp_github",
    fetch: async (url) => answer(new URL(url)),
  })
  const deps = { ctx: { permission: context.permission as never }, api, identity: () => api.identity(), now: () => NOW }
  return { events: eventsMethod(deps), probe: probeMethod(deps) }
}

const call = (): ToolCall => ({ sessionID: "ses_conformance", agent: "build", messageID: "msg_script", id: `script:${Math.random()}`, signal: new AbortController().signal, progress: async () => {} })
const open: SessionContext = { account: ACCOUNT, permission: { assert: async () => {} } }
const list = async (input: Record<string, unknown>, context: SessionContext = open) => (await methods(context)).events.run(input, call()) as Promise<Record<string, any>>

async function cases(): Promise<PageCase[]> {
  const first = (await list({ source: SOURCE, account: ACCOUNT, since: SINCE, limit: 2 }))["cursor"] as string
  const done = (await list({ source: SOURCE, account: ACCOUNT, cursor: first, limit: 500 }))["cursor"] as string
  const state = JSON.parse(Buffer.from(first, "base64url").toString("utf8")) as Record<string, unknown>
  const { v: _v, s: _s, b: _b, ...positions } = state
  return [
    { name: "a first listing, one commit refused for a secret", input: { source: SOURCE, account: ACCOUNT, since: SINCE }, expect: "page" },
    { name: "two at a time", input: { source: SOURCE, account: ACCOUNT, since: SINCE, limit: 2 }, expect: "page" },
    { name: "what came after the first two", input: { source: SOURCE, account: ACCOUNT, cursor: first }, expect: "page" },
    { name: "nothing new since the last listing", input: { source: SOURCE, account: ACCOUNT, cursor: done }, expect: "empty" },
    { name: "a cursor without the account it reads", input: { source: SOURCE, cursor: first }, expect: { refuses: "INPUT_INVALID" } },
    { name: "a cursor passed for another account", input: { source: SOURCE, account: "someone-else", cursor: first }, expect: { refuses: "ACCOUNT_MISMATCH" } },
    { name: "another account than the signed-in one", input: { source: SOURCE, account: "someone-else", since: SINCE }, expect: { refuses: "ACCOUNT_MISMATCH" } },
    {
      name: "a cursor bound to another plugin",
      input: { source: SOURCE, account: ACCOUNT, cursor: encodeBoundCursor({ plugin: "gitlab", source: SOURCE, account: ACCOUNT }, positions) },
      expect: { refuses: "CURSOR_INVALID" },
    },
    { name: "a source this plugin does not have", input: { source: "gitlab", account: ACCOUNT }, expect: { refuses: "SOURCE_UNKNOWN" } },
  ]
}

const reports: ConformanceReport[] = []

describe("the source contract's conformance kit", () => {
  test("the declaration validates, as a consumer reads it from the installed package", () => {
    const installed = readInstalledDescriptor(root, { version: pkg.version })
    expect(installed.ok ? [] : installed.problems).toEqual([])
    expect(declarationProblems(pkg.sources, { tools })).toEqual([])
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(pkg.name).toBe(PACKAGE)
    expect(sources.items.map((item) => item.id)).toEqual(["github.activity"])
  })

  test("github.activity keeps the contract", async () => {
    const report = await sourceConformance({
      plugin: PACKAGE,
      source,
      tools,
      calls: {
        list: async (input, context) => (await methods(context)).events.run(input, call()),
        probe: async (input, context) => (await methods(context)).probe.run(input, call()),
      },
      cases: await cases(),
      account: ACCOUNT,
      sources,
      describe: { id: TOOLS_RPC_ID },
      atomicPages: { reason: ATOMIC },
    })
    reports.push(report)
    expect(report.problems).toEqual([])
    // GitHub's cursor holds a time in each stream, and GitHub keeps what it searches, so a cursor never loses history:
    // the plugin never answers CURSOR_EXPIRED, and the kit's gap check cannot run (source-contract#30, item 5). The
    // report stays incomplete on that one check.
    expect(report.checks.filter((check) => !check.ran && !check.notApplicable).map((check) => check.name)).toEqual(["gap-and-cursor-expired"])
  })

  test("writes the report a release attaches", () => {
    expect(reports.map((report) => report.source)).toEqual(["github.activity"])
    const installed = readInstalledDescriptor(root, { version: pkg.version })
    const report = {
      contract: "@we-the-rebel-alliance/source-contract@0.1.0",
      plugin: PACKAGE,
      version: pkg.version,
      descriptorHash: installed.ok ? installed.value.hash : null,
      ok: reports.every((entry) => entry.ok),
      sources: reports,
    }
    mkdirSync(join(root, "reports"), { recursive: true })
    writeFileSync(join(root, "reports", "conformance-report.json"), `${JSON.stringify(report, null, 2)}\n`)
  })
})
