// The review of #31's falsification probes (wave-B/github-31), kept as tests, with the cases the fixes added: a
// notification burst read at a small limit answers one gap; exactly 500 notifications answer none; 450, 1,000 and 5,000
// search results in one second never stall the feed (5,000, past GitHub's 1,000, answers one gap and moves on); a
// notification GitHub delivers late is listed once. The synthetic GitHub filters by `>=` and `a..b` qualifiers and
// `since` inclusively, answers at most 1,000 results for one search query with the real total_count, orders ties its
// own way (by descending sha or number, unlike the plugin), and lists notifications newest first. Every login,
// repository and link is made up.
import { describe, expect, it } from "vitest"
import type { ApiOutput } from "../../src/api/contract.js"
import { EVENT_LIMITS, resultProblems, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { NOTIFICATION_LOOKBACK_MS, PAGE_BYTES, SEARCH_BUDGET, SEARCH_CAP, SETTLE_MS, listEvents } from "../../src/source-events.js"

const LOGIN = "octo-person"
const NOW = Date.parse("2026-11-08T12:00:00Z")
const iso = (at: number) => new Date(at).toISOString()
const ok = (data: unknown): ApiOutput => ({ ok: true, status: 200, data, truncated: false, trust: { githubContent: "untrusted" } })
const issue = (n: number, updated: string) => ({ number: n, title: `Item ${n}`, body: "", state: "open", updated_at: updated, repository_url: "https://api.github.com/repos/octo/app", html_url: `https://github.com/octo/app/issues/${n}`, user: { login: "x" }, assignees: [], labels: [] })
const commit = (sha: string, date: string) => ({ sha, html_url: `https://github.com/octo/app/commit/${sha}`, repository: { full_name: "octo/app" }, author: { login: LOGIN }, commit: { message: `c ${sha}`, author: { name: "O", email: "o@example.test", date }, committer: { date } } })
const note = (id: string, updated: string, type = "Release") => ({ id, reason: "subscribed", updated_at: updated, subject: { title: id, type }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } })

function world(data: { issues?: ReturnType<typeof issue>[]; commits?: ReturnType<typeof commit>[]; inbox?: ReturnType<typeof note>[] }) {
  const calls: { path: string; query: Record<string, unknown> }[] = []
  const get = async (path: string, query: Record<string, string | number | boolean>) => {
    calls.push({ path, query })
    const per = Number(query.per_page)
    const page = Number(query.page ?? 1)
    const q = String(query.q ?? "")
    const within = (at: string, name: string) => {
      const match = new RegExp(`${name}:(?:>=(\\S+)|(\\S+)\\.\\.(\\S+))`).exec(q)!
      const t = Date.parse(at)
      return match[1] !== undefined ? t >= Date.parse(match[1]) : t >= Date.parse(match[2]!) && t <= Date.parse(match[3]!)
    }
    const answer = <T>(all: T[]) => ok({ total_count: all.length, incomplete_results: false, items: all.slice(0, SEARCH_CAP).slice((page - 1) * per, page * per) })
    if (path === "/search/issues") {
      const all = q.includes("is:pull-request") ? [] : (data.issues ?? []).filter((i) => within(i.updated_at, "updated")).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || b.number - a.number)
      return answer(all)
    }
    if (path === "/search/commits") {
      const all = (data.commits ?? []).filter((c) => within(c.commit.committer.date, "committer-date")).sort((a, b) => Date.parse(a.commit.committer.date) - Date.parse(b.commit.committer.date) || (a.sha < b.sha ? 1 : -1))
      return answer(all)
    }
    if (path === "/notifications") {
      const since = Date.parse(String(query.since))
      const all = (data.inbox ?? []).filter((n) => Date.parse(n.updated_at) >= since).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      return ok(all.slice((page - 1) * per, page * per))
    }
    throw new Error(path)
  }
  return { get, calls, identity: async () => LOGIN }
}
type World = ReturnType<typeof world>
const page = (w: World, now: number, input: Record<string, unknown>) => listEvents(w.get, w.identity, input, now) as Promise<EventsListResult>

/** Every page of one read, checking each against the contract and the search budget. */
async function read(w: World, now: number, input: Record<string, unknown>, most = 400) {
  const pages: EventsListResult[] = []
  let next = input
  for (let k = 0; k < most; k++) {
    const before = w.calls.filter((call) => call.path.startsWith("/search/")).length
    const result = await page(w, now, next)
    expect(w.calls.filter((call) => call.path.startsWith("/search/")).length - before).toBeLessThanOrEqual(SEARCH_BUDGET)
    // Within the declared maxBytes, as the kit checks it.
    expect(resultProblems(result, Number(next["limit"] ?? 100), PAGE_BYTES)).toEqual([])
    expect(result.cursor.length).toBeLessThanOrEqual(EVENT_LIMITS.cursor)
    pages.push(result)
    if (!result.more) return pages
    next = { account: LOGIN, cursor: result.cursor, limit: input["limit"] }
  }
  throw new Error(`the read did not end in ${most} pages: it stalled`)
}
const ids = (pages: EventsListResult[]) => pages.flatMap((p) => p.events.map((e) => e.external_id))
const gaps = (pages: EventsListResult[]) => pages.flatMap((p) => (p.gap ? [p.gap] : []))

describe("a notification burst (review MEDIUM 1)", () => {
  // 30 older issue changes, then releases one a minute.
  const issues = Array.from({ length: 30 }, (_, k) => issue(k + 1, iso(Date.parse("2026-10-31T01:00:00Z") + k * 60_000)))
  const releases = (count: number) => Array.from({ length: count }, (_, k) => note(`${1000 + k}`, iso(Date.parse("2026-11-01T00:00:00Z") + k * 60_000)))

  it("read at a small limit, answers its gap once, on the first page, and lists every notification after the oldest second it read", async () => {
    const inbox = releases(520)
    const pages = await read(world({ issues, inbox }), NOW, { since: "2026-10-31T00:00:00Z", limit: 5 })
    expect(gaps(pages)).toEqual([{ reason: "window-truncated", since: "2026-10-31T00:00:00.000Z" }])
    expect(pages[0]!.gap).toBeDefined()
    // One call reads the newest 500, down to the 21st: the 20 before it and the 21st's own second are the gap.
    expect(ids(pages).filter((id) => id.startsWith("notification:"))).toEqual(inbox.slice(21).map((n) => `notification:${n.id}@${n.updated_at}`))
    expect(ids(pages).filter((id) => !id.startsWith("notification:"))).toHaveLength(30)
  })

  it("of exactly 500 answers no gap, and lists them all", async () => {
    const inbox = releases(500)
    const pages = await read(world({ issues, inbox }), NOW, { since: "2026-10-31T00:00:00Z", limit: 50 })
    expect(gaps(pages)).toEqual([])
    expect(ids(pages).filter((id) => id.startsWith("notification:"))).toHaveLength(500)
  })
})

describe("search results in one second (review MEDIUM 2)", () => {
  const T = "2026-11-02T00:00:00Z"
  const feed = (count: number) => {
    const burst = Array.from({ length: count }, (_, k) => commit(`r${String(k).padStart(5, "0")}`, T))
    return world({ commits: [commit("c0", "2026-11-01T00:00:00Z"), ...burst, commit("z1", "2026-11-03T00:00:00Z")], inbox: [note("9001", "2026-11-04T00:00:00Z")] })
  }

  for (const count of [450, 460, SEARCH_CAP]) {
    it(`lists all ${count} of a rebase-merge's commits in one committer second, in order, and what comes after`, async () => {
      for (const limit of [100, 500]) {
        const pages = await read(feed(count), NOW, { since: "2026-10-31T00:00:00Z", limit })
        const listed = ids(pages)
        expect(gaps(pages)).toEqual([])
        expect(new Set(listed).size).toBe(listed.length)
        expect(listed).toEqual([
          "octo/app@c0",
          ...Array.from({ length: count }, (_, k) => `octo/app@r${String(k).padStart(5, "0")}`),
          "octo/app@z1",
          "notification:9001@2026-11-04T00:00:00.000Z",
        ])
      }
    })
  }

  it("answers one gap for a second with more results than GitHub answers (5,000), moves past it, and lists what comes after", async () => {
    const w = feed(5000)
    const pages = await read(w, NOW, { since: "2026-10-31T00:00:00Z", limit: 100 })
    expect(gaps(pages)).toEqual([{ reason: "window-truncated", since: "2026-11-02T00:00:00.000Z" }])
    expect(ids(pages)).toEqual(["octo/app@c0", "octo/app@z1", "notification:9001@2026-11-04T00:00:00.000Z"])
    // The second is never read again once passed: the next read starts after it.
    const again = await page(w, NOW + 60_000, { account: LOGIN, cursor: pages.at(-1)!.cursor })
    expect(again).toMatchObject({ events: [], more: false })
    expect(again.gap).toBeUndefined()
  })
})

describe("one gap per read", () => {
  it("answers one gap when a read finds two holes, notifications GitHub no longer keeps and then a 5,000-result second, and the next read answers its own", async () => {
    const T = "2026-11-02T00:00:00Z"
    const burst = Array.from({ length: 5000 }, (_, k) => commit(`r${String(k).padStart(5, "0")}`, T))
    const w = world({ commits: [commit("c0", "2026-07-02T00:00:00Z"), ...burst, commit("z1", "2026-11-03T00:00:00Z")], inbox: [note("9001", "2026-11-04T00:00:00Z")] })
    const pages = await read(w, NOW, { since: "2026-07-01T00:00:00Z", limit: 1 })
    expect(pages.length).toBeGreaterThan(2)
    expect(gaps(pages)).toEqual([{ reason: "window-truncated", since: "2026-07-01T00:00:00.000Z" }])
    expect(pages[0]!.gap).toBeDefined()
    expect(ids(pages)).toEqual(["octo/app@c0", "octo/app@z1", "notification:9001@2026-11-04T00:00:00.000Z"])
    // The read ended: the cursor no longer carries its gap, so a later read answers a gap of its own.
    const months = await page(w, NOW + 100 * 24 * 60 * 60_000, { account: LOGIN, cursor: pages.at(-1)!.cursor })
    expect(months.gap).toMatchObject({ reason: "expired" })
  })
})

describe("late arrivals", () => {
  it("lists a thread again at its new time when it is bumped after it was listed", async () => {
    const inbox = [note("7", "2026-11-05T00:00:00Z")]
    const w = world({ inbox })
    const first = await page(w, NOW, { since: "2026-11-01T00:00:00Z" })
    expect(first.events.map((e) => e.external_id)).toEqual(["notification:7@2026-11-05T00:00:00.000Z"])
    inbox[0] = note("7", iso(NOW + 60_000))
    const second = await page(w, NOW + 10 * 60_000, { account: LOGIN, cursor: first.cursor })
    expect(second.events.map((e) => e.external_id)).toEqual([`notification:7@${iso(NOW + 60_000)}`])
  })

  it("lists, once, a notification GitHub delivers more than SETTLE_MS after its time, behind the position (review L1)", async () => {
    const inbox = [note("1", "2026-11-05T00:00:00Z")]
    const w = world({ inbox })
    const first = await page(w, NOW, { since: "2026-11-01T00:00:00Z" })
    // Delivered 20 minutes late, stamped 15 minutes before the first read, and so behind its position.
    inbox.push(note("2", iso(NOW - 15 * 60_000)))
    const second = await page(w, NOW + 60 * 60_000, { account: LOGIN, cursor: first.cursor })
    expect(second.events.map((e) => e.external_id)).toEqual([`notification:2@${iso(NOW - 15 * 60_000)}`])
    expect(SETTLE_MS).toBeLessThan(15 * 60_000)
    // Read again, it is not listed twice, and neither is the first.
    const third = await page(w, NOW + 90 * 60_000, { account: LOGIN, cursor: second.cursor })
    expect(third.events).toEqual([])
  })

  it("lists one stamped before the last listed notification, inside the lookback, and never lists one twice", async () => {
    const inbox = Array.from({ length: 6 }, (_, k) => note(`${100 + k}`, iso(NOW - (3 - k * 0.25) * 60 * 60_000)))
    const w = world({ inbox })
    const first = await read(w, NOW, { since: "2026-11-08T00:00:00Z", limit: 2 })
    expect(ids(first)).toHaveLength(6)
    inbox.push(note("200", iso(NOW - 2 * 60 * 60_000 - 30_000)))
    const later = await read(w, NOW + 30 * 60_000, { account: LOGIN, cursor: first.at(-1)!.cursor, limit: 2 })
    expect(ids(later)).toEqual([`notification:200@${iso(NOW - 2 * 60 * 60_000 - 30_000)}`])
    const again = await read(w, NOW + 40 * 60_000, { account: LOGIN, cursor: later.at(-1)!.cursor, limit: 2 })
    expect(ids(again)).toEqual([])
  })

  it("does not look back further than NOTIFICATION_LOOKBACK_MS: one delivered later than that is not listed", async () => {
    const inbox = [note("1", iso(NOW - 60 * 60_000))]
    const w = world({ inbox })
    const first = await page(w, NOW, { since: "2026-11-08T00:00:00Z" })
    inbox.push(note("2", iso(NOW - NOTIFICATION_LOOKBACK_MS - 60 * 60_000)))
    expect((await page(w, NOW + 60_000, { account: LOGIN, cursor: first.cursor })).events).toEqual([])
  })

  it("keeps the cursor within the contract's length while it remembers the notifications it listed", async () => {
    // Many notifications in the lookback, and long ids in every search stream's position.
    const inbox = Array.from({ length: 60 }, (_, k) => note(`${9_000_000_000 + k}`, iso(NOW - 2 * 60 * 60_000 + k * 60_000)))
    const long = "o".repeat(39)
    const w = world({ inbox, commits: [{ ...commit("f".repeat(40), iso(NOW - 3 * 60 * 60_000)), repository: { full_name: `${long}/${"r".repeat(100)}` } }] })
    const pages = await read(w, NOW, { since: "2026-11-08T00:00:00Z", limit: 7 })
    expect(ids(pages)).toHaveLength(61)
    expect(new Set(ids(pages)).size).toBe(61)
    const again = await read(w, NOW + 60_000, { account: LOGIN, cursor: pages.at(-1)!.cursor, limit: 7 })
    expect(ids(again)).toEqual([])
  })
})
