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
import { NOTIFICATION_LOOKBACK_MS, PAGE_BYTES, SEARCH_BUDGET, SEARCH_CAP, SETTLE_MS, listEvents, orderKey } from "../../src/source-events.js"

const LOGIN = "octo-person"
const NOW = Date.parse("2026-11-08T12:00:00Z")
const iso = (at: number) => new Date(at).toISOString()
const ok = (data: unknown): ApiOutput => ({ ok: true, status: 200, data, truncated: false, trust: { githubContent: "untrusted" } })
const issue = (n: number, updated: string) => ({ number: n, title: `Item ${n}`, body: "", state: "open", updated_at: updated, repository_url: "https://api.github.com/repos/octo/app", html_url: `https://github.com/octo/app/issues/${n}`, user: { login: "x" }, assignees: [], labels: [] })
const commit = (sha: string, date: string) => ({ sha, html_url: `https://github.com/octo/app/commit/${sha}`, repository: { full_name: "octo/app" }, author: { login: LOGIN }, commit: { message: `c ${sha}`, author: { name: "O", email: "o@example.test", date }, committer: { date } } })
const note = (id: string, updated: string, type = "Release") => ({ id, reason: "subscribed", updated_at: updated, subject: { title: id, type }, repository: { full_name: "octo/app", html_url: "https://github.com/octo/app" } })

/**
 * `shuffle`: ties reshuffled on every request. `deepest`: the furthest notification GitHub pages to (422 past it).
 * `retain`: GitHub deletes notifications older than this on its own clock (`clock.now`, the time of the page asked).
 */
function world(data: { issues?: ReturnType<typeof issue>[]; commits?: ReturnType<typeof commit>[]; inbox?: ReturnType<typeof note>[]; shuffle?: boolean; deepest?: number; retain?: number }) {
  const clock = { now: NOW }
  const calls: { path: string; query: Record<string, unknown> }[] = []
  let seed = 7
  const tie = () => (data.shuffle ? ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5 : 0)
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
      const pulls = q.includes("is:pull-request")
      const all = (data.issues ?? []).filter((i) => within(i.updated_at, "updated") && i.html_url.includes("/pull/") === pulls).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || tie() || b.number - a.number)
      return answer(all)
    }
    if (path === "/search/commits") {
      const all = (data.commits ?? []).filter((c) => within(c.commit.committer.date, "committer-date")).sort((a, b) => Date.parse(a.commit.committer.date) - Date.parse(b.commit.committer.date) || tie() || (a.sha < b.sha ? 1 : -1))
      return answer(all)
    }
    if (path === "/notifications") {
      if (page * per > (data.deepest ?? Number.POSITIVE_INFINITY)) return { ok: false, status: 422, data: { message: "Pagination is limited" }, truncated: false, trust: { githubContent: "untrusted" } } as ApiOutput
      const since = Date.parse(String(query.since))
      // before is exclusive; since inclusive.
      const before = query.before === undefined ? Number.POSITIVE_INFINITY : Date.parse(String(query.before))
      const kept = data.retain === undefined ? Number.NEGATIVE_INFINITY : clock.now - data.retain
      const all = (data.inbox ?? []).filter((n) => Date.parse(n.updated_at) >= Math.max(since, kept) && Date.parse(n.updated_at) < before).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      return ok(all.slice((page - 1) * per, page * per))
    }
    throw new Error(path)
  }
  return { get, calls, clock, identity: async () => LOGIN }
}
type World = ReturnType<typeof world>
const page = (w: World, now: number, input: Record<string, unknown>) => {
  w.clock.now = now
  return listEvents(w.get, w.identity, input, now) as Promise<EventsListResult>
}

/** Every page of one read, checking each against the contract and the search budget; page k is read at `clock(k)`, after `between(k)`. */
async function read(w: World, now: number | ((k: number) => number), input: Record<string, unknown>, most = 400, between: (k: number) => void = () => {}) {
  const pages: EventsListResult[] = []
  let next = input
  for (let k = 0; k < most; k++) {
    between(k)
    const before = w.calls.filter((call) => call.path.startsWith("/search/")).length
    const result = await page(w, typeof now === "number" ? now : now(k), next)
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

  it("read at a small limit, is walked oldest first, with no gap, listing every notification once", async () => {
    const inbox = releases(520)
    const pages = await read(world({ issues, inbox }), NOW, { since: "2026-10-31T00:00:00Z", limit: 5 })
    expect(gaps(pages)).toEqual([])
    expect(ids(pages).filter((id) => id.startsWith("notification:"))).toEqual(inbox.map((n) => `notification:${n.id}@${n.updated_at}`))
    expect(ids(pages).filter((id) => !id.startsWith("notification:"))).toHaveLength(30)
  })

  for (const backlog of [600, 2000]) {
    it(`of ${backlog}, with new notifications arriving between pages, loses none: the read walks its backlog under its cut, and the next read lists the arrivals`, async () => {
      const inbox = releases(backlog)
      const w = world({ issues, inbox })
      const clock = (k: number) => NOW + k * 60_000
      const arrived: ReturnType<typeof note>[] = []
      const arrive = (k: number) => {
        if (k === 0) return
        const fresh = note(`${90_000 + k}`, iso(clock(k) - 1000))
        arrived.push(fresh)
        inbox.push(fresh)
      }
      const pages = await read(w, clock, { since: "2026-10-31T00:00:00Z", limit: 40 }, 400, arrive)
      expect(gaps(pages)).toEqual([])
      expect(ids(pages).filter((id) => id.startsWith("notification:") && !id.startsWith("notification:9"))).toEqual(inbox.slice(0, backlog).map((n) => `notification:${n.id}@${n.updated_at}`))
      // None that arrived during the read is listed by it: its cut holds.
      expect(ids(pages).filter((id) => id.startsWith("notification:9"))).toEqual([])
      expect(arrived.length).toBeGreaterThan(5)
      const next = await read(w, clock(pages.length) + SETTLE_MS, { account: LOGIN, cursor: pages.at(-1)!.cursor, limit: 500 })
      expect(gaps(next)).toEqual([])
      expect(ids(next).filter((id) => id.startsWith("notification:9"))).toEqual(arrived.map((n) => `notification:${n.id}@${n.updated_at}`))
    })
  }

  it("answers one honest gap where GitHub will not page as far as the backlog, and lists the newest it can read", async () => {
    const inbox = releases(2000)
    const pages = await read(world({ issues, inbox, deepest: 1000 }), NOW, { since: "2026-10-31T00:00:00Z", limit: 100 })
    expect(gaps(pages)).toEqual([{ reason: "window-truncated", since: "2026-10-31T00:00:00.000Z" }])
    const listed = ids(pages).filter((id) => id.startsWith("notification:"))
    expect(listed).toEqual(inbox.slice(1501).map((n) => `notification:${n.id}@${n.updated_at}`))
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
        // A second's results in the plugin's order: by order key, a hash of the id.
        expect(listed).toEqual([
          "octo/app@c0",
          ...Array.from({ length: count }, (_, k) => `octo/app@r${String(k).padStart(5, "0")}`).sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1)),
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

describe("two crowded seconds at once (review round 2, L-A)", () => {
  const T = Date.parse("2026-11-02T00:00:00Z")
  const pr = (n: number, at: string) => ({ ...issue(n, at), html_url: `https://github.com/octo/app/pull/${n}`, pull_request: { merged_at: null } })
  for (const [inIssues, inCommits, apart] of [
    [1000, 1000, 0],
    [1000, 800, 0],
    [900, 900, 0],
    [1000, 1000, 3_600_000],
    [1000, 1000, -3_600_000],
  ] as const) {
    it(`lists ${inIssues} issue changes and ${inCommits} commits in crowded seconds ${apart / 3_600_000} h apart, with no stall and no gap`, async () => {
      const issues = [issue(1, iso(T - 86_400_000)), ...Array.from({ length: inIssues }, (_, k) => issue(1000 + k, iso(T))), issue(2, iso(T + 86_400_000))]
      const commits = [commit("c0", iso(T - 86_400_000)), ...Array.from({ length: inCommits }, (_, k) => commit(`r${String(k).padStart(5, "0")}`, iso(T + apart))), commit("z1", iso(T + 86_400_000))]
      const pages = await read(world({ issues, commits }), NOW, { since: "2026-10-31T00:00:00Z", limit: 100 })
      expect(gaps(pages)).toEqual([])
      expect(new Set(ids(pages)).size).toBe(inIssues + inCommits + 4)
    })
  }

  it("lists 700 pull requests and 700 commits in one second alongside, each once", async () => {
    const pulls = Array.from({ length: 700 }, (_, k) => pr(5000 + k, iso(T)))
    const commits = Array.from({ length: 700 }, (_, k) => commit(`s${String(k).padStart(5, "0")}`, iso(T)))
    const pages = await read(world({ issues: pulls, commits }), NOW, { since: "2026-10-31T00:00:00Z", limit: 100 })
    expect(new Set(ids(pages)).size).toBe(1400)
  })
})

describe("no silent loss after a read's gap (review round 3, Q1)", () => {
  const DAY = 86_400_000
  const HOUR = 3_600_000
  /** Every notification is listed, or a gap answered after `after` (a page index across the read and the next) has a since at or before it. */
  function accounted(inbox: ReturnType<typeof note>[], pages: EventsListResult[], after: number) {
    const listed = new Set(ids(pages))
    const later = pages.flatMap((p, k) => (p.gap && k > after ? [Date.parse(p.gap.since)] : []))
    return inbox.filter((n) => !listed.has(`notification:${n.id}@${n.updated_at}`) && !later.some((since) => since <= Date.parse(n.updated_at))).map((n) => n.id)
  }

  for (const [label, step] of [["5 minutes", 5 * 60_000], ["1 hour", HOUR]] as const) {
    it(`a read whose gap is a 5,000-result second, with notifications at the window's edge, paged ${label} apart`, async () => {
      const issues = Array.from({ length: 60 }, (_, k) => issue(k + 1, iso(NOW - 88.99 * DAY + 1000 + k * 1000)))
      const commits = Array.from({ length: 5000 }, (_, k) => commit(`r${String(k).padStart(5, "0")}`, iso(NOW - 60 * DAY)))
      const inbox = Array.from({ length: 30 }, (_, k) => note(`${100 + k}`, iso(NOW - 88.98 * DAY + k * 10 * 60_000)))
      const w = world({ issues, commits, inbox })
      const pages = await read(w, (k) => NOW + k * step, { since: iso(NOW - 88.99 * DAY), limit: 5 })
      const first = pages.findIndex((p) => p.gap !== undefined)
      const next = await read(w, NOW + pages.length * step + HOUR, { account: LOGIN, cursor: pages.at(-1)!.cursor, limit: 500 })
      expect(accounted(inbox, [...pages, ...next], first)).toEqual([])
    })

    it(`a read from since 120 days, with notifications at the window's edge, paged ${label} apart`, async () => {
      const issues = Array.from({ length: 40 }, (_, k) => issue(k + 1, iso(NOW - 120 * DAY + k * HOUR)))
      const inbox = Array.from({ length: 12 }, (_, k) => note(`${100 + k}`, iso(NOW - 89 * DAY + 30 * 60_000 + k * HOUR)))
      const w = world({ issues, inbox })
      const pages = await read(w, (k) => NOW + k * step, { since: iso(NOW - 120 * DAY), limit: 5 })
      expect(pages[0]!.gap).toMatchObject({ reason: "window-truncated" })
      const next = await read(w, NOW + pages.length * step + HOUR, { account: LOGIN, cursor: pages.at(-1)!.cursor, limit: 500 })
      expect(accounted(inbox, [...pages, ...next], 0)).toEqual([])
    })
  }

  it("carries a loss found after the read's gap, and answers it on the next read's first page, once", async () => {
    // The read's gap: a since before GitHub's window. Later in the read, a 5,000-result commit second it cannot list.
    const T = NOW - 30 * DAY
    const issues = Array.from({ length: 20 }, (_, k) => issue(k + 1, iso(NOW - 100 * DAY + k * DAY)))
    // Earlier commits first, so the commit stream reaches the crowded second only after the read's first page.
    const commits = [
      ...Array.from({ length: 20 }, (_, k) => commit(`a${String(k).padStart(5, "0")}`, iso(T - (20 - k) * HOUR))),
      ...Array.from({ length: 5000 }, (_, k) => commit(`r${String(k).padStart(5, "0")}`, iso(T))),
      commit("z1", iso(T + DAY)),
    ]
    const w = world({ issues, commits })
    const pages = await read(w, NOW, { since: iso(NOW - 120 * DAY), limit: 5 })
    expect(gaps(pages)).toEqual([{ reason: "window-truncated", since: iso(NOW - 120 * DAY) }])
    expect(ids(pages)).toContain("octo/app@z1")
    const last = pages.at(-1)!.cursor
    const first = await page(w, NOW + HOUR, { account: LOGIN, cursor: last })
    expect(first.gap).toEqual({ reason: "expired", since: iso(T) })
    // Read again at the same cursor: the same gap. Read on: none.
    expect((await page(w, NOW + HOUR, { account: LOGIN, cursor: last })).gap).toEqual(first.gap)
    expect((await page(w, NOW + 2 * HOUR, { account: LOGIN, cursor: first.cursor })).gap).toBeUndefined()
  })
})

describe("GitHub deleting notifications past 89 days on its own clock while a read pages (review round 4, Q5)", () => {
  const DAY = 86_400_000
  const HOUR = 3_600_000
  const shapes: [string, () => { issues: ReturnType<typeof issue>[]; commits: ReturnType<typeof commit>[]; inbox: ReturnType<typeof note>[]; since: number }][] = [
    [
      "a read whose gap is a 5,000-result second, from since 88.99 days",
      () => ({
        issues: Array.from({ length: 60 }, (_, k) => issue(k + 1, iso(NOW - 88.99 * DAY + 1000 + k * 1000))),
        commits: Array.from({ length: 5000 }, (_, k) => commit(`r${String(k).padStart(5, "0")}`, iso(NOW - 60 * DAY))),
        inbox: Array.from({ length: 30 }, (_, k) => note(`${100 + k}`, iso(NOW - 88.98 * DAY + k * 10 * 60_000))),
        since: NOW - 88.99 * DAY,
      }),
    ],
    [
      "a read from since 120 days, with notifications at the window's edge",
      () => ({
        issues: Array.from({ length: 40 }, (_, k) => issue(k + 1, iso(NOW - 120 * DAY + k * HOUR))),
        commits: [],
        inbox: Array.from({ length: 12 }, (_, k) => note(`${100 + k}`, iso(NOW - 89 * DAY + 30 * 60_000 + k * HOUR))),
        since: NOW - 120 * DAY,
      }),
    ],
    [
      "a read with no earlier gap, from since 88.99 days",
      () => ({
        issues: Array.from({ length: 60 }, (_, k) => issue(k + 1, iso(NOW - 88.99 * DAY + 1000 + k * 1000))),
        commits: [],
        inbox: Array.from({ length: 30 }, (_, k) => note(`${100 + k}`, iso(NOW - 88.98 * DAY + k * 10 * 60_000))),
        since: NOW - 88.99 * DAY,
      }),
    ],
  ]
  for (const [label, make] of shapes) {
    for (const [paging, step] of [["5 minutes", 5 * 60_000], ["1 hour", HOUR]] as const) {
      for (const retain of [undefined, 89 * DAY]) {
        it(`${label}, paged ${paging} apart, GitHub ${retain === undefined ? "deleting nothing" : "deleting at 89 days"}: every notification listed or covered by a gap`, async () => {
          const d = make()
          const w = world({ issues: d.issues, commits: d.commits, inbox: d.inbox, ...(retain === undefined ? {} : { retain }) })
          const pages = await read(w, (k) => NOW + k * step, { since: iso(d.since), limit: 5 })
          const end = NOW + pages.length * step
          const next = await read(w, (k) => end + HOUR + k * 1000, { account: LOGIN, cursor: pages.at(-1)!.cursor, limit: 5 })
          const answered = [...gaps(pages), ...gaps(next)].map((gap) => Date.parse(gap.since))
          const listed = new Set([...ids(pages), ...ids(next)])
          const silent = d.inbox.filter((n) => !listed.has(`notification:${n.id}@${n.updated_at}`) && !answered.some((since) => since <= Date.parse(n.updated_at)))
          expect(silent.map((n) => n.id)).toEqual([])
          // One gap per read, and the same cursor read again answers the same gap.
          expect(gaps(pages).length).toBeLessThanOrEqual(1)
          expect(gaps(next).length).toBeLessThanOrEqual(1)
          expect((await page(w, end + HOUR, { account: LOGIN, cursor: pages.at(-1)!.cursor, limit: 5 })).gap).toEqual(next[0]!.gap)
        })
      }
    }
  }
})

describe("ties GitHub orders differently from one request to the next (review round 2, L-C)", () => {
  it("never lists an event twice on a page, and the read ends", async () => {
    const T = "2026-11-02T00:00:00Z"
    const commits = Array.from({ length: 900 }, (_, k) => commit(`r${String(k).padStart(5, "0")}`, T))
    const pages = await read(world({ commits, shuffle: true }), NOW, { since: "2026-10-31T00:00:00Z", limit: 100 })
    expect(pages.every((result) => new Set(result.events.map((e) => e.external_id)).size === result.events.length)).toBe(true)
  })

  it("lists each of a second's results once where the second spans pages with later results after it", async () => {
    const T = Date.parse("2026-11-02T00:00:00Z")
    const commits = [
      ...Array.from({ length: 150 }, (_, k) => commit(`t${String(k).padStart(5, "0")}`, iso(T))),
      ...Array.from({ length: 100 }, (_, k) => commit(`u${String(k).padStart(5, "0")}`, iso(T + (k + 1) * 1000))),
    ]
    const pages = await read(world({ commits, shuffle: true }), NOW, { since: "2026-10-31T00:00:00Z", limit: 500 })
    expect(pages.every((result) => new Set(result.events.map((e) => e.external_id)).size === result.events.length)).toBe(true)
  })
})

describe("an item belongs to the stream that read it", () => {
  it("moves the pull request stream past what its search answered, whatever the item says", async () => {
    // Pull requests as the search answers them, without their pull_request field.
    const issues = Array.from({ length: 30 }, (_, k) => ({ ...issue(7000 + k, iso(Date.parse("2026-11-02T00:00:00Z") + k * 1000)), html_url: `https://github.com/octo/app/pull/${7000 + k}` }))
    const pages = await read(world({ issues }), NOW, { since: "2026-10-31T00:00:00Z", limit: 10 })
    expect(ids(pages)).toHaveLength(30)
  })
})

describe("one gap per read", () => {
  for (const [label, step] of [["5 minutes", 5 * 60_000], ["20 hours", 20 * 3_600_000], ["2 days", 2 * 86_400_000]] as const) {
    it(`answers one gap for a read from before GitHub's three months paged ${label} apart, and lists every notification GitHub keeps`, async () => {
      const DAY = 86_400_000
      const issues = Array.from({ length: 40 }, (_, k) => issue(k + 1, iso(NOW - 120 * DAY + k * 2 * DAY)))
      // One 88.5 days old: inside GitHub's window when the read starts, which holds for the whole read.
      const inbox = [note("0", iso(NOW - 88.5 * DAY)), note("1", iso(NOW - 60 * DAY)), note("2", iso(NOW - 10 * DAY))]
      const pages = await read(world({ issues, inbox }), (k) => NOW + k * step, { since: iso(NOW - 120 * DAY), limit: 5 })
      expect(gaps(pages)).toEqual([{ reason: "window-truncated", since: iso(NOW - 120 * DAY) }])
      expect(ids(pages).filter((id) => id.startsWith("notification:"))).toEqual(inbox.map((n) => `notification:${n.id}@${n.updated_at}`))
      expect(ids(pages).filter((id) => !id.startsWith("notification:"))).toHaveLength(40)
    })
  }

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
