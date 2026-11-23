// github_events_list against a synthetic GitHub: /search/issues and /search/commits filter by their qualifiers, sort
// ascending as asked (ties in GitHub's own order, here the opposite of the plugin's), and page by per_page and page;
// /notifications filters by since, lists newest first, and answers 403 for a sign-in that may not read it. The
// signed-in login is the sign-in's own (no GitHub call), as `registerApiTool`'s identity reads it. Every login,
// repository and link is made up.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { ApiOutput } from "../../src/api/contract.js"
import { registerApiTool } from "../../src/api/tool.js"
import { DEFAULT_TOOLSETS, GITHUB_COM } from "../../src/config.js"
import { signInAgain } from "../../src/device-flow.js"
import { GitHubPluginError } from "../../src/errors.js"
import { encodeBoundCursor, encodeCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { EVENT_LIMITS, PAGE, assertEventsListConformance, canonicalCode, resultProblems, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { checkOutput } from "@we-the-rebel-alliance/source-contract/registry"
import { type Rule, defaultRules, effectOf } from "../../src/permissions.js"
import {
  EVENTS_ACTION,
  EVENTS_INPUT,
  EVENTS_METHOD_OUTPUT,
  EVENTS_OUTPUT,
  EVENTS_READS,
  NAMESPACE,
  NOTIFICATIONS_LIST,
  NOTIFICATION_RETENTION_MS,
  PAGE_BYTES,
  PROBE_ACTION,
  PROBE_READS,
  SETTLE_MS,
  SOURCE,
  commitItem,
  eventsMethod,
  isNotificationsList,
  issueItem,
  listEvents,
  listNotifications,
  loginOf,
  notificationItem,
  orderKey,
  probeEvents,
  probeMethod,
  registerEventsTool,
  runEvents,
  runProbe,
  runSource,
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

/** The events from SINCE at NOW, oldest first; ties by stream, then by the plugin's order key, a hash of the id. */
const EXPECTED = [
  "octo/app@a1",
  "octo/app#1@2026-10-01T09:00:00.000Z",
  "octo/app#2@2026-10-02T10:00:00.000Z",
  "octo/lib@b2",
  ...["octo/app#8", "octo/app#9", "octo/lib#7"].sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1)).map((id) => `${id}@2026-10-05T08:00:00.000Z`),
  "notification:n2@2026-10-06T10:00:00.000Z",
  ...Array.from({ length: 4 }, (_, index) => `octo/lib#${20 + index}@2026-10-2${index}T12:00:00.000Z`),
]

const ok = (data: unknown): ApiOutput => ({ ok: true, status: 200, data, truncated: false, trust: { githubContent: "untrusted" } })

function github(options: { perPage?: number; notifications?: "ok" | "forbidden" | "gone"; login?: string; inbox?: typeof NOTIFICATIONS; incomplete?: number; issues?: typeof ISSUES; commits?: typeof COMMITS; cutNotifications?: boolean; unordered?: boolean } = {}) {
  const calls: { path: string; query: Record<string, unknown> }[] = []
  /** How many issue searches GitHub still answers as timed out, with incomplete_results. */
  let incomplete = options.incomplete ?? 0
  /**
   * An answer as github_api gives it: over `maxBytes` it keeps the whole list items that fit, and says `truncated`.
   * `maxBytes` is what the caller reads whole: 100,000 unless events_list's own search reads set more.
   */
  const capped = (data: { total_count: number; incomplete_results: boolean; items: unknown[] }, maxBytes?: number) => {
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "")
    const max = maxBytes ?? 100_000
    if (bytes(data) <= max) return ok(data)
    const kept: unknown[] = []
    let used = bytes({ ...data, items: [] })
    for (const item of data.items) {
      used += bytes(item) + 1
      if (used > max) break
      kept.push(item)
    }
    return { ...ok({ ...data, items: kept }), truncated: true }
  }
  const get = async (path: string, query: Record<string, string | number | boolean>, maxBytes?: number) => {
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
    if (path === "/user") return ok({ login: options.login ?? LOGIN })
    if (path === "/search/issues") {
      expect(String(query.q)).toContain(`involves:${options.login ?? LOGIN}`)
      // As GitHub answers a GitHub App user token: a search for issues and pull requests together is refused.
      const kind = /(?:^|\s)is:(issue|pull-request)(?:\s|$)/.exec(String(query.q))?.[1]
      if (kind === undefined) return { ok: false, status: 422, data: { message: "Validation Failed" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput
      const all = (options.issues ?? ISSUES).filter((item) => within(item.updated_at, "updated") && ("pull_request" in item) === (kind === "pull-request")).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || b.number - a.number)
      // A search that timed out answers what it found so far: here, nothing past its first result.
      if (incomplete > 0) return incomplete--, ok({ total_count: all.length, incomplete_results: true, items: all.slice(0, 1) })
      return capped({ total_count: all.length, incomplete_results: false, items: pageOf(all) }, maxBytes)
    }
    if (path === "/search/commits") {
      const all = (options.commits ?? COMMITS).filter((item) => within(item.commit.committer.date, "committer-date"))
      return capped({ total_count: all.length, incomplete_results: false, items: pageOf(all) }, maxBytes)
    }
    if (path === "/notifications") {
      if (options.notifications === "forbidden") return { ok: false, status: 403, data: { message: "Resource not accessible" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput
      if (options.notifications === "gone") return { ok: false, status: 404, data: { message: "Not Found" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput
      const since = query.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(String(query.since))
      // before is exclusive; since inclusive.
      const before = query.before === undefined ? Number.POSITIVE_INFINITY : Date.parse(String(query.before))
      // GitHub lists notifications newest first; `unordered` answers the inbox in its own order, whatever it is.
      const all = (options.inbox ?? NOTIFICATIONS).filter((item) => Date.parse(item.updated_at) >= since && Date.parse(item.updated_at) < before).sort((a, b) => options.unordered === true ? 0 : Date.parse(b.updated_at) - Date.parse(a.updated_at))
      // `unordered` answers the whole inbox in its own order, however many per_page asks for: the list must sort and
      // then cap it itself.
      const listed = options.unordered === true ? all : all.slice((page - 1) * Number(query.per_page), page * Number(query.per_page))
      // A bare list over the limit is cut to a string, as capInline cuts one: no items, and truncated.
      if (options.cutNotifications === true) return { ...ok(JSON.stringify(listed).slice(0, 100)), truncated: true } as ApiOutput
      if (Buffer.byteLength(JSON.stringify(listed)) > (maxBytes ?? 100_000)) return { ...ok(JSON.stringify(listed).slice(0, maxBytes ?? 100_000)), truncated: true } as ApiOutput
      return ok(listed)
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
      kind: "event",
      external_id: "octo/app#2@2026-10-02T10:00:00.000Z",
      thread: "github:octo/app#2",
      title: "octo/app#2: Item 2",
      url: "https://github.com/octo/app/pull/2",
      labels: ["pr", "merged", "needs-review"],
      actors: [{ role: "author", id: "github:someone-else" }, { role: "assignee", id: `github:${LOGIN}` }],
    })
    // The one declared kind, with what it was kept in the labels.
    expect(issueItem(ISSUES[0], LOGIN)!.event).toMatchObject({ kind: "event", labels: ["issue", "open", "needs-review"] })
    expect(issueItem({ number: 1 }, LOGIN)).toBeUndefined()
  })

  it("makes a commit one event at its committer date, with a mailto: author when GitHub links no login", () => {
    expect(commitItem(COMMITS[0], LOGIN)!.event).toMatchObject({ kind: "event", labels: ["commit"], occurred_at: "2026-10-01T09:00:00.000Z", title: "octo/app: Fix the parser", actors: [{ role: "author", id: `github:${LOGIN}` }] })
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

  // A consumer confirms one kind from the declaration (`sources.items[].reads`) and refuses every event of another, so
  // every event a page emits must be that one kind, for every item declared to read events.
  it("emits only the kind its declaration reads, for every declared event source", async () => {
    const items = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { sources: { items: { id: string; kind: string; reads?: string; input?: Record<string, unknown> }[] } }).sources.items
    let checked = 0
    for (const item of items) {
      if (item.kind !== "events") {
        expect(item.reads, `${item.id} is not an events source, so it declares no kind to read`).toBeUndefined()
        continue
      }
      checked++
      const result = (await list()({ ...item.input, since: SINCE, limit: PAGE.max })) as EventsListResult
      const kinds = [...new Set(result.events.map((event) => event.kind))]
      expect(result.events.length, `${item.id} listed no events to check`).toBeGreaterThan(0)
      expect(kinds.filter((kind) => kind !== item.reads), `${item.id} reads ${item.reads}, but its events are ${kinds.join(", ")}`).toEqual([])
    }
    expect(checked).toBe(1)
  })

  // The conformance kit's own check for the same rule: a fixture naming `kinds` refuses an event of another kind.
  it("keeps the conformance kit's kinds check, every event the kind its declaration reads", async () => {
    const items = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { sources: { items: { id: string; kind: string; reads?: string }[] } }).sources.items
    const activity = items.find((item) => item.id === "github.activity")!
    await assertEventsListConformance(list(), { ...FINAL, source: SOURCE, owner: OWNER, since: SINCE, expected: EXPECTED, pageSize: 2, kinds: [activity.reads!] })
  })

  // GitHub answering three results a page, fewer than asked: a search pages by time, reading each page's last second
  // again, so ties cross a page and one call still lists everything within its six requests a stream.
  it("keeps it with the source named and GitHub's pages of three, where ties cross a page", async () => {
    await assertEventsListConformance(list(github({ perPage: 3 })), { ...FINAL, source: SOURCE, sourceInput: true, since: SINCE, expected: EXPECTED, pageSize: 3 })
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

  it("asks GitHub's searches oldest first, from whole seconds up to the read's cut, and reads notifications only as participating", async () => {
    const fake = github()
    await list(fake)({ since: "2026-10-01T09:00:00.500Z" })
    // The cut is NOW less SETTLE_MS, 11:55:00: nothing newer is this read's.
    expect(fake.calls.filter((call) => call.path === "/search/issues").map((call) => call.query)).toEqual([
      { q: `is:issue involves:${LOGIN} updated:2026-10-01T09:00:00Z..2026-11-08T11:55:00Z`, sort: "updated", order: "asc", per_page: 100, page: 1 },
      { q: `is:pull-request involves:${LOGIN} updated:2026-10-01T09:00:00Z..2026-11-08T11:55:00Z`, sort: "updated", order: "asc", per_page: 100, page: 1 },
    ])
    expect(fake.calls.find((call) => call.path === "/search/commits")!.query).toMatchObject({ q: `author:${LOGIN} committer-date:2026-10-01T09:00:00Z..2026-11-08T11:55:00Z`, sort: "committer-date", order: "asc" })
    expect(fake.calls.find((call) => call.path === "/notifications")!.query).toMatchObject({ all: true, participating: true, since: "2026-10-01T09:00:00Z" })
  })

  it("lists issues and pull requests from two searches, one is:issue and one is:pull-request, as a GitHub App token needs", async () => {
    const fake = github()
    const result = (await list(fake)({ since: SINCE, limit: PAGE.max })) as EventsListResult
    // The one kind the source declares, which a consumer confirms; what each event was stays in its labels.
    expect(new Set(result.events.map((event) => event.kind))).toEqual(new Set(["event"]))
    expect(result.events.find((event) => event.external_id === "octo/app#2@2026-10-02T10:00:00.000Z")!.labels).toContain("pr")
    expect(result.events.find((event) => event.external_id === "octo/app#1@2026-10-01T09:00:00.000Z")!.labels).toContain("issue")
    expect(result.events.find((event) => event.external_id === "octo/app@a1")!.labels).toContain("commit")
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

  it("reads a cursor of 0.0.2 for this sign-in, and refuses only a cursor no release wrote, or another sign-in's", async () => {
    const owner = createHash("sha256").update(OWNER.id).digest("hex").slice(0, 16)
    const positions = { i: [Date.parse(SINCE), ""], c: [Date.parse(SINCE), ""], n: [Date.parse(SINCE), ""] }
    // Contract 1's cursor, as 0.0.2 wrote it: account default and the owner's hash. It lists what came after.
    const legacy = encodeCursor(SOURCE, { a: "default", o: owner, p: positions })
    const read = (await listEvents(github().get, github().identity, { account: "default", cursor: legacy, limit: PAGE.max }, NOW)) as EventsListResult
    expect(read.events.map((event) => event.external_id)).toEqual(EXPECTED)
    const refused = async (cursor: string) => {
      const fake = github()
      const error = await listEvents(fake.get, fake.identity, { account: LOGIN, cursor }, NOW).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(GitHubPluginError)
      expect((error as GitHubPluginError).code).toBe("CURSOR_INVALID")
      expect((error as GitHubPluginError).nextStep).toBe("Call events_list without a cursor, with since, to start again.")
      expect(fake.calls).toEqual([])
    }
    // Another sign-in's 0.0.2 cursor, and one that names an account 0.0.2 never wrote.
    await refused(encodeCursor(SOURCE, { a: "default", o: "0".repeat(16), p: positions }))
    await refused(encodeCursor(SOURCE, { a: LOGIN, o: owner, p: positions }))
    const bound = (state: Record<string, unknown>) => encodeBoundCursor({ plugin: NAMESPACE, source: SOURCE, account: LOGIN }, { a: LOGIN, o: owner, ...state })
    const streams = { i: [Date.parse(SINCE), ""], p: [Date.parse(SINCE), ""], c: [Date.parse(SINCE), ""], n: [Date.parse(SINCE), ""] }
    // 0.0.5's shape is read; with a read's cut but no lookback, no release wrote it.
    expect(((await listEvents(github().get, github().identity, { account: LOGIN, cursor: bound({ p: streams }), limit: PAGE.max }, NOW)) as EventsListResult).events.map((event) => event.external_id)).toEqual(EXPECTED)
    await refused(bound({ p: streams, u: NOW }))
    // Format 1 always holds its lookback, and there is no format 2.
    await refused(bound({ k: 1, p: [["0", ""], ["0", ""], ["0", ""], ["0", ""]] }))
    await refused(bound({ k: 2, p: [["0", ""], ["0", ""], ["0", ""], ["0", ""]], l: ["0", []] }))
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

  it("stops with UNAVAILABLE on a failed search", async () => {
    const failing = async () => ({ ok: false, status: 422, data: {}, truncated: false, trust: { githubContent: "untrusted" } }) as ApiOutput
    expect(await code(listEvents(failing, github().identity, { since: SINCE }, NOW))).toBe("UNAVAILABLE")
  })
})

describe("GitHub's notification answers, read whole", () => {
  // A notification is about 4.7 KB in GitHub's own example: 60 of them are about 280 KB, over the agent's cap.
  const T = Date.parse("2026-11-01T00:00:00Z")
  const posts = Array.from({ length: 60 }, (_, k) => ({
    id: `${9000 + k}`,
    reason: "subscribed",
    updated_at: new Date(T + k * 60_000).toISOString().replace(".000Z", "Z"),
    subject: { title: `v${k} ${"x".repeat(4_600)}`, type: "Release" },
    repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" },
  }))

  it("reads 60 notifications of about 280 KB whole, and lists each once", async () => {
    const fake = github({ issues: [], commits: [], inbox: posts })
    const result = (await list(fake)({ since: "2026-10-31T00:00:00Z", limit: PAGE.max })) as EventsListResult
    expect(result.events).toHaveLength(60)
    expect(new Set(result.events.map((event) => event.external_id)).size).toBe(60)
    expect(result.more).toBe(false)
    // A page of 50 of them is about 235 KB: over the 100,000-byte cap an answer shown to an agent gets.
    expect(fake.calls.filter((call) => call.path === "/notifications").at(-1)!.query).toMatchObject({ per_page: 50 })
  })

  it("names the 32 MB limit for a notifications answer over it, and never UNAVAILABLE", async () => {
    const huge = posts.map((post, k) => ({ ...post, id: `${8000 + k}`, subject: { title: "y".repeat(900_000), type: "Release" } }))
    const fake = github({ issues: [], commits: [], inbox: huge })
    const refused = (await listEvents(fake.get, fake.identity, { since: "2026-10-31T00:00:00Z", limit: PAGE.max }, NOW).catch((error: unknown) => error)) as GitHubPluginError
    expect(refused).toBeInstanceOf(GitHubPluginError)
    expect(refused.code).toBe("TOO_LARGE")
    expect(refused.detail).toContain("/notifications")
    expect(refused.detail).toContain("32 MB")
  })

  it("gives every events_list read path the 32 MB limit, so none is left on the agent's cap", () => {
    const source = readFileSync(new URL("../../src/source-events.ts", import.meta.url), "utf8")
    const reads = source.split("\n").filter((line) => line.includes("list(get,"))
    expect(reads).toHaveLength(3)
    expect(reads.every((line) => line.includes("EVENTS_MAX_BYTES"))).toBe(true)
  })
})

describe("a crowded second at a page of 100", () => {
  it("lists 980 issues, 400 pull requests and 400 commits in one second once each, at limit 200", async () => {
    // The pull requests and commits are spread over the minute before the crowded second, so their searches page in
    // full every call, as the reviewer's case had them.
    const T = "2026-11-02T00:00:00Z"
    const before = Date.parse("2026-11-01T23:00:00Z")
    const at = (k: number) => new Date(before + k * 1000).toISOString().replace(".000Z", "Z")
    const issues = [
      ...Array.from({ length: 980 }, (_, k) => issue("octo/big", 1000 + k, T)),
      ...Array.from({ length: 400 }, (_, k) => issue("octo/big", 5000 + k, at(k), { pull_request: { merged_at: null }, html_url: `https://github.com/octo/big/pull/${5000 + k}` })),
    ]
    const commits = Array.from({ length: 400 }, (_, k) => ({ sha: `r${String(k).padStart(5, "0")}`, html_url: `https://github.com/octo/big/commit/r${k}`, repository: { full_name: "octo/big" }, author: { login: LOGIN }, commit: { message: "c", author: { name: "O", email: "o@example.test", date: at(k) }, committer: { date: at(k) } } }))
    const fake = github({ issues, commits, inbox: [] })
    const seen: string[] = []
    const counts: number[] = []
    let cursor: string | undefined
    for (let call = 0; call < 40; call++) {
      const page = (await list(fake)(cursor === undefined ? { since: "2026-10-31T00:00:00Z", limit: 200 } : { account: LOGIN, cursor, limit: 200 })) as EventsListResult
      seen.push(...page.events.map((event) => event.external_id))
      counts.push(page.events.length)
      if (!page.more) break
      cursor = page.cursor
    }
    // The pull-request and commit searches run first, and a second read whole at a page of 100 leaves the budget for it.
    expect(seen).toHaveLength(1780)
    expect(new Set(seen).size).toBe(1780)
    expect(seen.filter((id) => id.startsWith("octo/big#"))).toHaveLength(1380)
    expect(seen.filter((id) => id.startsWith("octo/big@"))).toHaveLength(400)
    // No more calls than master's eleven, so the second read is never starved of the budget: a second listed in part is
    // read first by the next call.
    expect(counts.length).toBeLessThanOrEqual(11)
  })
})

describe("GitHub's own search answers, read whole", () => {
  const BASE = Date.parse("2026-10-02T00:00:00Z")
  const many = (count: number, body: number, first = 1) => Array.from({ length: count }, (_, k) => issue("octo/big", first + k, new Date(BASE + k * 1000).toISOString().replace(".000Z", "Z"), { body: "x".repeat(body) }))
  const listed = (all: ReturnType<typeof issue>[]) => all.map((item) => `octo/big#${item.number}@${new Date(Date.parse(item.updated_at)).toISOString()}`)

  it("reads a 2.5 MB page of 100 results whole, and lists every result once", async () => {
    const all = many(100, 25_000)
    const fake = github({ issues: all, commits: [], inbox: [] })
    const result = (await list(fake)({ since: SINCE, limit: PAGE.max })) as EventsListResult
    // 100 results of 25,000 characters is about 2.5 MB: over the 100,000-byte cap an answer shown to an agent gets.
    expect(result.events.map((event) => event.external_id)).toEqual(listed(all))
    expect(result.more).toBe(false)
    expect(fake.calls.filter((call) => call.path === "/search/issues").at(-1)!.query).toMatchObject({ per_page: 100 })
  })

  it("reads one result whose body is GitHub's 65,536-character limit, and keeps the event within the contract's", async () => {
    const all = many(1, 65_536)
    const result = (await list(github({ issues: all, commits: [], inbox: [] }))({ since: SINCE })) as EventsListResult
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.text).toHaveLength(EVENT_LIMITS.text)
  })

  it("lists two results over the old 100,000-byte cap once each, where a cut page used to lose them", async () => {
    const all = many(2, 120_000)
    const result = (await list(github({ issues: all, commits: [], inbox: [] }))({ since: SINCE, limit: PAGE.max })) as EventsListResult
    expect(result.events.map((event) => event.external_id)).toEqual(listed(all))
    expect(result.more).toBe(false)
  })

  it("lists 37 results once, in one page, with more false", async () => {
    const all = many(37, 2_000)
    const result = (await list(github({ issues: all, commits: [], inbox: [] }))({ since: SINCE, limit: PAGE.max })) as EventsListResult
    expect(result.events).toHaveLength(37)
    expect(new Set(result.events.map((event) => event.external_id)).size).toBe(37)
    expect(result.more).toBe(false)
  })

  it("reads an answer over 32 MB again in pages of 10, and lists every result once, with no gap", async () => {
    // 100 results of 340,000 characters is about 34 MB: more than events_list reads whole, so the same point is read
    // again in pages of 10, about 3.4 MB each.
    const all = many(100, 340_000)
    const fake = github({ issues: all, commits: [], inbox: [] })
    const seen: string[] = []
    let cursor: string | undefined
    for (let call = 0; call < 40; call++) {
      const page = (await list(fake)(cursor === undefined ? { since: SINCE, limit: PAGE.max } : { account: LOGIN, cursor, limit: PAGE.max })) as EventsListResult
      expect(page.gap).toBeUndefined()
      seen.push(...page.events.map((event) => event.external_id))
      if (!page.more) break
      cursor = page.cursor
    }
    expect(seen).toEqual(listed(all))
    expect(fake.calls.filter((call) => call.path === "/search/issues").some((call) => call.query.per_page === 10)).toBe(true)
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
  /** The notifications' position in a cursor: the fourth of its positions, a time in base 36 (`~` and milliseconds inside a second). */
  const positionN = (cursor: string) => {
    const time = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { p: [string, string][] }).p[3]![0]
    return time.startsWith("~") ? Number.parseInt(time.slice(1), 36) : Number.parseInt(time, 36) * 1000
  }

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

describe("the notifications list", () => {
  /** Newest first, as GitHub's inbox answers: read and unread, and an issue notification the events feed leaves to its issue stream. */
  const INBOX = [
    { id: "9001", reason: "review_requested", updated_at: "2026-11-08T11:00:00Z", subject: { title: "Add the parser", type: "PullRequest" }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } },
    { id: "9002", reason: "subscribed", updated_at: "2026-11-08T10:00:00Z", subject: { title: "v2.0.0", type: "Release" }, repository: { full_name: "octo/lib", html_url: "https://github.com/octo/lib" } },
    { id: "9003", reason: "mention", updated_at: "2026-11-08T09:00:00Z", subject: { title: "Deploy broke: password=hunter2 in the URL", type: "Issue" }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } },
    { id: "9004", reason: "team_mention", updated_at: "2026-11-08T08:00:00Z", subject: { type: "Discussion" }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } },
    { id: "9005", updated_at: "2026-11-08T07:00:00Z", subject: { title: "A title with no reason", type: "CheckSuite" }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } },
  ]

  it("lists the latest notifications as the contract's list output, newest first", async () => {
    const fake = github({ inbox: INBOX as typeof NOTIFICATIONS })
    const result = await listNotifications(fake.get, fake.identity, { source: SOURCE, list: NOTIFICATIONS_LIST, account: LOGIN }, NOW)
    expect(result).toMatchObject({ account: LOGIN, asOf: new Date(NOW).toISOString(), trust: "untrusted", data: { editable: false } })
    // The secret is left out; an issue notification and a read one are listed, unlike the activity feed's; a subject
    // with no title falls back to its type.
    expect(result.data.items).toEqual([
      { id: "9001", text: "Add the parser", note: "octo/app, review requested" },
      { id: "9002", text: "v2.0.0", note: "octo/lib, subscribed" },
      { id: "9004", text: "Discussion", note: "octo/app, team mention" },
      { id: "9005", text: "A title with no reason", note: "octo/app" },
    ])
    // One GET, GitHub's inbox as it is: every notification, read or unread, and not only threads the person joins.
    expect(fake.calls.map((call) => call.path)).toEqual(["/notifications"])
    expect(fake.calls[0]!.query).toEqual({ all: true, per_page: 50 })
    // The output is the contract's list: ids, texts of at most 200, no other key.
    expect(checkOutput("list", result.data, undefined).ok).toBe(true)
  })

  it("sorts newest first before the 50 cap, so the newest 50 are listed whatever order GitHub answers in", async () => {
    // 60 notifications, oldest first in the answer: the newest 50 are listed, and the 10 oldest are not.
    const base = Date.parse("2026-11-08T12:00:00Z")
    const oldestFirst = Array.from({ length: 60 }, (_, index) => ({
      id: `8${index}`,
      reason: "subscribed",
      updated_at: new Date(base - (59 - index) * 60_000).toISOString(),
      subject: { title: `Notification ${index}`, type: "Release" },
      repository: { full_name: "octo/app" },
    }))
    const fake = github({ inbox: oldestFirst as typeof NOTIFICATIONS, unordered: true })
    const result = await listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)
    expect(result.data.items).toHaveLength(50)
    // The newest first, and the ten oldest are the ones left out.
    expect(result.data.items[0]!.id).toBe("859")
    expect(result.data.items.at(-1)!.id).toBe("810")
    expect(result.data.items.some((item) => item.id === "89")).toBe(false)
  })

  it("returns no more than the list's 50 items", async () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ id: `7${index}`, reason: "subscribed", updated_at: `2026-11-08T${String(index % 12).padStart(2, "0")}:00:00Z`, subject: { title: `Notification ${index}`, type: "Release" }, repository: { full_name: "octo/app" } }))
    const fake = github({ inbox: many as typeof NOTIFICATIONS })
    const result = await listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)
    expect(result.data.items).toHaveLength(50)
    // Asked for 50, GitHub answers at most that; the cap holds even if it answers more.
    expect(fake.calls[0]!.query["per_page"]).toBe(50)
  })

  it("matches the family: a title with a secret is left out, and so is a notification it cannot render", async () => {
    const weird = [
      { id: "1", reason: "subscribed", updated_at: "2026-11-08T10:00:00Z", subject: { title: "ghp_" + "a".repeat(36), type: "Release" }, repository: {} },
      { reason: "subscribed", updated_at: "2026-11-08T09:00:00Z", subject: { title: "No id", type: "Release" } },
      { id: "3", subject: { title: "No time", type: "Release" } },
      "not an object",
      { id: "4", reason: "subscribed", updated_at: "2026-11-08T08:00:00Z", subject: {} },
    ]
    const fake = github({ inbox: weird as typeof NOTIFICATIONS })
    const result = await listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)
    expect(result.data.items).toEqual([])
  })

  it("answers an empty list where the sign-in may not read notifications", async () => {
    for (const notifications of ["forbidden", "gone"] as const) {
      const fake = github({ notifications })
      const result = await listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)
      expect(result.data.items).toEqual([])
    }
  })

  it("answers TOO_LARGE for an answer over the 32 MB it reads whole, as the activity feed's notifications do", async () => {
    const fake = github({ cutNotifications: true })
    expect(await code(listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW))).toBe("TOO_LARGE")
  })

  it("refuses a list it does not have, another source, and another account, before GitHub is called", async () => {
    const fake = github()
    expect(await code(listNotifications(fake.get, fake.identity, { list: "bookmarks" }, NOW))).toBe("SOURCE_UNKNOWN")
    expect(await code(listNotifications(fake.get, fake.identity, { source: "gitlab", list: NOTIFICATIONS_LIST }, NOW))).toBe("SOURCE_UNKNOWN")
    expect(await code(listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST, account: "someone-else" }, NOW))).toBe("ACCOUNT_MISMATCH")
    expect(await code(listNotifications(fake.get, async () => undefined, { list: NOTIFICATIONS_LIST }, NOW))).toBe("AUTH_REQUIRED")
    expect(fake.calls).toEqual([])
  })

  it("screens the whole title before it cuts, so a secret straddling the cut is still left out", async () => {
    // 195 characters, then a secret that starts at 196: cut first, the answer would hold " password=hu".
    const title = "x".repeat(195) + " password=hunter2 and more"
    const fake = github({ inbox: [{ id: "1", reason: "subscribed", updated_at: "2026-11-08T10:00:00Z", subject: { title, type: "Issue" }, repository: { full_name: "octo/app" } }] as typeof NOTIFICATIONS })
    const result = await listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)
    expect(result.data.items).toEqual([])
    // The same title without the secret is cut to 200, and screened whole.
    const long = github({ inbox: [{ id: "2", reason: "subscribed", updated_at: "2026-11-08T10:00:00Z", subject: { title: "y".repeat(240), type: "Issue" }, repository: { full_name: "octo/app" } }] as typeof NOTIFICATIONS })
    const cut = await listNotifications(long.get, long.identity, { list: NOTIFICATIONS_LIST }, NOW)
    expect(cut.data.items[0]!.text).toBe("y".repeat(200))
  })

  it("sorts newest first and lists one notification once, whatever order GitHub answers in", async () => {
    const shuffled = [
      { id: "1", reason: "subscribed", updated_at: "2026-11-08T09:00:00Z", subject: { title: "Older", type: "Issue" }, repository: {} },
      { id: "2", reason: "subscribed", updated_at: "2026-11-08T11:00:00Z", subject: { title: "Newest", type: "Issue" }, repository: {} },
      { id: "1", reason: "subscribed", updated_at: "2026-11-08T09:00:00Z", subject: { title: "Older again", type: "Issue" }, repository: {} },
      { id: "3", reason: "subscribed", updated_at: "2026-11-08T10:00:00Z", subject: { title: "Middle", type: "Issue" }, repository: {} },
    ]
    const fake = github({ inbox: shuffled as typeof NOTIFICATIONS })
    const result = await listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)
    expect(result.data.items.map((item) => item.text)).toEqual(["Newest", "Middle", "Older"])
  })

  it("stays inside the source's 64 KB by dropping whole items, and says it shortened the list", async () => {
    // 50 maximal items of three-byte characters: the id at 128 characters, the text at 200 and the note at 200, so 50
    // of them cannot fit 64 KB.
    const huge = Array.from({ length: 50 }, (_, index) => ({
      id: `9${index}${"字".repeat(128)}`,
      reason: "subscribed",
      updated_at: "2026-11-08T10:00:00Z",
      subject: { title: "字".repeat(200), type: "Issue" },
      repository: { full_name: "字".repeat(200) },
    }))
    const fake = github({ inbox: huge as typeof NOTIFICATIONS })
    const result = (await listNotifications(fake.get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)) as { shortened?: boolean; data: { items: { text: string }[] } }
    expect(result.shortened).toBe(true)
    expect(result.data.items.length).toBeGreaterThan(0)
    expect(result.data.items.length).toBeLessThan(50)
    // Whole items, never cut bytes: every text is still 200 characters.
    for (const item of result.data.items) expect([...item.text]).toHaveLength(200)
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(65_536)
    expect(checkOutput("list", result.data, undefined).ok).toBe(true)
    // A normal page is not marked.
    const normal = (await listNotifications(github({ inbox: INBOX as typeof NOTIFICATIONS }).get, fake.identity, { list: NOTIFICATIONS_LIST }, NOW)) as { shortened?: boolean }
    expect(normal.shortened).toBeUndefined()
  })

  it("is what events_list does with a list, and nothing else changes", () => {
    expect(isNotificationsList({ list: NOTIFICATIONS_LIST })).toBe(true)
    expect(isNotificationsList({ list: "bookmarks" })).toBe(true)
    expect(isNotificationsList({ since: SINCE })).toBe(false)
    expect(isNotificationsList(undefined)).toBe(false)
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

  it("registers the model tool with the events schema alone: no list input, no list answer", async () => {
    const { deps: d } = deps()
    const added: Record<string, unknown>[] = []
    const ctx = {
      permission: (d as { ctx: unknown }).ctx,
      tool: {
        transform: async (edit: (editor: { add: (tool: Record<string, unknown>) => void }) => void) => {
          await edit({ add: (tool) => void added.push(tool) })
          return { dispose: async () => {} }
        },
      },
    }
    await registerEventsTool(ctx as never, d)
    expect(added[0]).toMatchObject({ name: "events_list", input: EVENTS_INPUT, output: EVENTS_OUTPUT })
    expect("list" in ((added[0]!.input as { properties: Record<string, unknown> }).properties)).toBe(false)
  })

  it("are owned methods with their schemas, and allowed by the default rules at every access", async () => {
    const { deps: d } = deps()
    const method = eventsMethod(d)
    expect(method).toMatchObject({ name: "events_list", action: "github_events_list", class: "read", output: EVENTS_METHOD_OUTPUT })
    // `list` is the tools RPC method's alone: a model's tool schema is the events one.
    const rpcInput = method.input as { properties: Record<string, unknown> }
    expect(rpcInput.properties["list"]).toMatchObject({ enum: [NOTIFICATIONS_LIST] })
    expect("list" in EVENTS_INPUT.properties).toBe(false)
    expect(EVENTS_METHOD_OUTPUT.anyOf[0]).toBe(EVENTS_OUTPUT)
    expect(probeMethod(d)).toMatchObject({ name: "probe", action: "github_probe", class: "read" })
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      expect(effectOf(defaultRules(access), "github_events_list", "*")).toBe("allow")
      expect(effectOf(defaultRules(access), "github_probe", "*")).toBe("allow")
    }
    expect((await method.run({ since: "2999-01-01" }, { ...call, signal: new AbortController().signal, progress: async () => {} })) as EventsListResult).toMatchObject({ source: "github", events: [] })
  })
})

// A sign-in GitHub refuses, a renewal refused or a token rejected, is the source contract's sign-in failure on every
// source read and probe: AUTH_REQUIRED, which the contract reads as NEEDS_SIGN_IN. Any other code would reach a consumer
// as UNAVAILABLE, as though the source had changed.
describe("a sign-in GitHub refuses, on a source read", () => {
  const refused = async () => {
    throw signInAgain("GitHub")
  }
  const unauthorized = (fake = github()) => async (path: string, query: Record<string, string | number | boolean>, maxBytes?: number) =>
    path === "/notifications" ? fake.get(path, query, maxBytes) : ({ ok: false, status: 401, data: { message: "Bad credentials" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput)
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      return error instanceof GitHubPluginError ? { code: error.code, next: error.nextStep, canonical: canonicalCode(error.code) } : String(error)
    }
    return undefined
  }
  const SIGN_IN = { code: "AUTH_REQUIRED", next: "Run /connect and choose GitHub to sign in again.", canonical: "NEEDS_SIGN_IN" }

  it("is AUTH_REQUIRED when the renewal is refused, with the sign-in's next step", async () => {
    expect(await refusal(probeEvents(github().get, refused, {}))).toEqual(SIGN_IN)
    expect(await refusal(listEvents(github().get, refused, { since: SINCE }, NOW))).toEqual(SIGN_IN)
    expect(await refusal(listNotifications(github().get, refused, { list: NOTIFICATIONS_LIST }, NOW))).toEqual(SIGN_IN)
  })

  it("is AUTH_REQUIRED when GitHub rejects the token with 401", async () => {
    expect(await refusal(probeEvents(unauthorized(), github().identity, {}))).toMatchObject({ code: "AUTH_REQUIRED", canonical: "NEEDS_SIGN_IN" })
    expect(await refusal(listEvents(unauthorized(), github().identity, { since: SINCE }, NOW))).toMatchObject({ code: "AUTH_REQUIRED", canonical: "NEEDS_SIGN_IN" })
  })

  it("is AUTH_REQUIRED when the renewal is refused between the sign-in check and a request", async () => {
    const fake = github()
    const deps = {
      ctx: { permission: { assert: async () => {} } },
      api: { run: refused },
      identity: fake.identity,
      now: () => NOW,
    } as never
    const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }
    expect(await refusal(runProbe(deps, {}, call))).toEqual(SIGN_IN)
    expect(await refusal(runEvents(deps, { since: SINCE }, call))).toEqual(SIGN_IN)
    expect(await refusal(runSource(deps, { source: SOURCE, list: NOTIFICATIONS_LIST }, call))).toEqual(SIGN_IN)
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
    return { run: () => runEvents(deps as never, { since: SINCE }, call), probe: () => runProbe(deps as never, {}, call), list: () => runSource(deps as never, { source: SOURCE, list: NOTIFICATIONS_LIST, account: LOGIN }, call), api, fetched, asserted }
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

  it("reads the notifications list under the same allow, with one GET /notifications and no search", async () => {
    const { list, fetched, asserted } = await wired([], JELLY)
    const result = await list()
    expect(result).toMatchObject({ account: LOGIN, data: { items: [], editable: false }, trust: "untrusted" })
    expect(fetched).toEqual(["/notifications"])
    expect(asserted).toEqual([`${EVENTS_ACTION} *`, `${EVENTS_ACTION} GET /notifications`])
  })

  it("does not reach the notifications list from a rule that asks for or denies GET /notifications", async () => {
    for (const effect of ["ask", "deny"] as const) {
      const { list, fetched } = await wired([{ action: EVENTS_ACTION, resource: "GET /notifications", effect }], JELLY)
      await expect(list()).rejects.toThrow(/PERMISSION_DENIED/)
      expect(fetched).toEqual([])
    }
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
