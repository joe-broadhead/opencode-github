// The cursor: at most CURSOR_MAX characters (960), under the source contract's 1,024, with names never spelled out
// (a search position holds a hash of its item's id), times in base 36 and one-letter keys; and a cursor 0.0.6 or 0.0.7
// issued is read and continued with nothing lost and nothing listed twice. LEGACY holds real cursors of 0.0.7 (whose
// format 0.0.6 shares), issued by its events_list (b9ed5cf) over WORLD below, read from 2026-07-01 at limit 120: the
// first answered the read's gap, and two stop inside a second of 300 commits. Every login, repository and link is made
// up.
import { describe, expect, it } from "vitest"
import type { ApiOutput } from "../../src/api/contract.js"
import { EVENT_LIMITS, resultProblems, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { CURSOR_MAX, LOOKBACK_REMEMBERED, ORDER_KEY_LENGTH, encodeState, listEvents, orderKey, ownerOf } from "../../src/source-events.js"

const LOGIN = "octo-person"
const NOW = Date.parse("2026-11-08T12:00:00Z")
const ok = (data: unknown): ApiOutput => ({ ok: true, status: 200, data, truncated: false, trust: { githubContent: "untrusted" } })
const commit = (sha: string, date: string, repo = "octo/app") => ({ sha, html_url: `https://github.com/${repo}/commit/${sha}`, repository: { full_name: repo }, author: { login: LOGIN }, commit: { message: `c ${sha}`, author: { name: "O", email: "o@example.test", date }, committer: { date } } })
const issue = (n: number, updated: string, repo = "octo/app") => ({ number: n, title: `Item ${n}`, body: "", state: "open", updated_at: updated, repository_url: `https://api.github.com/repos/${repo}`, html_url: `https://github.com/${repo}/issues/${n}`, user: { login: "x" }, assignees: [], labels: [] })
const note = (id: string, updated: string) => ({ id, reason: "subscribed", updated_at: updated, subject: { title: id, type: "Release" }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } })

const T = "2026-11-02T00:00:00Z"
/** The world 0.0.7 read: 300 commits in one second, issues sharing it, and notifications. */
const WORLD = {
  commits: [commit("c0", "2026-07-02T00:00:00Z"), ...Array.from({ length: 300 }, (_, k) => commit(`r${String(299 - k).padStart(5, "0")}`, T)), commit("z1", "2026-11-03T00:00:00Z")],
  issues: [issue(1, "2026-11-01T10:00:00Z"), issue(3, T), issue(2, T), issue(4, "2026-11-06T00:00:00Z")],
  inbox: [note("9001", "2026-11-04T00:00:00Z"), note("9002", "2026-11-05T00:00:00Z"), note("9003", "2026-11-07T00:00:00Z"), note("9004", "2026-11-08T10:00:00Z")],
}

/** GitHub over a world: `>=` and `a..b` qualifiers, both ends inclusive, oldest first; notifications newest first. */
function github(world: { commits: ReturnType<typeof commit>[]; issues: ReturnType<typeof issue>[]; inbox: ReturnType<typeof note>[] }) {
  return async (path: string, query: Record<string, string | number | boolean>) => {
    const per = Number(query.per_page)
    const page = Number(query.page ?? 1)
    const q = String(query.q ?? "")
    const within = (at: string, name: string) => {
      const match = new RegExp(`${name}:(?:>=(\\S+)|(\\S+)\\.\\.(\\S+))`).exec(q)!
      const t = Date.parse(at)
      return match[1] !== undefined ? t >= Date.parse(match[1]) : t >= Date.parse(match[2]!) && t <= Date.parse(match[3]!)
    }
    const answer = <X>(all: X[]) => ok({ total_count: all.length, incomplete_results: false, items: all.slice((page - 1) * per, page * per) })
    if (path === "/search/issues") return answer(q.includes("is:pull-request") ? [] : world.issues.filter((i) => within(i.updated_at, "updated")).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || b.number - a.number))
    if (path === "/search/commits") return answer(world.commits.filter((c) => within(c.commit.committer.date, "committer-date")).sort((a, b) => Date.parse(a.commit.committer.date) - Date.parse(b.commit.committer.date)))
    if (path === "/notifications") {
      const since = Date.parse(String(query.since))
      const before = query.before === undefined ? Number.POSITIVE_INFINITY : Date.parse(String(query.before))
      return ok(world.inbox.filter((n) => Date.parse(n.updated_at) >= since && Date.parse(n.updated_at) < before).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice((page - 1) * per, page * per))
    }
    throw new Error(path)
  }
}

/** Every event of WORLD, in 0.0.7's order: by time, then stream (commits, issues, notifications), then id. */
const OLD_ORDER = [
  ...WORLD.commits.map((c) => ({ t: Date.parse(c.commit.committer.date), s: "c", id: `octo/app@${c.sha}`, event: `octo/app@${c.sha}` })),
  ...WORLD.issues.map((i) => ({ t: Date.parse(i.updated_at), s: "i", id: `octo/app#${i.number}`, event: `octo/app#${i.number}@${new Date(Date.parse(i.updated_at)).toISOString()}` })),
  ...WORLD.inbox.map((n) => ({ t: Date.parse(n.updated_at), s: "n", id: n.id, event: `notification:${n.id}@${new Date(Date.parse(n.updated_at)).toISOString()}` })),
]
  .sort((a, b) => a.t - b.t || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .map((entry) => entry.event)

/** Real cursors of 0.0.7, and how many events it had listed when it issued each. */
const LEGACY = [
  { listed: 2, cursor: "eyJ2IjoyLCJzIjoiZ2l0aHViIiwiYiI6ImIwNTJhODEyNTQ2MDI5MzAiLCJhIjoib2N0by1wZXJzb24iLCJvIjoiNGViNTMwZDNiNGE4YWJhYiIsInAiOnsiaSI6WzE3OTM1MjcyMDAwMDAsIm9jdG8vYXBwIzEiXSwicCI6WzE3ODI4NjQwMDAwMDAsIiJdLCJjIjpbMTc4Mjk1MDQwMDAwMCwib2N0by9hcHBAYzAiXSwibiI6WzE3ODY0NDk2MDAwMDAsIiJdfSwibCI6eyJmIjotMTAwMCwiaCI6W119LCJnIjoxNzk0MTM5MjAwMDAwLCJ1IjoxNzk0MTM4OTAwMDAwfQ" },
  { listed: 122, cursor: "eyJ2IjoyLCJzIjoiZ2l0aHViIiwiYiI6ImIwNTJhODEyNTQ2MDI5MzAiLCJhIjoib2N0by1wZXJzb24iLCJvIjoiNGViNTMwZDNiNGE4YWJhYiIsInAiOnsiaSI6WzE3OTM1MjcyMDAwMDAsIm9jdG8vYXBwIzEiXSwicCI6WzE3ODI4NjQwMDAwMDAsIiJdLCJjIjpbMTc5MzU3NzYwMDAwMCwib2N0by9hcHBAcjAwMTE5Il0sIm4iOlsxNzg2NDQ5NjAwMDAwLCIiXX0sImwiOnsiZiI6LTEwMDAsImgiOltdfSwiZyI6MTc5NDEzOTIwMDAwMCwidSI6MTc5NDEzODkwMDAwMH0" },
  { listed: 242, cursor: "eyJ2IjoyLCJzIjoiZ2l0aHViIiwiYiI6ImIwNTJhODEyNTQ2MDI5MzAiLCJhIjoib2N0by1wZXJzb24iLCJvIjoiNGViNTMwZDNiNGE4YWJhYiIsInAiOnsiaSI6WzE3OTM1MjcyMDAwMDAsIm9jdG8vYXBwIzEiXSwicCI6WzE3ODI4NjQwMDAwMDAsIiJdLCJjIjpbMTc5MzU3NzYwMDAwMCwib2N0by9hcHBAcjAwMjM5Il0sIm4iOlsxNzg2NDQ5NjAwMDAwLCIiXX0sImwiOnsiZiI6LTEwMDAsImgiOltdfSwiZyI6MTc5NDEzOTIwMDAwMCwidSI6MTc5NDEzODkwMDAwMH0" },
  { listed: 310, cursor: "eyJ2IjoyLCJzIjoiZ2l0aHViIiwiYiI6ImIwNTJhODEyNTQ2MDI5MzAiLCJhIjoib2N0by1wZXJzb24iLCJvIjoiNGViNTMwZDNiNGE4YWJhYiIsInAiOnsiaSI6WzE3OTM5MjMyMDAwMDAsIm9jdG8vYXBwIzQiXSwicCI6WzE3ODI4NjQwMDAwMDAsIiJdLCJjIjpbMTc5MzY2NDAwMDAwMCwib2N0by9hcHBAejEiXSwibiI6WzE3OTQxMzg5MDAwMDAsIiJdfSwibCI6eyJmIjoyMTYwMDAwMCwiaCI6WyI4Njc1NWM2ZTQzdzJvIl19fQ" },
]

const decoded = (cursor: string) => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>

/** Every page from `input` until the read ends, each within the contract; the events listed, and the cursors. */
async function read(get: ReturnType<typeof github>, now: number, input: Record<string, unknown>) {
  const pages: EventsListResult[] = []
  let next = input
  for (let k = 0; k < 50; k++) {
    const result = (await listEvents(get, async () => LOGIN, next, now)) as EventsListResult
    expect(resultProblems(result)).toEqual([])
    expect(result.cursor.length).toBeLessThanOrEqual(EVENT_LIMITS.cursor)
    pages.push(result)
    if (!result.more) break
    next = { account: LOGIN, cursor: result.cursor, limit: input["limit"] }
  }
  return { pages, events: pages.flatMap((page) => page.events.map((event) => event.external_id)), gaps: pages.flatMap((page) => (page.gap ? [page.gap] : [])) }
}

describe("a cursor of 0.0.6 or 0.0.7", () => {
  it("is the format these cursors have: no format key, positions by stream, times in milliseconds", () => {
    for (const { cursor } of LEGACY) {
      const state = decoded(cursor)
      expect(state["k"]).toBeUndefined()
      expect(Object.keys(state["p"] as object)).toEqual(["i", "p", "c", "n"])
    }
    // Two stop inside the second of 300 commits, where 0.0.7 walked by id.
    expect((decoded(LEGACY[1]!.cursor)["p"] as Record<string, unknown>)["c"]).toEqual([Date.parse(T), "octo/app@r00119"])
    expect((decoded(LEGACY[2]!.cursor)["p"] as Record<string, unknown>)["c"]).toEqual([Date.parse(T), "octo/app@r00239"])
  })

  for (const limit of [120, 40]) {
    it(`is continued with nothing lost and nothing listed twice, from each place 0.0.7 left it, at limit ${limit}`, async () => {
      expect(OLD_ORDER).toHaveLength(310)
      for (const { listed, cursor } of LEGACY.slice(0, 3)) {
        const { events, gaps, pages } = await read(github(WORLD), NOW, { account: LOGIN, cursor, limit })
        expect(new Set(events).size).toBe(events.length)
        expect([...events].sort()).toEqual(OLD_ORDER.slice(listed).sort())
        // The read answered its gap on 0.0.7's first page: none again.
        expect(gaps).toEqual([])
        // Every cursor it issues is the new format.
        for (const page of pages) expect(decoded(page.cursor)["k"]).toBe(1)
      }
    })
  }

  it("keeps 0.0.7's order inside the second it stopped in, and carries its place there in the new format until the second ends", async () => {
    const first = (await listEvents(github(WORLD), async () => LOGIN, { account: LOGIN, cursor: LEGACY[1]!.cursor, limit: 40 }, NOW)) as EventsListResult
    // The 40 commits after r00119 by id, as 0.0.7 would have listed them.
    expect(first.events.map((event) => event.external_id)).toEqual(Array.from({ length: 40 }, (_, k) => `octo/app@r${String(120 + k).padStart(5, "0")}`))
    expect((decoded(first.cursor)["p"] as unknown[])[2]).toEqual([(Date.parse(T) / 1000).toString(36), "octo/app@r00159", 1])
    // Once its stream leaves that second, no position spells out a name.
    const { pages } = await read(github(WORLD), NOW, { account: LOGIN, cursor: first.cursor, limit: 500 })
    expect(JSON.stringify(decoded(pages.at(-1)!.cursor))).not.toContain("octo/app")
  })

  it("carries the read's end: a later read lists what came after, a notification delivered late once, and none it listed again", async () => {
    const { listed, cursor } = LEGACY[3]!
    expect(listed).toBe(310)
    const later = {
      ...WORLD,
      issues: [...WORLD.issues, issue(5, "2026-11-08T12:10:00Z")],
      // 9005 is stamped before 0.0.7's position and delivered after it; 9004 was listed by 0.0.7, which remembered it.
      inbox: [...WORLD.inbox, note("9005", "2026-11-08T11:00:00Z")],
    }
    const { events, gaps } = await read(github(later), NOW + 60 * 60_000, { account: LOGIN, cursor, limit: 100 })
    expect(events).toEqual(["notification:9005@2026-11-08T11:00:00.000Z", "octo/app#5@2026-11-08T12:10:00.000Z"])
    expect(gaps).toEqual([])
  })
})

describe("the cursor's size", () => {
  const owner = ownerOf("a".repeat(39))
  const account = "a".repeat(39)
  /** Every field at its longest: times inside a second, a 20-digit notification, the lookback full and far back. */
  const worst = (keys: [string, string, string]) =>
    encodeState(
      account,
      owner,
      { i: { t: 9_999_999_999_999, i: keys[0] }, p: { t: 9_999_999_999_998, i: keys[1] }, c: { t: 9_999_999_999_997, i: keys[2] }, n: { t: 9_999_999_999_996, i: "9".repeat(20) } },
      9_999_999_999_996 - 6 * 60 * 60_000,
      new Map(Array.from({ length: LOOKBACK_REMEMBERED }, (_, k) => [`${k}`.padStart(8, "f"), 9_999_999_999_996 - 6 * 60 * 60_000 + k])),
      { gapAt: 9_999_999_999_995, cut: 9_999_999_999_994, lostAt: 9_999_999_999_993 },
    )

  it(`is at most ${CURSOR_MAX} characters with names of the longest GitHub allows in all three search positions, a cut, a gap and a loss`, () => {
    // A 39-character owner, a 100-character repository, the largest issue number and a commit's 40-character sha.
    const name = `${"o".repeat(39)}/${"r".repeat(100)}`
    const keys: [string, string, string] = [orderKey(`${name}#2147483647`), orderKey(`${name}#2147483646`), orderKey(`${name}@${"f".repeat(40)}`)]
    expect(keys.every((key) => key.length === ORDER_KEY_LENGTH)).toBe(true)
    const cursor = worst(keys)
    expect(CURSOR_MAX).toBe(960)
    // 763 characters, with all 16 notifications remembered.
    expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX)
    const state = decoded(cursor)
    expect(state).toMatchObject({ k: 1, a: account })
    expect(Object.keys(state).sort()).toEqual(["a", "b", "g", "k", "l", "o", "p", "q", "s", "u", "v"])
    // The whole lookback fits: nothing had to be forgotten.
    expect((state["l"] as [string, string[]])[1]).toHaveLength(LOOKBACK_REMEMBERED)
  })

  it("spells out no name: a read of the longest names leaves only order keys in its cursor", async () => {
    const repo = `${"o".repeat(39)}/${"r".repeat(100)}`
    const world = {
      commits: Array.from({ length: 3 }, (_, k) => commit("f".repeat(39) + k, `2026-11-0${k + 1}T00:00:00Z`, repo)),
      issues: Array.from({ length: 3 }, (_, k) => issue(2147483640 + k, `2026-11-0${k + 1}T00:00:00Z`, repo)),
      inbox: [],
    }
    const result = (await listEvents(github(world), async () => LOGIN, { since: "2026-10-31", limit: 4 }, NOW)) as EventsListResult
    expect(result.more).toBe(true)
    expect(Buffer.from(result.cursor, "base64url").toString("utf8")).not.toContain("rrrr")
    expect(result.cursor.length).toBeLessThanOrEqual(CURSOR_MAX)
  })
})
