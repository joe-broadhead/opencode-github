// The review of #33 (github-33-events): a search paged by page number skipped a result when one on an earlier page
// changed between requests (probe "SHIFT", L1); an answer over 32 MB stopped every stream for good (probe "CAP", L2);
// and a request had no deadline of its own (L3). A search now pages by time up to the read's cut, a page over the limit
// is read again in smaller pages, a result alone over it is left out with one gap, and each request has a deadline.
// The synthetic GitHub filters by `>=` and `a..b` qualifiers inclusively, sorts by time with ties in its own order,
// answers at most 1,000 results for one query with the real total_count, cuts an answer over the caller's read limit
// to a string (counting a result's `weight` as that many more bytes, so a test need not build 32 MB), and runs a hook
// before it answers each request, where a test changes GitHub between requests. Every login, repository and link is
// made up.
import { describe, expect, it } from "vitest"
import type { ApiOutput } from "../../src/api/contract.js"
import { GitHubPluginError } from "../../src/errors.js"
import { EVENT_LIMITS, resultProblems, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { EVENTS_MAX_BYTES, PAGE_BYTES, READ_DEADLINE_MS, SEARCH_BUDGET, SEARCH_CAP, SEARCH_SMALL_PAGE, listEvents, runEvents, runProbe } from "../../src/source-events.js"

const LOGIN = "octo-person"
const NOW = Date.parse("2026-11-08T12:00:00Z")
const HOUR = 60 * 60_000
const iso = (at: number) => new Date(at).toISOString().replace(".000Z", "Z")
const ok = (data: unknown): ApiOutput => ({ ok: true, status: 200, data, truncated: false, trust: { githubContent: "untrusted" } })

type Issue = { number: number; title: string; body: string; state: string; updated_at: string; repository_url: string; html_url: string; user: { login: string }; assignees: unknown[]; labels: unknown[]; weight?: number }
const issue = (number: number, updated: string, extra: Partial<Issue> = {}): Issue => ({
  number,
  title: `Item ${number}`,
  body: `Body ${number}`,
  state: "open",
  updated_at: updated,
  repository_url: "https://api.github.com/repos/octo/app",
  html_url: `https://github.com/octo/app/issues/${number}`,
  user: { login: "someone-else" },
  assignees: [{ login: LOGIN }],
  labels: [],
  ...extra,
})
/** The event an issue's current state lists. */
const eventOf = (item: Issue) => `octo/app#${item.number}@${new Date(Date.parse(item.updated_at)).toISOString()}`

/**
 * `before(n, query)` runs before the n-th search request (from 1) is answered. `after(n, query)` runs once it is
 * answered, with the answer holding the results themselves, so a change it makes shows on that page out of its order,
 * as the reviewer's probe has it. `shuffle` reorders ties on every request.
 */
function world(issues: Issue[], options: { before?: (n: number, query: Record<string, unknown>) => void; after?: (n: number, query: Record<string, unknown>) => void; shuffle?: boolean } = {}) {
  const calls: { path: string; query: Record<string, unknown>; over?: boolean }[] = []
  let searches = 0
  let seed = 11
  const tie = () => (options.shuffle ? ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5 : 0)
  const get = async (path: string, query: Record<string, string | number | boolean>, maxBytes?: number): Promise<ApiOutput> => {
    calls.push({ path, query })
    if (path === "/notifications") return ok([])
    if (path === "/search/commits") return ok({ total_count: 0, incomplete_results: false, items: [] })
    if (path !== "/search/issues") throw new Error(path)
    options.before?.(++searches, query)
    const q = String(query.q)
    const match = /updated:(?:>=(\S+)|(\S+)\.\.(\S+))/.exec(q)!
    const from = Date.parse(match[1] ?? match[2]!)
    const to = match[1] !== undefined ? Number.POSITIVE_INFINITY : Date.parse(match[3]!)
    const pulls = q.includes("is:pull-request")
    const all = issues
      .filter((item) => !pulls && Date.parse(item.updated_at) >= from && Date.parse(item.updated_at) <= to)
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || tie() || b.number - a.number)
    const per = Number(query.per_page)
    const page = Number(query.page)
    if (page * per > SEARCH_CAP && (page - 1) * per >= SEARCH_CAP) return { ok: false, status: 422, data: { message: "Only the first 1000 search results are available" }, truncated: false, trust: { githubContent: "untrusted" } }
    const items = all.slice(0, SEARCH_CAP).slice((page - 1) * per, page * per)
    const data = { total_count: all.length, incomplete_results: false, items: options.after ? items : items.map(({ weight: _, ...rest }) => rest) }
    const text = JSON.stringify(data)
    const bytes = Buffer.byteLength(text) + items.reduce((sum, item) => sum + (item.weight ?? 0), 0)
    if (bytes > (maxBytes ?? 100_000)) {
      calls[calls.length - 1]!.over = true
      return { ...ok(text.slice(0, 64)), truncated: true }
    }
    options.after?.(searches, query)
    return ok(data)
  }
  return { get, calls, identity: async () => LOGIN }
}
type World = ReturnType<typeof world>

/** Every page of one read, checked against the contract and the search budget, until it ends; it never stalls. */
async function read(w: World, now: number, input: Record<string, unknown>, most = 200) {
  const pages: EventsListResult[] = []
  let next = input
  for (let k = 0; k < most; k++) {
    const before = w.calls.filter((call) => call.path.startsWith("/search/")).length
    const result = (await listEvents(w.get, w.identity, next, now)) as EventsListResult
    expect(w.calls.filter((call) => call.path.startsWith("/search/")).length - before).toBeLessThanOrEqual(SEARCH_BUDGET)
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

/** A first read from `since`, then three later reads an hour apart from its cursor, as a collector reads. */
async function collect(w: World, since: string, limit: number) {
  const first = await read(w, NOW, { since, limit })
  const pages = [...first]
  let cursor = first.at(-1)!.cursor
  for (let k = 1; k <= 3; k++) {
    const later = await read(w, NOW + k * HOUR, { account: LOGIN, cursor, limit })
    pages.push(...later)
    cursor = later.at(-1)!.cursor
  }
  return pages
}

/** No current state missing, nothing listed twice, and no gap. */
function lossless(pages: EventsListResult[], issues: Issue[]) {
  const listed = ids(pages)
  return { missing: issues.map(eventOf).filter((id) => !listed.includes(id)), duplicates: listed.length - new Set(listed).size, gaps: gaps(pages).length }
}

const T0 = Date.parse("2026-10-01T00:00:00Z")
/** n issues a minute apart from T0, numbered from 1. */
const spread = (n: number, extra: (k: number) => Partial<Issue> = () => ({})) => Array.from({ length: n }, (_, k) => issue(k + 1, iso(T0 + k * 60_000), extra(k + 1)))

describe("a search result that changes while a search pages (review L1)", () => {
  it('SHIFT: a result read on page 1 that changes before page 2 is read skips nothing: #101 is listed (the reviewer\'s probe)', async () => {
    const issues = spread(250)
    let moved = false
    const w = world(issues, {
      before: (_, query) => {
        if (!moved && /is:issue/.test(String(query.q)) && w.calls.filter((call) => call.path === "/search/issues").length === 2) {
          moved = true
          issues[4]!.updated_at = "2026-11-08T11:00:00Z" // #5 changes between page 1 and page 2
        }
      },
    })
    const pages = await collect(w, "2026-10-01", 500)
    expect(moved).toBe(true)
    expect(ids(pages)).toContain("octo/app#101@2026-10-01T01:40:00.000Z")
    expect(lossless(pages, issues)).toEqual({ missing: [], duplicates: 0, gaps: 0 })
  })

  it("SHIFT, as the reviewer's probe has it: a change that shows on the page already answered, out of its order, skips nothing", async () => {
    const issues = spread(250)
    const w = world(issues, {
      after: (n) => {
        if (n === 1) issues[4]!.updated_at = "2026-11-08T11:00:00Z"
      },
    })
    const pages = await collect(w, "2026-10-01", 500)
    expect(lossless(pages, issues)).toEqual({ missing: [], duplicates: 0, gaps: 0 })
    // The page ends at #100 in GitHub's order, not at the changed result's later time.
    expect(String(w.calls.filter((call) => call.path === "/search/issues")[1]!.query.q)).toContain("updated:2026-10-01T01:39:00Z..")
  })

  // Which result changes, and before which request: the first, one inside page 1, the last read on page 1, the first
  // and one inside page 2, and the very last; to now (the next read's), or to a time inside the read's cut, as the
  // reviewer's probe has it, while the issue search still pages (requests 1 to 3; once it has read past a time, a change
  // stamped there would be GitHub's index lagging more than SETTLE_MS, which events_list waits for).
  const which = [1, 50, 100, 101, 150, 249, 250]
  for (const to of ["inside the cut", "now"] as const) {
    for (const at of to === "now" ? [2, 3, 4] : [2, 3]) {
      it(`loses nothing when any one result changes to ${to} before search request ${at}, at limit 500 and at limit 60`, async () => {
        for (const limit of [500, 60]) {
          for (const number of which) {
            // One more result after the changed one's new time, so a read that missed the change would move past it.
            const issues = [...spread(250), issue(900, "2026-11-08T11:30:00Z")]
            let done = false
            const w = world(issues, {
              before: (n) => {
                if (!done && n === at) {
                  done = true
                  issues[number - 1]!.updated_at = to === "now" ? iso(NOW) : "2026-11-08T11:00:00Z"
                }
              },
            })
            const pages = await collect(w, "2026-10-01", limit)
            expect({ number, limit, ...lossless(pages, issues) }).toEqual({ number, limit, missing: [], duplicates: 0, gaps: 0 })
          }
        }
      })
    }
  }

  it("loses nothing when two results change during one read, one already read and one not yet", async () => {
    for (const [first, second] of [[5, 160], [100, 101], [99, 100], [1, 250]] as const) {
      const issues = [...spread(250), issue(900, "2026-11-08T11:30:00Z")]
      const w = world(issues, {
        before: (n) => {
          if (n === 2) issues[first - 1]!.updated_at = "2026-11-08T11:00:00Z"
          if (n === 3) issues[second - 1]!.updated_at = iso(NOW - 2 * 60_000)
        },
      })
      const pages = await collect(w, "2026-10-01", 500)
      expect({ first, second, ...lossless(pages, issues) }).toEqual({ first, second, missing: [], duplicates: 0, gaps: 0 })
    }
  })

  it("loses nothing when the last result a page read changes before the next page, in a second that crosses the page", async () => {
    // Three results share each minute, so every page ends inside a second; the last one read on page 1 changes.
    const issues = Array.from({ length: 300 }, (_, k) => issue(k + 1, iso(T0 + Math.floor(k / 3) * 60_000)))
    let last: number | undefined
    const w = world(issues, {
      before: (n) => {
        if (n === 2 && last === undefined) {
          // The fake orders ties by number, descending: the 100th result is minute 33's largest number, #102.
          last = 102
          issues.find((item) => item.number === last)!.updated_at = "2026-11-08T11:00:00Z"
        }
      },
    })
    const pages = await collect(w, "2026-10-01", 500)
    expect(lossless(pages, issues)).toEqual({ missing: [], duplicates: 0, gaps: 0 })
  })

  it("loses nothing when a result leaves a crowded second while that second is read whole, page by page", async () => {
    // 450 results in one second: read whole by itself, in pages of 100; one leaves it between two of those pages.
    const S = iso(Date.parse("2026-10-05T08:00:00Z"))
    const issues = [issue(1, "2026-10-01T00:00:00Z"), ...Array.from({ length: 450 }, (_, k) => issue(1000 + k, S)), issue(2, "2026-10-06T00:00:00Z")]
    // Before each of the second's page requests in turn, whichever read of it that request belongs to.
    for (const leaving of [1000, 1449, 1225]) {
      for (let request = 2; request <= 12; request++) {
        const copy = issues.map((item) => ({ ...item }))
        let pagesOfSecond = 0
        const w = world(copy, {
          before: (_, query) => {
            if (String(query.q).includes(`${S}..${S}`) && ++pagesOfSecond === request) copy.find((item) => item.number === leaving)!.updated_at = "2026-11-08T11:00:00Z"
          },
        })
        const pages = await collect(w, "2026-10-01", 500)
        expect(pagesOfSecond).toBeGreaterThanOrEqual(request)
        expect({ leaving, request, ...lossless(pages, copy) }).toEqual({ leaving, request, missing: [], duplicates: 0, gaps: 0 })
      }
    }
  })

  it("lists each result once where GitHub orders a second's results differently on every request", async () => {
    const issues = Array.from({ length: 400 }, (_, k) => issue(k + 1, iso(T0 + Math.floor(k / 7) * 1000)))
    const pages = await collect(world(issues, { shuffle: true }), "2026-10-01", 500)
    expect(lossless(pages, issues)).toEqual({ missing: [], duplicates: 0, gaps: 0 })
  })
})

describe("an answer over the 32 MB events_list reads whole (review L2)", () => {
  it("CAP: a page of 100 results over 32 MB is read in pages of 10, listing all 120 results once, with no gap (the reviewer's probe)", async () => {
    // 100 issues of about 340 KB each (65,536 four-byte characters and some more) is about 34 MB a page.
    const big = "\u{1F600}".repeat(65_536) + "x".repeat(80_000)
    const issues = spread(120, () => ({ body: big }))
    const w = world(issues)
    const pages = await read(w, NOW, { since: "2026-10-01", limit: 100 })
    expect(lossless(pages, issues)).toEqual({ missing: [], duplicates: 0, gaps: 0 })
    expect(w.calls.some((call) => call.over)).toBe(true)
    expect(w.calls.filter((call) => call.path === "/search/issues").some((call) => call.query.per_page === SEARCH_SMALL_PAGE)).toBe(true)
  })

  /** One result `weight` bytes over the limit: every other result listed once, it never, with one gap from its second. */
  async function oversized(issues: Issue[], heavy: number[], limit = 100) {
    for (const number of heavy) issues.find((item) => item.number === number)!.weight = EVENTS_MAX_BYTES + 1
    const pages = await collect(world(issues), "2026-10-01", limit)
    const rest = issues.filter((item) => !heavy.includes(item.number))
    const listed = ids(pages)
    expect(lossless(pages, rest)).toMatchObject({ missing: [], duplicates: 0 })
    for (const number of heavy) expect(listed.some((id) => id.startsWith(`octo/app#${number}@`))).toBe(false)
    return gaps(pages)
  }

  it("leaves out a result alone over 32 MB, answers one window-truncated gap from after the result before it, and lists every other result", async () => {
    const issues = spread(250)
    const found = await oversized(issues, [120])
    expect(found).toHaveLength(1)
    expect(found[0]!.reason).toBe("window-truncated")
    // From after #119 up to #120: the gap covers #120 and nothing listed.
    expect(Date.parse(found[0]!.since)).toBeGreaterThan(T0 + 118 * 60_000)
    expect(Date.parse(found[0]!.since)).toBeLessThanOrEqual(T0 + 119 * 60_000)
  })

  it("does so for the first result a read finds, where nothing before it can be read with it", async () => {
    const issues = spread(40)
    expect(await oversized(issues, [1])).toEqual([{ reason: "window-truncated", since: new Date(T0).toISOString() }])
  })

  it("does so where it shares its second with others, and lists those", async () => {
    const S = iso(T0 + 30 * 60_000)
    const issues = [...spread(60), ...Array.from({ length: 6 }, (_, k) => issue(500 + k, S))]
    expect(await oversized(issues, [503])).toEqual([{ reason: "window-truncated", since: new Date(Date.parse(S)).toISOString() }])
  })

  it("does so inside a crowded second of 150, read in pages of 100, 10 and 1, at a limit that walks the second across calls", async () => {
    const S = iso(T0 + 30 * 60_000)
    const issues = [...spread(60), ...Array.from({ length: 150 }, (_, k) => issue(500 + k, S))]
    expect(await oversized(issues, [577], 40)).toEqual([{ reason: "window-truncated", since: new Date(Date.parse(S)).toISOString() }])
  })

  it("does so for two such results in a row, with one gap for the read", async () => {
    const issues = spread(80)
    const found = await oversized(issues, [30, 31])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ reason: "window-truncated" })
  })

  it("lists a result over 32 MB whose change lies after the read's cut on a later read, never as a loss now", async () => {
    // The heavy result is the last, changed just now: the read's cut is before it, so it is never read by this read.
    const issues = [...spread(30), issue(99, iso(NOW - 60_000), { weight: EVENTS_MAX_BYTES + 1 })]
    const pages = await read(world(issues), NOW, { since: "2026-10-01", limit: 100 })
    expect(gaps(pages)).toEqual([])
    expect(lossless(pages, issues.slice(0, 30))).toEqual({ missing: [], duplicates: 0, gaps: 0 })
  })
})

describe("a deadline for each request (review L3)", () => {
  const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }
  /** github_api's spec that never answers, but stops when its signal does, as a fetch does. */
  const stalled = () => {
    const seen: AbortSignal[] = []
    const run = (_input: unknown, given: { signal?: AbortSignal }) =>
      new Promise<ApiOutput>((_, reject) => {
        seen.push(given.signal!)
        given.signal!.addEventListener("abort", () => reject(given.signal!.reason))
      })
    return { seen, deps: (deadlineMs: number) => ({ ctx: { permission: { assert: async () => {} } }, api: { run }, identity: async () => LOGIN, now: () => NOW, deadlineMs }) as never }
  }

  it("is 60 seconds by default", () => {
    expect(READ_DEADLINE_MS).toBe(60_000)
  })

  it("answers UNAVAILABLE, with a next step that calls again with the same cursor, when GitHub does not answer in time, and stops the request", async () => {
    const fake = stalled()
    const error = (await runEvents(fake.deps(20), { since: "2026-11-01" }, call).catch((caught: unknown) => caught)) as GitHubPluginError
    expect(error).toBeInstanceOf(GitHubPluginError)
    expect(error.code).toBe("UNAVAILABLE")
    expect(error.message).toContain("GET /search/issues")
    expect(error.nextStep).toContain("same cursor")
    expect(fake.seen[0]!.aborted).toBe(true)
    const probe = (await runProbe(fake.deps(20), {}, call).catch((caught: unknown) => caught)) as GitHubPluginError
    expect(probe.code).toBe("UNAVAILABLE")
    expect(probe.nextStep).toContain("probe again")
  })

  it("keeps the caller's abort: an aborted call stops at once, as the caller's own abort, not as a deadline", async () => {
    const fake = stalled()
    const controller = new AbortController()
    const reason = new Error("the caller stopped")
    const pending = runEvents(fake.deps(60_000), { since: "2026-11-01" }, { ...call, signal: controller.signal } as never).catch((caught: unknown) => caught)
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort(reason)
    expect(await pending).toBe(reason)
  })

  it("does not stop a request that answers in time", async () => {
    const issues = spread(3)
    const w = world(issues)
    const deps = { ctx: { permission: { assert: async () => {} } }, api: { run: async (input: { path: string; query?: Record<string, string | number | boolean> }) => w.get(input.path, input.query ?? {}, EVENTS_MAX_BYTES) }, identity: w.identity, now: () => NOW, deadlineMs: 1_000 }
    const result = await runEvents(deps as never, { since: "2026-10-01" }, call)
    expect(result.events.map((event) => event.external_id)).toEqual(issues.map(eventOf))
  })
})
