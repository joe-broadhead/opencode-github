// github_events_list against a synthetic GitHub: /search/issues and /search/commits filter by their qualifiers, sort
// ascending as asked (ties in GitHub's own order, here the opposite of the plugin's), and page by per_page and page;
// /notifications filters by since, lists newest first, and answers 403 for a sign-in that may not read it. The
// signed-in login is the sign-in's own (no GitHub call), as `registerApiTool`'s identity reads it. Every login,
// repository and link is made up.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ApiOutput } from "../../src/api/contract.js"
import { registerApiTool } from "../../src/api/tool.js"
import { DEFAULT_TOOLSETS, GITHUB_COM } from "../../src/config.js"
import { GitHubPluginError } from "../../src/errors.js"
import { encodeBoundCursor, encodeCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { EVENT_LIMITS, PAGE, assertEventsListConformance, resultProblems, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { type Rule, defaultRules, effectOf } from "../../src/permissions.js"
import {
  EVENTS_ACTION,
  EVENTS_INPUT,
  EVENTS_READS,
  NAMESPACE,
  NOTIFICATION_RETENTION_MS,
  PAGE_BYTES,
  PROBE_ACTION,
  PROBE_READS,
  SETTLE_MS,
  SOURCE,
  commitItem,
  eventsMethod,
  issueItem,
  listEvents,
  loginOf,
  notificationItem,
  probeEvents,
  probeMethod,
  runEvents,
  runProbe,
} from "../../src/source-events.js"

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

function github(options: { perPage?: number; notifications?: "ok" | "forbidden"; login?: string; inbox?: typeof NOTIFICATIONS; incomplete?: number; cut?: (perPage: number) => boolean } = {}) {
  const calls: { path: string; query: Record<string, unknown> }[] = []
  /** How many issue searches GitHub still answers as timed out, with incomplete_results. */
  let incomplete = options.incomplete ?? 0
  const get = async (path: string, query: Record<string, string | number | boolean>) => {
    calls.push({ path, query })
    const per = options.perPage ?? Number(query.per_page)
    const page = Number(query.page ?? 1)
    /** A qualifier's range, `>=from` or `from..to`, as times; to is the end of its second. */
    const range = (name: string) => {
      const match = new RegExp(`${name}:(?:>=(\\S+)|(\\S+)\\.\\.(\\S+))`).exec(String(query.q))!
      return match[1] !== undefined ? { from: Date.parse(match[1]), to: Number.POSITIVE_INFINITY } : { from: Date.parse(match[2]!), to: Date.parse(match[3]!) }
    }
    const within = (at: string, name: string) => Date.parse(at) >= range(name).from && Date.parse(at) <= range(name).to
    const pageOf = <T>(all: T[]) => all.slice((page - 1) * per, page * per)
    /** A search page as GitHub answers it: at 100,000 bytes it keeps the whole items that fit, and nothing else. */
    const cutPage = <T>(all: T[]) => {
      const whole = options.cut?.(Number(query.per_page)) === true
      const data = { total_count: all.length, incomplete_results: false, items: whole ? pageOf(all).slice(0, 1) : pageOf(all) }
      return whole ? { ...ok(data), truncated: true } : ok(data)
    }
    if (path === "/user") return ok({ login: options.login ?? LOGIN })
    if (path === "/search/issues") {
      expect(String(query.q)).toContain(`involves:${options.login ?? LOGIN}`)
      // As GitHub answers a GitHub App user token: a search for issues and pull requests together is refused.
      const kind = /(?:^|\s)is:(issue|pull-request)(?:\s|$)/.exec(String(query.q))?.[1]
      if (kind === undefined) return { ok: false, status: 422, data: { message: "Validation Failed" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput
      const all = ISSUES.filter((item) => within(item.updated_at, "updated") && ("pull_request" in item) === (kind === "pull-request")).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || b.number - a.number)
      // A search that timed out answers what it found so far: here, nothing past its first result.
      if (incomplete > 0) return incomplete--, ok({ total_count: all.length, incomplete_results: true, items: all.slice(0, 1) })
      return cutPage(all)
    }
    if (path === "/search/commits") {
      const all = COMMITS.filter((item) => within(item.commit.committer.date, "committer-date"))
      return cutPage(all)
    }
    if (path === "/notifications") {
      if (options.notifications === "forbidden") return { ok: false, status: 403, data: { message: "Resource not accessible" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput
      const since = Date.parse(String(query.since))
      // before is exclusive; since inclusive.
      const before = query.before === undefined ? Number.POSITIVE_INFINITY : Date.parse(String(query.before))
      const all = (options.inbox ?? NOTIFICATIONS).filter((item) => Date.parse(item.updated_at) >= since && Date.parse(item.updated_at) < before).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      return ok(all.slice((page - 1) * Number(query.per_page), page * Number(query.per_page)))
    }
    throw new Error(`the synthetic GitHub has no ${path}`)
  }
  return { get, calls, identity: async (): Promise<string | undefined> => options.login ?? LOGIN }
}

const list = (fake = github(), now = NOW) => (input: unknown) => listEvents(fake.get, fake.identity, input, now)
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
    const pr = issueItem(ISSUES[1], LOGIN)!
    expect(pr.event).toMatchObject({
      kind: "pr",
      external_id: "octo/app#2@2026-10-02T10:00:00.000Z",
      thread: "github:octo/app#2",
      title: "octo/app#2: Item 2",
      url: "https://github.com/octo/app/pull/2",
      labels: ["merged", "needs-review"],
      actors: [{ role: "author", id: "github:someone-else" }, { role: "assignee", id: `github:${LOGIN}` }],
    })
    expect(issueItem(ISSUES[0], LOGIN)!.event.kind).toBe("issue")
    expect(issueItem({ number: 1 }, LOGIN)).toBeUndefined()
  })

  it("makes a commit one event at its committer date, with a mailto: author when GitHub links no login", () => {
    expect(commitItem(COMMITS[0], LOGIN)!.event).toMatchObject({ kind: "commit", occurred_at: "2026-10-01T09:00:00.000Z", title: "octo/app: Fix the parser", actors: [{ role: "author", id: `github:${LOGIN}` }] })
    expect(commitItem(COMMITS[1], LOGIN)!.event.actors).toEqual([{ role: "author", id: "mailto:octo@example.test", name: "Octo Person" }])
  })

  it("leaves out a notification about an issue or a pull request, which the first stream lists", () => {
    expect(notificationItem(NOTIFICATIONS[0], LOGIN)).toBeUndefined()
    expect(notificationItem(NOTIFICATIONS[1], LOGIN)!.event).toMatchObject({ kind: "event", title: "octo/app: v1.2.0", text: "Release, subscribed.", url: "https://github.com/octo/app", labels: ["release", "subscribed"] })
  })

  it("reads the login from GET /user's answer", () => {
    expect(loginOf({ login: LOGIN })).toBe(LOGIN)
    expect(loginOf(JSON.stringify({ user: { login: LOGIN } }))).toBe(LOGIN)
    expect(loginOf({ login: "not a login" })).toBeUndefined()
  })
})

describe("events_list", () => {
  /** What every walk checks beyond contract 1: the bound cursor, the table's codes and the declared maxBytes. */
  const FINAL = { account: LOGIN, binding: { plugin: NAMESPACE }, codes: true, maxBytes: PAGE_BYTES } as const

  it("keeps the events_list contract over a synthetic GitHub", async () => {
    await assertEventsListConformance(list(), { ...FINAL, source: SOURCE, owner: OWNER, since: SINCE, expected: EXPECTED, pageSize: 2 })
  })

  it("keeps it with the source named and GitHub's pages of two, where ties cross a page", async () => {
    await assertEventsListConformance(list(github({ perPage: 2 })), { ...FINAL, source: SOURCE, sourceInput: true, since: SINCE, expected: EXPECTED, pageSize: 3 })
  })

  it("keeps it where the sign-in may not read notifications, and leaves them out", async () => {
    await assertEventsListConformance(list(github({ notifications: "forbidden" })), { ...FINAL, source: SOURCE, since: SINCE, expected: EXPECTED.filter((id) => !id.startsWith("notification:")) })
  })

  it("names the account and owner as the sign-in records them: the account lowercase, the owner as GitHub spells the login", async () => {
    const result = (await list(github({ login: "Octo-Person" }))({ since: "2999-01-01" })) as EventsListResult
    expect(result).toMatchObject({ account: "octo-person", owner: { id: "github:Octo-Person", label: "Octo-Person" }, plugin: "@joe-broadhead/opencode-github" })
  })

  it("lists an event once it is 5 minutes old", async () => {
    const ids = async (now: number) => ((await list(github(), now)({ since: SINCE, limit: PAGE.max })) as EventsListResult).events.map((event) => event.external_id)
    expect(await ids(NOW)).not.toContain("octo/app#30@2026-11-08T11:58:00.000Z")
    expect(await ids(Date.parse("2026-11-08T11:58:00Z") + SETTLE_MS)).toContain("octo/app#30@2026-11-08T11:58:00.000Z")
  })

  it("cuts a long body to 4096 characters, and keeps every result within the contract", async () => {
    const result = (await list()({ since: SINCE, limit: PAGE.max })) as EventsListResult
    expect(resultProblems(result)).toEqual([])
    expect(result).toMatchObject({ source: "github", account: LOGIN, owner: OWNER, more: false, trust: "untrusted" })
    expect(result.events.find((event) => event.external_id.startsWith("octo/lib#7@"))!.text).toHaveLength(EVENT_LIMITS.text)
  })

  it("asks GitHub's searches oldest first, from whole seconds, and reads notifications only as participating", async () => {
    const fake = github()
    await list(fake)({ since: "2026-10-01T09:00:00.500Z" })
    expect(fake.calls.filter((call) => call.path === "/search/issues").map((call) => call.query)).toEqual([
      { q: `is:issue involves:${LOGIN} updated:>=2026-10-01T09:00:00Z`, sort: "updated", order: "asc", per_page: 100, page: 1 },
      { q: `is:pull-request involves:${LOGIN} updated:>=2026-10-01T09:00:00Z`, sort: "updated", order: "asc", per_page: 100, page: 1 },
    ])
    expect(fake.calls.find((call) => call.path === "/search/commits")!.query).toMatchObject({ q: `author:${LOGIN} committer-date:>=2026-10-01T09:00:00Z`, sort: "committer-date", order: "asc" })
    expect(fake.calls.find((call) => call.path === "/notifications")!.query).toMatchObject({ all: true, participating: true, since: "2026-10-01T09:00:00Z" })
  })

  it("lists issues and pull requests from two searches, one is:issue and one is:pull-request, as a GitHub App token needs", async () => {
    const fake = github()
    const result = (await list(fake)({ since: SINCE, limit: PAGE.max })) as EventsListResult
    const kinds = new Set(result.events.map((event) => event.kind))
    expect(kinds).toEqual(new Set(["issue", "pr", "commit", "event"]))
    expect(result.events.find((event) => event.kind === "pr")!.external_id).toBe("octo/app#2@2026-10-02T10:00:00.000Z")
    const searches = fake.calls.filter((call) => call.path === "/search/issues").map((call) => String(call.query.q))
    expect(searches.every((q) => /^is:(issue|pull-request) /.test(q))).toBe(true)
    // The fake refuses a search without is:, as GitHub does for a GitHub App user token, and none was sent.
    expect(await fake.get("/search/issues", { q: `involves:${LOGIN} updated:>=2026-10-01T00:00:00Z`, per_page: 50, page: 1 })).toMatchObject({ ok: false, status: 422 })
  })

  it("qualifies the owner with the host on GitHub Enterprise Server, so it never equals a github.com owner", async () => {
    const fake = github()
    const enterprise = (await listEvents(fake.get, fake.identity, { since: "2999-01-01" }, NOW, "GHE.Example.test")) as EventsListResult
    expect(enterprise.owner).toEqual({ id: `github:${LOGIN}@ghe.example.test`, label: `${LOGIN} (ghe.example.test)` })
    expect(await probeEvents(fake.get, fake.identity, {}, "ghe.example.test")).toMatchObject({ owner: enterprise.owner })
    expect(((await list(fake)({ since: "2999-01-01" })) as EventsListResult).owner).toEqual(OWNER)
  })

  it("names its source, account and owner on an empty first page, without a search", async () => {
    const fake = github()
    expect(await list(fake)({ since: "2999-01-01" })).toMatchObject({ source: "github", account: LOGIN, owner: OWNER, events: [], more: false })
    expect(fake.calls).toEqual([])
  })

  it("refuses another sign-in's cursor, another source's, a forged one, another account and another source", async () => {
    const first = (await list()({ since: SINCE, limit: 1 })) as EventsListResult
    expect(await code(list(github({ login: "someone-else" }))({ account: "someone-else", cursor: first.cursor }))).toBe("ACCOUNT_MISMATCH")
    expect(await code(list()({ account: LOGIN, cursor: encodeCursor("gmail", {}) }))).toBe("CURSOR_INVALID")
    // The same state, bound to another plugin, or holding another sign-in's owner hash: forged, never misread.
    const state = JSON.parse(Buffer.from(first.cursor, "base64url").toString("utf8")) as Record<string, unknown>
    const { v: _v, s: _s, b: _b, ...positions } = state
    expect(await code(list()({ account: LOGIN, cursor: encodeBoundCursor({ plugin: "gitlab", source: SOURCE, account: LOGIN }, positions) }))).toBe("CURSOR_INVALID")
    expect(await code(list()({ account: LOGIN, cursor: encodeBoundCursor({ plugin: NAMESPACE, source: SOURCE, account: LOGIN }, { ...positions, o: "0".repeat(16) }) }))).toBe("CURSOR_INVALID")
    expect(await code(list()({ account: "work" }))).toBe("ACCOUNT_MISMATCH")
    expect(await code(list()({ source: "gitlab" }))).toBe("SOURCE_UNKNOWN")
    expect(await code(list()({ cursor: first.cursor }))).toBe("INPUT_INVALID")
    expect(await code(listEvents(github().get, async () => undefined, {}, NOW))).toBe("AUTH_REQUIRED")
  })

  it("refuses a cursor for another account with ACCOUNT_MISMATCH before it reads the sign-in or GitHub", async () => {
    const first = (await list()({ since: SINCE, limit: 1 })) as EventsListResult
    const fake = github()
    let asked = 0
    const identity = async () => (asked++, LOGIN)
    expect(await code(listEvents(fake.get, identity, { account: "someone-else", cursor: first.cursor }, NOW))).toBe("ACCOUNT_MISMATCH")
    expect(asked).toBe(0)
    expect(fake.calls).toEqual([])
  })

  it("refuses a cursor an earlier release issued, for the same sign-in too, with CURSOR_INVALID and a next step to start again", async () => {
    const owner = createHash("sha256").update(OWNER.id).digest("hex").slice(0, 16)
    // Contract 1's cursor, as 0.0.2 wrote it: account default and the owner's hash.
    const legacy = encodeCursor(SOURCE, { a: "default", o: owner, p: { i: [Date.parse(SINCE), ""], c: [Date.parse(SINCE), ""], n: [Date.parse(SINCE), ""] } })
    const fake = github()
    const refused = await listEvents(fake.get, fake.identity, { account: LOGIN, cursor: legacy }, NOW).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(GitHubPluginError)
    expect((refused as GitHubPluginError).code).toBe("CURSOR_INVALID")
    expect((refused as GitHubPluginError).nextStep).toBe("Call events_list without a cursor, with since, to start again.")
    expect(fake.calls).toEqual([])
  })

  it("refuses an event whose title or text holds a secret for good, and moves the cursor past it", async () => {
    const leaky = github()
    const get: typeof leaky.get = async (path, query) => {
      const output = await leaky.get(path, query)
      if (path !== "/search/commits") return output
      const data = output.data as { items: { commit: { message: string } }[] }
      return { ...output, data: { ...data, items: data.items.map((item, index) => (index === 0 ? { ...item, commit: { ...item.commit, message: "Deploy with https://ops:Wq7rZp4xLm9@deploy.example.net/hook" } } : item)) } }
    }
    const result = (await listEvents(get, leaky.identity, { since: SINCE, limit: 2 }, NOW)) as EventsListResult
    expect(result.refused).toEqual([expect.objectContaining({ external_id: "octo/app@a1", reason: "secret" })])
    expect(result.events.map((event) => event.external_id)).toEqual(EXPECTED.slice(1, 3))
    const next = (await listEvents(get, leaky.identity, { account: LOGIN, cursor: result.cursor, limit: PAGE.max }, NOW)) as EventsListResult
    expect(next.events.map((event) => event.external_id)).toEqual(EXPECTED.slice(3))
    expect(next.refused ?? []).toEqual([])
  })

  it("stops with UNAVAILABLE on a failed search, and with TOO_LARGE on a notifications page no size reads whole", async () => {
    const failing = async () => ({ ok: false, status: 422, data: {}, truncated: false, trust: { githubContent: "untrusted" } }) as ApiOutput
    expect(await code(listEvents(failing, github().identity, { since: SINCE }, NOW))).toBe("UNAVAILABLE")
    // A search page over the cap is read again at half the size (`pageAt`), and one result over it answers a gap; a
    // notifications page over the cap cannot be paged down, so it is TOO_LARGE.
    const cut = async (path: string) => (path === "/notifications" ? { ok: true, status: 200, data: "{", truncated: true, trust: { githubContent: "untrusted" } } : { ok: true, status: 200, data: { total_count: 0, incomplete_results: false, items: [] }, truncated: false, trust: { githubContent: "untrusted" } }) as ApiOutput
    expect(await code(listEvents(cut, github().identity, { since: SINCE }, NOW))).toBe("TOO_LARGE")
  })

  it("reads a page GitHub cut at 100,000 bytes again at half the page size, and lists its events", async () => {
    const fake = github({ cut: (perPage) => perPage >= 100 })
    const result = (await list(fake)({ since: SINCE, limit: PAGE.max })) as EventsListResult
    expect(result.events.map((event) => event.external_id)).toEqual(EXPECTED)
    // The cut page is dropped whole, and the same page is asked for again at half the size; the other searches start there.
    expect(fake.calls.filter((call) => call.path === "/search/issues").map((call) => call.query.per_page)).toEqual([100, 50, 50])
  })

  it("keeps the cursor exact across a page size change: nothing is skipped and nothing is listed twice", async () => {
    const fake = github({ cut: (perPage) => perPage >= 100 })
    const ids: string[] = []
    let cursor: string | undefined
    for (let step = 0; step < 20; step++) {
      const page = (await list(fake)(cursor === undefined ? { since: SINCE, limit: 2 } : { account: LOGIN, cursor, limit: 2 })) as EventsListResult
      ids.push(...page.events.map((event) => event.external_id))
      if (!page.more) break
      cursor = page.cursor
    }
    expect(ids).toEqual(EXPECTED)
  })

  it("answers a gap, never TOO_LARGE and never a failure, when one item alone is over the read cap", async () => {
    const cut = async (path: string) =>
      (path === "/notifications"
        ? { ok: true, status: 200, data: [], truncated: false, trust: { githubContent: "untrusted" } }
        : { ok: true, status: 200, data: { total_count: 1, incomplete_results: false, items: [] }, truncated: path === "/search/issues", trust: { githubContent: "untrusted" } }) as ApiOutput
    const result = (await listEvents(cut, github().identity, { since: SINCE }, NOW)) as EventsListResult
    // Halved from 100 to one item, and one result is still over the cap: the page answers the loss and reads on.
    expect(result.gap).toEqual({ reason: "window-truncated", since: "2026-10-01T00:00:00.000Z" })
    expect(result.events).toEqual([])
  })
})

describe("history GitHub no longer keeps", () => {
  const DAY = 24 * 60 * 60_000
  const iso = (at: number) => new Date(at).toISOString()
  const page = (fake: ReturnType<typeof github>, now: number, input: Record<string, unknown>) => listEvents(fake.get, fake.identity, input, now) as Promise<EventsListResult>
  /** Every page of one read, from `input`, at `now`. */
  async function read(fake: ReturnType<typeof github>, now: number, input: Record<string, unknown>) {
    const pages = [await page(fake, now, input)]
    while (pages.at(-1)!.more) pages.push(await page(fake, now, { account: LOGIN, cursor: pages.at(-1)!.cursor, limit: input["limit"] }))
    return pages
  }
  const positionN = (cursor: string) => ((JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { p: Record<string, [number, string]> }).p["n"] as [number, string])[0]

  it("keeps notifications three months: 89 days, the shortest", () => {
    expect(NOTIFICATION_RETENTION_MS).toBe(89 * DAY)
  })

  it("answers gap expired, once, for a cursor whose notifications start before GitHub's three months, and reads them from inside the window", async () => {
    const caught = await read(github(), NOW, { since: SINCE, limit: PAGE.max })
    const cursor = caught.at(-1)!.cursor
    const later = NOW + 100 * DAY
    const fake = github()
    const pages = await read(fake, later, { account: LOGIN, cursor, limit: 1 })
    expect(pages[0]!.gap).toEqual({ reason: "expired", since: iso(positionN(cursor)) })
    expect(pages[0]!.events.map((event) => event.external_id)).toEqual(["octo/app#30@2026-11-08T11:58:00.000Z"])
    // It reads notifications from the window's start.
    expect(fake.calls.find((call) => call.path === "/notifications")!.query["since"]).toBe(iso(Math.floor((later - NOTIFICATION_RETENTION_MS) / 1000) * 1000).replace(".000", ""))
    for (const result of pages) expect(resultProblems(result)).toEqual([])
    // The same cursor read again is the same page, with the same gap.
    expect((await page(github(), later, { account: LOGIN, cursor, limit: 1 })).gap).toEqual(pages[0]!.gap)
  })

  it("answers gap window-truncated on the first page of a read from a since older than three months, and on no later page", async () => {
    const pages = await read(github(), NOW, { since: "2026-07-01", limit: 2 })
    expect(pages[0]!.gap).toEqual({ reason: "window-truncated", since: "2026-07-01T00:00:00.000Z" })
    expect(pages.slice(1).every((result) => result.gap === undefined)).toBe(true)
    expect(pages.flatMap((result) => result.events.map((event) => event.external_id))).toEqual(EXPECTED)
  })

  it("answers no gap where the sign-in may not read notifications, as nothing was there to lose", async () => {
    const pages = await read(github({ notifications: "forbidden" }), NOW, { since: "2026-07-01", limit: 2 })
    expect(pages.every((result) => result.gap === undefined)).toBe(true)
  })

  it("moves a quiet inbox's position with every complete read, so reading it every month answers no gap", async () => {
    let cursor = (await read(github(), NOW, { since: SINCE, limit: PAGE.max })).at(-1)!.cursor
    for (let month = 1; month <= 5; month++) {
      const pages = await read(github(), NOW + month * 30 * DAY, { account: LOGIN, cursor, limit: PAGE.max })
      expect(pages.every((result) => result.gap === undefined)).toBe(true)
      cursor = pages.at(-1)!.cursor
      expect(positionN(cursor)).toBe(NOW + month * 30 * DAY - SETTLE_MS)
    }
  })

  it("walks more notifications than one call reads oldest first, with no gap, counting them one alone at a time", async () => {
    // 520 releases, one a minute.
    const inbox = Array.from({ length: 520 }, (_, index) => ({ ...NOTIFICATIONS[1]!, id: `r${index}`, updated_at: iso(Date.parse("2026-11-01T00:00:00Z") + index * 60_000) }))
    const fake = github({ inbox })
    const pages = await read(fake, NOW, { since: "2026-10-31", limit: PAGE.max })
    expect(pages.every((result) => result.gap === undefined)).toBe(true)
    const listed = pages.flatMap((result) => result.events.map((event) => event.external_id)).filter((id) => id.startsWith("notification:"))
    expect(listed).toEqual(inbox.map((item) => `notification:${item.id}@${item.updated_at}`))
    // The first call: the 501st alone, then doubling and halving to count 520, then the pages holding the oldest 500.
    const first = fake.calls.filter((call) => call.path === "/notifications" && call.query["since"] === "2026-10-31T00:00:00Z")
    expect(first[0]!.query).toMatchObject({ page: 501, per_page: 1, before: "2026-11-08T11:55:01Z" })
    expect(first.filter((call) => call.query["per_page"] === 50).map((call) => call.query["page"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it("lists nothing past the position while GitHub answers a search as incomplete, and the next call reads it again", async () => {
    const fake = github({ incomplete: 1 })
    const first = await page(fake, NOW, { since: SINCE, limit: PAGE.max })
    // The issue search timed out: nothing at or after its position is listed, and nothing is skipped.
    expect(first.events).toEqual([])
    expect(first.more).toBe(true)
    const rest = await read(fake, NOW, { account: LOGIN, cursor: first.cursor, limit: 2 })
    expect(rest.flatMap((result) => result.events.map((event) => event.external_id))).toEqual(EXPECTED)
  })
})

describe("probe", () => {
  it("names the signed-in account and owner, the same as every page, after one GET /user", async () => {
    const fake = github()
    expect(await probeEvents(fake.get, fake.identity, { source: SOURCE, account: LOGIN })).toEqual({ source: SOURCE, account: LOGIN, owner: OWNER, trust: "untrusted" })
    expect(fake.calls.map((call) => call.path)).toEqual(["/user"])
  })

  it("refuses another account before GitHub is called, another source, and a token of another login", async () => {
    const fake = github()
    expect(await code(probeEvents(fake.get, fake.identity, { account: "someone-else" }))).toBe("ACCOUNT_MISMATCH")
    expect(await code(probeEvents(fake.get, fake.identity, { source: "gitlab" }))).toBe("SOURCE_UNKNOWN")
    expect(await code(probeEvents(fake.get, fake.identity, { scope: {} }))).toBe("INPUT_INVALID")
    expect(fake.calls).toEqual([])
    expect(await code(probeEvents(github({ login: "someone-else" }).get, fake.identity, {}))).toBe("UNAVAILABLE")
    expect(await code(probeEvents(fake.get, async () => undefined, {}))).toBe("AUTH_REQUIRED")
  })
})

describe("the tool and the tools RPC methods", () => {
  function deps() {
    const fake = github()
    const methods: string[] = []
    const asserted: Record<string, unknown>[] = []
    const deps = {
      ctx: { permission: { assert: async (request: Record<string, unknown>) => void asserted.push(request) } },
      api: {
        run: async (input: { method: string; path: string; query?: Record<string, string | number | boolean> }) => {
          methods.push(input.method)
          return fake.get(input.path, input.query ?? {})
        },
      },
      identity: fake.identity,
      now: () => NOW,
    }
    return { deps: deps as never, methods, asserted, fake }
  }
  const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }

  it("asserts github_events_list, takes the owner from the sign-in with no GitHub call for it, and sends only GETs", async () => {
    const { deps: d, methods, asserted, fake } = deps()
    const result = await runEvents(d, { since: SINCE }, call)
    expect(result.events.map((event) => event.external_id)).toEqual(EXPECTED)
    expect(result.owner).toEqual(OWNER)
    expect(asserted).toEqual([expect.objectContaining({ action: EVENTS_ACTION, resources: ["*"] })])
    expect(fake.calls.map((entry) => entry.path)).not.toContain("/user")
    expect(new Set(methods)).toEqual(new Set(["GET"]))
  })

  it("probe asserts github_probe, then makes its one GET /user", async () => {
    const { deps: d, asserted, fake } = deps()
    expect(await runProbe(d, {}, call)).toMatchObject({ account: LOGIN, owner: OWNER })
    expect(asserted).toEqual([expect.objectContaining({ action: PROBE_ACTION, resources: ["*"] })])
    expect(fake.calls.map((entry) => entry.path)).toEqual(["/user"])
  })

  it("are owned methods with their schemas, and allowed by the default rules at every access", async () => {
    const { deps: d } = deps()
    const method = eventsMethod(d)
    expect(method).toMatchObject({ name: "events_list", action: "github_events_list", class: "read", input: EVENTS_INPUT })
    expect(probeMethod(d)).toMatchObject({ name: "probe", action: "github_probe", class: "read" })
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      expect(effectOf(defaultRules(access), "github_events_list", "*")).toBe("allow")
      expect(effectOf(defaultRules(access), "github_probe", "*")).toBe("allow")
    }
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
  const READS = ["/search/issues", "/search/commits", "/notifications"]
  /** What one listing sends: the issue search, the pull request search, commits, then notifications: the 501st alone, then the first page. */
  const SENT = ["/search/issues", "/search/issues", "/search/commits", "/notifications", "/notifications"]

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
          resolve: async () => ({ type: "oauth", access: "gho_" + "t".repeat(36), refresh: "", expires: 0, metadata: { login: LOGIN } }),
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
    const deps = { ctx: { permission: ctx.permission }, api, identity: () => api.identity(), now: () => NOW }
    return { run: () => runEvents(deps as never, { since: SINCE }, call), probe: () => runProbe(deps as never, {}, call), api, fetched, asserted }
  }

  it("asserts github_events_list, then github_events_list on each GET /path before it is sent", async () => {
    const { run, fetched, asserted } = await wired([])
    expect((await run()).events).toEqual([])
    expect(fetched).toEqual(SENT)
    expect(asserted).toEqual([`${EVENTS_ACTION} *`, ...SENT.map((path) => `${EVENTS_ACTION} GET ${path}`)])
    expect(EVENTS_READS).toEqual(READS.map((path) => `GET ${path}`))
  })

  it("runs end to end in an agent with no base allow and only Jelly's allow for github_events_list", async () => {
    const { run, fetched, asserted } = await wired([], JELLY)
    const result = await run().catch((error: unknown) => error)
    expect(String((result as Error).message ?? "")).not.toContain("PERMISSION_DENIED")
    expect(result).toMatchObject({ source: "github", owner: OWNER, events: [] })
    expect(fetched).toEqual(SENT)
    expect(asserted.every((entry) => entry.startsWith(`${EVENTS_ACTION} `))).toBe(true)
  })

  it("is not decided by github_api rules: a session deny on github_api does not stop it", async () => {
    const { run, fetched } = await wired([{ action: "github_api", resource: "*", effect: "deny" }], JELLY)
    expect((await run()).owner).toEqual(OWNER)
    expect(fetched).toEqual(SENT)
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
    ["GET /search/*", []],
    ["GET /notifications", ["/search/issues", "/search/issues", "/search/commits"]],
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
      { method: "GET" as const, path: "/user" },
      { method: "POST" as const, path: "/search/issues" },
      { method: "DELETE" as const, path: "/notifications" },
    ]) {
      await expect(api.run(input, script, scope)).rejects.toThrow(/^PERMISSION_DENIED: github_events_list reads only GET \/search\/issues, /)
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
    const result = redirecting.run({ method: "GET", path: "/notifications" }, { ...call, script: true }, { action: EVENTS_ACTION, resources: EVENTS_READS })
    await expect(result).rejects.toThrow(/reads only .*, not GET \/repos\/octo\/app/)
    expect(fetched).toEqual(["/notifications"])
  })

  it("probe asserts github_probe, then github_probe on GET /user before it is sent, and nothing else", async () => {
    const { probe, fetched, asserted } = await wired([], [{ action: PROBE_ACTION, resource: "*", effect: "allow" }])
    expect(await probe()).toEqual({ source: SOURCE, account: LOGIN, owner: OWNER, trust: "untrusted" })
    expect(fetched).toEqual(["/user"])
    expect(asserted).toEqual([`${PROBE_ACTION} *`, `${PROBE_ACTION} GET /user`])
    expect(PROBE_READS).toEqual(["GET /user"])
  })

  it("probe stops with nothing sent when the session denies github_probe", async () => {
    const { probe, fetched } = await wired([{ action: PROBE_ACTION, resource: "*", effect: "deny" }])
    await expect(probe()).rejects.toThrow(`refused: ${PROBE_ACTION} * (deny)`)
    expect(fetched).toEqual([])
  })
})
