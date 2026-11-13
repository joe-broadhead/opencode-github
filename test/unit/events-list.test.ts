// github_events_list against a synthetic GitHub: /search/issues and /search/commits filter by their qualifiers, sort
// ascending as asked (ties in GitHub's own order, here the opposite of the plugin's), and page by per_page and page;
// /notifications filters by since, lists newest first, and answers 403 for a sign-in that may not read it. Every
// login, repository and link is made up.
import { describe, expect, it } from "vitest"
import type { ApiOutput } from "../../src/api/contract.js"
import { registerApiTool } from "../../src/api/tool.js"
import { DEFAULT_TOOLSETS, GITHUB_COM } from "../../src/config.js"
import { GitHubPluginError } from "../../src/errors.js"
import { EVENT_LIMITS, PAGE, assertEventsListConformance, encodeCursor, resultProblems, type EventsListResult } from "../../src/host/events-list.js"
import { type Rule, defaultRules, effectOf } from "../../src/permissions.js"
import { EVENTS_ACTION, EVENTS_INPUT, EVENTS_READS, SETTLE_MS, SOURCE, commitItem, eventsMethod, issueItem, listEvents, loginOf, notificationItem, runEvents } from "../../src/source-events.js"

const NOW = Date.parse("2026-11-08T12:00:00Z")
const SINCE = "2026-10-01"
const LOGIN = "octo-person"
const OWNER = { id: `github:${LOGIN}`, label: LOGIN }
const API = "https://api.github.com/repos"

const issue = (repo: string, number: number, updated: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Item ${number}`,
  body: `Body of ${number}`,
  state: "open",
  updated_at: updated,
  repository_url: `${API}/${repo}`,
  html_url: `https://github.com/${repo}/issues/${number}`,
  user: { login: "someone-else" },
  assignees: [{ login: LOGIN }],
  labels: [{ name: "needs review" }],
  ...extra,
})

const ISSUES = [
  issue("octo/app", 1, "2026-10-01T09:00:00Z"),
  issue("octo/app", 2, "2026-10-02T10:00:00Z", { pull_request: { merged_at: "2026-10-02T10:00:00Z" }, html_url: "https://github.com/octo/app/pull/2", state: "closed" }),
  // Three changes in one second: GitHub orders ties its own way.
  issue("octo/app", 9, "2026-10-05T08:00:00Z"),
  issue("octo/app", 8, "2026-10-05T08:00:00Z"),
  issue("octo/lib", 7, "2026-10-05T08:00:00Z", { body: "x".repeat(6000) }),
  ...Array.from({ length: 4 }, (_, index) => issue("octo/lib", 20 + index, `2026-10-2${index}T12:00:00Z`)),
  issue("octo/app", 30, "2026-11-08T11:58:00Z"),
]

const COMMITS = [
  { sha: "a1", html_url: "https://github.com/octo/app/commit/a1", repository: { full_name: "octo/app" }, author: { login: LOGIN }, commit: { message: "Fix the parser\n\nLonger text.", author: { name: "Octo Person", email: "octo@example.test", date: "2026-10-01T08:00:00Z" }, committer: { date: "2026-10-01T09:00:00Z" } } },
  { sha: "b2", html_url: "https://github.com/octo/lib/commit/b2", repository: { full_name: "octo/lib" }, author: null, commit: { message: "Bump", author: { name: "Octo Person", email: "Octo@Example.test", date: "2026-10-03T08:00:00Z" }, committer: { date: "2026-10-03T08:00:00Z" } } },
]

const NOTIFICATIONS = [
  { id: "n1", reason: "mention", updated_at: "2026-10-04T10:00:00Z", subject: { title: "Item 1", type: "Issue" }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } },
  { id: "n2", reason: "subscribed", updated_at: "2026-10-06T10:00:00Z", subject: { title: "v1.2.0", type: "Release" }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } },
]

/** The events from SINCE at NOW, oldest first; ties by stream, then by the plugin's id. */
const EXPECTED = [
  "octo/app@a1",
  "octo/app#1@2026-10-01T09:00:00.000Z",
  "octo/app#2@2026-10-02T10:00:00.000Z",
  "octo/lib@b2",
  "octo/app#8@2026-10-05T08:00:00.000Z",
  "octo/app#9@2026-10-05T08:00:00.000Z",
  "octo/lib#7@2026-10-05T08:00:00.000Z",
  "notification:n2@2026-10-06T10:00:00.000Z",
  ...Array.from({ length: 4 }, (_, index) => `octo/lib#${20 + index}@2026-10-2${index}T12:00:00.000Z`),
]

const ok = (data: unknown): ApiOutput => ({ ok: true, status: 200, data, truncated: false, trust: { githubContent: "untrusted" } })

function github(options: { perPage?: number; notifications?: "ok" | "forbidden"; login?: string } = {}) {
  const calls: { path: string; query: Record<string, unknown> }[] = []
  const get = async (path: string, query: Record<string, string | number | boolean>) => {
    calls.push({ path, query })
    const per = options.perPage ?? Number(query.per_page)
    const page = Number(query.page ?? 1)
    const qualifier = (name: string) => new RegExp(`${name}:>=(\\S+)`).exec(String(query.q))?.[1]
    const pageOf = <T>(all: T[]) => all.slice((page - 1) * per, page * per)
    if (path === "/user") return ok({ login: options.login ?? LOGIN })
    if (path === "/search/issues") {
      expect(String(query.q)).toContain(`involves:${options.login ?? LOGIN}`)
      const from = Date.parse(qualifier("updated")!)
      const all = ISSUES.filter((item) => Date.parse(item.updated_at) >= from).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || b.number - a.number)
      return ok({ total_count: all.length, incomplete_results: false, items: pageOf(all) })
    }
    if (path === "/search/commits") {
      const from = Date.parse(qualifier("committer-date")!)
      const all = COMMITS.filter((item) => Date.parse(item.commit.committer.date) >= from)
      return ok({ total_count: all.length, incomplete_results: false, items: pageOf(all) })
    }
    if (path === "/notifications") {
      if (options.notifications === "forbidden") return { ok: false, status: 403, data: { message: "Resource not accessible" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput
      const since = Date.parse(String(query.since))
      const all = NOTIFICATIONS.filter((item) => Date.parse(item.updated_at) >= since).reverse()
      return ok(all.slice((page - 1) * Number(query.per_page), page * Number(query.per_page)))
    }
    throw new Error(`the synthetic GitHub has no ${path}`)
  }
  return { get, calls, me: async () => ({ login: options.login ?? LOGIN, id: 1 }) }
}

const list = (fake = github(), now = NOW) => (input: unknown) => listEvents(fake.get, fake.me, input, now)
const code = async (promise: Promise<unknown>) => {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof GitHubPluginError ? error.code : String(error)
  }
}

describe("GitHub's answers as events", () => {
  it("makes an issue or a pull request change one event, with its html_url, state, labels and people", () => {
    const pr = issueItem(ISSUES[1])!
    expect(pr.event).toMatchObject({
      kind: "pr",
      external_id: "octo/app#2@2026-10-02T10:00:00.000Z",
      thread: "github:octo/app#2",
      title: "octo/app#2: Item 2",
      url: "https://github.com/octo/app/pull/2",
      labels: ["merged", "needs-review"],
      actors: [{ role: "author", id: "github:someone-else" }, { role: "assignee", id: `github:${LOGIN}` }],
    })
    expect(issueItem(ISSUES[0])!.event.kind).toBe("issue")
    expect(issueItem({ number: 1 })).toBeUndefined()
  })

  it("makes a commit one event at its committer date, with a mailto: author when GitHub links no login", () => {
    expect(commitItem(COMMITS[0])!.event).toMatchObject({ kind: "commit", occurred_at: "2026-10-01T09:00:00.000Z", title: "octo/app: Fix the parser", actors: [{ role: "author", id: `github:${LOGIN}` }] })
    expect(commitItem(COMMITS[1])!.event.actors).toEqual([{ role: "author", id: "mailto:octo@example.test", name: "Octo Person" }])
  })

  it("leaves out a notification about an issue or a pull request, which the first stream lists", () => {
    expect(notificationItem(NOTIFICATIONS[0])).toBeUndefined()
    expect(notificationItem(NOTIFICATIONS[1])!.event).toMatchObject({ kind: "event", title: "octo/app: v1.2.0", text: "Release, subscribed.", url: "https://github.com/octo/app", labels: ["release", "subscribed"] })
  })

  it("reads the login from get_me's or /user's answer", () => {
    expect(loginOf({ login: LOGIN })).toBe(LOGIN)
    expect(loginOf(JSON.stringify({ user: { login: LOGIN } }))).toBe(LOGIN)
    expect(loginOf({ login: "not a login" })).toBeUndefined()
  })
})

describe("events_list", () => {
  it("keeps the events_list contract over a synthetic GitHub", async () => {
    await assertEventsListConformance(list(), { source: SOURCE, account: "default", owner: OWNER, since: SINCE, expected: EXPECTED, pageSize: 2 })
  })

  it("keeps it with the source named and GitHub's pages of two, where ties cross a page", async () => {
    await assertEventsListConformance(list(github({ perPage: 2 })), { source: SOURCE, sourceInput: true, since: SINCE, expected: EXPECTED, pageSize: 3 })
  })

  it("keeps it where the sign-in may not read notifications, and leaves them out", async () => {
    await assertEventsListConformance(list(github({ notifications: "forbidden" })), { source: SOURCE, since: SINCE, expected: EXPECTED.filter((id) => !id.startsWith("notification:")) })
  })

  it("lists an event once it is 5 minutes old", async () => {
    const ids = async (now: number) => ((await list(github(), now)({ since: SINCE, limit: PAGE.max })) as EventsListResult).events.map((event) => event.external_id)
    expect(await ids(NOW)).not.toContain("octo/app#30@2026-11-08T11:58:00.000Z")
    expect(await ids(Date.parse("2026-11-08T11:58:00Z") + SETTLE_MS)).toContain("octo/app#30@2026-11-08T11:58:00.000Z")
  })

  it("cuts a long body to 4096 characters, and keeps every result within the contract", async () => {
    const result = (await list()({ since: SINCE, limit: PAGE.max })) as EventsListResult
    expect(resultProblems(result)).toEqual([])
    expect(result).toMatchObject({ source: "github", account: "default", owner: OWNER, more: false, trust: "untrusted" })
    expect(result.events.find((event) => event.external_id.startsWith("octo/lib#7@"))!.text).toHaveLength(EVENT_LIMITS.text)
  })

  it("asks GitHub's searches oldest first, from whole seconds, and reads notifications only as participating", async () => {
    const fake = github()
    await list(fake)({ since: "2026-10-01T09:00:00.500Z" })
    expect(fake.calls.find((call) => call.path === "/search/issues")!.query).toEqual({ q: `involves:${LOGIN} updated:>=2026-10-01T09:00:00Z`, sort: "updated", order: "asc", per_page: 50, page: 1 })
    expect(fake.calls.find((call) => call.path === "/search/commits")!.query).toMatchObject({ q: `author:${LOGIN} committer-date:>=2026-10-01T09:00:00Z`, sort: "committer-date", order: "asc" })
    expect(fake.calls.find((call) => call.path === "/notifications")!.query).toMatchObject({ all: true, participating: true, since: "2026-10-01T09:00:00Z" })
  })

  it("names its source, account and owner on an empty first page, without a search", async () => {
    const fake = github()
    expect(await list(fake)({ since: "2999-01-01" })).toMatchObject({ source: "github", account: "default", owner: OWNER, events: [], more: false })
    expect(fake.calls).toEqual([])
  })

  it("refuses another user's cursor, another source's, another account and another source", async () => {
    const first = (await list()({ since: SINCE, limit: 1 })) as EventsListResult
    expect(await code(list(github({ login: "someone-else" }))({ cursor: first.cursor }))).toBe("EVENTS_CURSOR_INVALID")
    expect(await code(list()({ cursor: encodeCursor("gmail", {}) }))).toBe("EVENTS_CURSOR_INVALID")
    expect(await code(list()({ account: "work" }))).toBe("EVENTS_INVALID_INPUT")
    expect(await code(list()({ source: "gitlab" }))).toBe("EVENTS_INVALID_INPUT")
    expect(await code(listEvents(github().get, async () => ({}), {}, NOW))).toBe("EVENTS_OWNER_UNKNOWN")
  })

  it("stops with EVENTS_READ_FAILED on a failed search or one too large to read whole", async () => {
    const failing = async () => ({ ok: false, status: 422, data: {}, truncated: false, trust: { githubContent: "untrusted" } }) as ApiOutput
    expect(await code(listEvents(failing, github().me, { since: SINCE }, NOW))).toBe("EVENTS_READ_FAILED")
    const cut = async () => ({ ok: true, status: 200, data: "{", truncated: true, trust: { githubContent: "untrusted" } }) as ApiOutput
    expect(await code(listEvents(cut, github().me, { since: SINCE }, NOW))).toBe("EVENTS_READ_FAILED")
  })
})

describe("the tool and the tools RPC method", () => {
  function deps(options: { managed?: boolean; getMe?: boolean } = {}) {
    const fake = github()
    const methods: string[] = []
    const asserted: Record<string, unknown>[] = []
    const ran: string[] = []
    const deps = {
      ctx: {
        tool: { list: async () => (options.getMe === false ? [] : [{ id: "github_get_me", execute: async () => (ran.push("get_me"), { output: { login: LOGIN } }) }]) },
        permission: { assert: async (request: Record<string, unknown>) => void asserted.push(request) },
      },
      api: {
        run: async (input: { method: string; path: string; query?: Record<string, string | number | boolean> }) => {
          methods.push(input.method)
          return fake.get(input.path, input.query ?? {})
        },
      },
      managed: () => options.managed !== false,
      now: () => NOW,
    }
    return { deps: deps as never, methods, asserted, ran, fake }
  }
  const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }

  it("asserts github_events_list, names the owner with get_me, and sends only GETs", async () => {
    const { deps: d, methods, asserted, ran } = deps()
    const result = await runEvents(d, { since: SINCE }, call)
    expect(result.events.map((event) => event.external_id)).toEqual(EXPECTED)
    expect(asserted).toEqual([expect.objectContaining({ action: EVENTS_ACTION, resources: ["*"] })])
    expect(ran).toEqual(["get_me"])
    expect(new Set(methods)).toEqual(new Set(["GET"]))
  })

  it("reads GET /user where GitHub's MCP server is not the plugin's or lists no get_me", async () => {
    for (const options of [{ managed: false }, { getMe: false }]) {
      const { deps: d, ran, fake } = deps(options)
      expect((await runEvents(d, { since: "2999-01-01" }, call)).owner).toEqual(OWNER)
      expect(ran).toEqual([])
      expect(fake.calls.map((entry) => entry.path)).toEqual(["/user"])
    }
  })

  it("is an owned method with the tool's schema, and allowed by the default rules", async () => {
    const { deps: d } = deps()
    const method = eventsMethod(d)
    expect(method).toMatchObject({ name: "events_list", action: "github_events_list", input: EVENTS_INPUT })
    expect(defaultRules()).toContainEqual({ action: "github_events_list", resource: "*", effect: "allow" })
    expect((await method.run({ since: "2999-01-01" }, { ...call, signal: new AbortController().signal, progress: async () => {} })) as EventsListResult).toMatchObject({ source: "github", events: [] })
  })
})

// Every inner read asserts github_events_list, the tool's own permission, on its own GET /path through github_api's
// real spec, before any network I/O, so the grant for the tool covers exactly its reads. Jelly's agents have no base
// `* * allow` rule, so the plugin's block (with the github_api read allows) never reaches them; Jelly writes an allow for
// each declared read tool instead, github_events_list included, and that alone must let Memory's unattended collection
// run. A rule that asks for or denies github_events_list, or one of its paths, stops it with nothing sent.
describe("events_list's inner reads", () => {
  const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }
  const BASE: Rule[] = [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules("all")]
  /** What Jelly writes for this plugin: an allow per declared tool, with no base allow and no github_api rule. */
  const JELLY: Rule[] = [
    { action: "github_get_me", resource: "*", effect: "allow" },
    { action: EVENTS_ACTION, resource: "*", effect: "allow" },
  ]
  const READS = ["/user", "/search/issues", "/search/commits", "/notifications"]

  async function wired(session: readonly Rule[], agent: readonly Rule[] = BASE) {
    const fetched: string[] = []
    const asserted: string[] = []
    // OpenCode's assert, as far as this needs it: the last matching rule of the agent's, then the session's, decides;
    // an ask has nobody to answer it in an unattended call, so it refuses like a deny.
    const ctx = {
      tool: { transform: async () => ({ dispose: async () => {} }), list: async () => [] },
      permission: {
        assert: async (request: { action: string; resources: string[] }) => {
          const effect = effectOf([...agent, ...session], request.action, request.resources[0])
          if (effect !== "allow") throw new Error(`refused: ${request.action} ${request.resources[0]} (${effect})`)
          asserted.push(`${request.action} ${request.resources[0]}`)
        },
      },
      integration: {
        get: async () => ({ data: { connections: [] } }),
        connection: {
          active: async () => ({ type: "credential", id: "cred_1", label: LOGIN, method: "oauth" }),
          resolve: async () => ({ type: "oauth", access: "gho_" + "t".repeat(36), refresh: "", expires: 0 }),
          status: async () => {},
        },
      },
      session: { get: async () => ({ permissions: session }) },
      agent: { get: async () => ({ data: { permissions: agent } }) },
    }
    const api = await registerApiTool(ctx as never, {
      access: "all",
      readOnly: false,
      endpoints: GITHUB_COM,
      service: "GitHub",
      root: "/",
      toolsets: DEFAULT_TOOLSETS,
      integrationID: () => "mcp_1",
      fetch: async (url) => {
        fetched.push(new URL(url).pathname)
        const path = new URL(url).pathname
        const body = path === "/user" ? { login: LOGIN } : path === "/notifications" ? [] : { total_count: 0, incomplete_results: false, items: [] }
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
      },
    })
    const deps = { ctx: { tool: ctx.tool, permission: ctx.permission }, api, managed: () => false, now: () => NOW }
    return { run: () => runEvents(deps as never, { since: SINCE }, call), api, fetched, asserted }
  }

  it("asserts github_events_list, then github_events_list on each GET /path before it is sent", async () => {
    const { run, fetched, asserted } = await wired([])
    expect((await run()).events).toEqual([])
    expect(fetched).toEqual(READS)
    expect(asserted).toEqual([`${EVENTS_ACTION} *`, ...READS.map((path) => `${EVENTS_ACTION} GET ${path}`)])
    expect(EVENTS_READS).toEqual(READS.map((path) => `GET ${path}`))
  })

  it("runs end to end in an agent with no base allow and only Jelly's allow for github_events_list", async () => {
    const { run, fetched, asserted } = await wired([], JELLY)
    const result = await run().catch((error: unknown) => error)
    expect(String((result as Error).message ?? "")).not.toContain("PERMISSION_DENIED")
    expect(result).toMatchObject({ source: "github", owner: OWNER, events: [] })
    expect(fetched).toEqual(READS)
    expect(asserted.every((entry) => entry.startsWith(`${EVENTS_ACTION} `))).toBe(true)
  })

  it("is not decided by github_api rules: a session deny on github_api does not stop it", async () => {
    const { run, fetched } = await wired([{ action: "github_api", resource: "*", effect: "deny" }], JELLY)
    expect((await run()).owner).toEqual(OWNER)
    expect(fetched).toEqual(READS)
  })

  it("stops with nothing sent when the session denies github_events_list", async () => {
    for (const agent of [BASE, JELLY]) {
      const { run, fetched, asserted } = await wired([{ action: EVENTS_ACTION, resource: "*", effect: "deny" }], agent)
      await expect(run()).rejects.toThrow(`refused: ${EVENTS_ACTION} * (deny)`)
      expect(fetched).toEqual([])
      expect(asserted).toEqual([])
    }
  })

  it.each([
    ["GET /search/*", ["/user"]],
    ["GET /notifications", ["/user", "/search/issues", "/search/commits"]],
  ])("refuses a read the session denies (%s) before its request, and an ask too, as nobody can answer it", async (resource, sent) => {
    for (const effect of ["deny", "ask"] as const) {
      const { run, fetched } = await wired([{ action: EVENTS_ACTION, resource, effect }], JELLY)
      await expect(run()).rejects.toThrow(new RegExp(`^PERMISSION_DENIED: GET /(search|notifications)\\S* needs a prior allow rule for ${EVENTS_ACTION}`))
      expect(fetched).toEqual(sent)
    }
  })

  it("reaches nothing but its documented GETs: another path or a change is refused before it is sent", async () => {
    const { api, fetched, asserted } = await wired([], [{ action: EVENTS_ACTION, resource: "*", effect: "allow" }, { action: "github_api", resource: "*", effect: "allow" }])
    const scope = { action: EVENTS_ACTION, resources: EVENTS_READS }
    const script = { ...call, script: true }
    for (const input of [
      { method: "GET" as const, path: "/repos/octo/app" },
      { method: "POST" as const, path: "/search/issues" },
      { method: "DELETE" as const, path: "/notifications" },
    ]) {
      await expect(api.run(input, script, scope)).rejects.toThrow(/^PERMISSION_DENIED: github_events_list reads only GET \/user, /)
    }
    await expect(api.run({ graphql: { query: "query { viewer { login } }" } }, script, scope)).rejects.toThrow(/not QUERY \/graphql/)
    expect(fetched).toEqual([])
    expect(asserted).toEqual([])
  })

  it("refuses a redirect from a documented GET to another path, before following it", async () => {
    const fetched: string[] = []
    const redirecting = await registerApiTool(
      {
        tool: { transform: async () => ({ dispose: async () => {} }) },
        permission: { assert: async () => {} },
        integration: {
          get: async () => ({ data: { connections: [] } }),
          connection: {
            active: async () => ({ type: "credential", id: "cred_1", label: LOGIN, method: "oauth" }),
            resolve: async () => ({ type: "oauth", access: "gho_" + "t".repeat(36), refresh: "", expires: 0 }),
            status: async () => {},
          },
        },
        session: { get: async () => ({ permissions: [] }) },
        agent: { get: async () => ({ data: { permissions: JELLY } }) },
      } as never,
      {
        access: "all",
        readOnly: false,
        endpoints: GITHUB_COM,
        service: "GitHub",
        root: "/",
        toolsets: DEFAULT_TOOLSETS,
        integrationID: () => "mcp_1",
        fetch: async (url) => {
          fetched.push(new URL(url).pathname)
          return new Response(null, { status: 307, headers: { location: "https://api.github.com/repos/octo/app" } })
        },
      },
    )
    const result = redirecting.run({ method: "GET", path: "/user" }, { ...call, script: true }, { action: EVENTS_ACTION, resources: EVENTS_READS })
    await expect(result).rejects.toThrow(/reads only .*, not GET \/repos\/octo\/app/)
    expect(fetched).toEqual(["/user"])
  })
})
