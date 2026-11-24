// The cursor: at most CURSOR_MAX characters (960), under the source contract's 1,024, with names never spelled out
// (a search position holds a hash of its item's id) and times in base 36.
import { describe, expect, it } from "vitest"
import type { ApiOutput } from "../../src/api/contract.js"
import { EVENT_LIMITS, resultProblems, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { CURSOR_MAX, LOOKBACK_REMEMBERED, ORDER_KEY_LENGTH, encodeState, listEvents, orderKey, ownerOf } from "../../src/source-events.js"

const LOGIN = "octo-person"
const NOW = Date.parse("2026-11-08T12:00:00Z")
const ok = (data: unknown): ApiOutput => ({ ok: true, status: 200, data, truncated: false, trust: { githubContent: "untrusted" } })
const commit = (sha: string, date: string, repo = "octo/app") => ({ sha, html_url: `https://github.com/${repo}/commit/${sha}`, repository: { full_name: repo }, author: { login: LOGIN }, commit: { message: `c ${sha}`, author: { name: "O", email: "o@example.test", date }, committer: { date } } })
const issue = (n: number, updated: string, repo = "octo/app") => ({ number: n, title: `Item ${n}`, body: "", state: "open", updated_at: updated, repository_url: `https://api.github.com/repos/${repo}`, html_url: `https://github.com/${repo}/issues/${n}`, user: { login: "x" }, assignees: [], labels: [] })

/** GitHub over a world: `>=` and `a..b` qualifiers, both ends inclusive, oldest first; notifications newest first. */
function github(world: { commits: ReturnType<typeof commit>[]; issues: ReturnType<typeof issue>[] }) {
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
    if (path === "/notifications") return ok([])
    throw new Error(path)
  }
}

const decoded = (cursor: string) => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>

describe("the cursor's size", () => {
  const owner = ownerOf("a".repeat(39))
  const account = "a".repeat(39)
  /** Every field at its longest: times inside a second, a 20-digit notification, the lookback full and far back. */
  // A walk through a second at its last place, its total and its page size, at their longest.
  const walk = { total: 1000, size: 100 }
  const worst = (keys: [string, string, string], walking = false) =>
    encodeState(
      account,
      owner,
      {
        i: { t: 9_999_999_999_999, i: keys[0], ...(walking ? { walk } : {}) },
        p: { t: 9_999_999_999_998, i: keys[1], ...(walking ? { walk } : {}) },
        c: { t: 9_999_999_999_997, i: keys[2], ...(walking ? { walk } : {}) },
        n: { t: 9_999_999_999_996, i: "9".repeat(20) },
      },
      9_999_999_999_996 - 6 * 60 * 60_000,
      new Map(Array.from({ length: LOOKBACK_REMEMBERED }, (_, k) => [`${k}`.padStart(8, "f"), 9_999_999_999_996 - 6 * 60 * 60_000 + k])),
      { gapAt: 9_999_999_999_995, cut: 9_999_999_999_994, lostAt: 9_999_999_999_993, held: { stream: "c", second: 9_999_999_999_997 } },
    )

  it(`is at most ${CURSOR_MAX} characters with names of the longest GitHub allows in all three search positions, a cut, a gap and a loss`, () => {
    // A 39-character owner, a 100-character repository, the largest issue number and a commit's 40-character sha.
    const name = `${"o".repeat(39)}/${"r".repeat(100)}`
    const keys: [string, string, string] = [orderKey(`${name}#2147483647`), orderKey(`${name}#2147483646`), orderKey(`${name}@${"f".repeat(40)}`)]
    expect(keys.every((key) => key.length === ORDER_KEY_LENGTH)).toBe(true)
    const cursor = worst(keys)
    expect(CURSOR_MAX).toBe(960)
    // 791 characters, with a held second and all 16 notifications remembered.
    expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX)
    // All three search streams walking a second instead, at its last place: 799, the longest.
    const walking = worst(["!rr", "!rr", "!rr"], true)
    expect(walking.length).toBeLessThanOrEqual(CURSOR_MAX)
    expect((decoded(walking)["p"] as unknown[][])[0]).toEqual([(9_999_999_999_999).toString(36).replace(/^/, "~"), "!rr", "rs", "2s"])
    const state = decoded(cursor)
    expect(state).toMatchObject({ k: 1, a: account })
    expect(Object.keys(state).sort()).toEqual(["a", "b", "g", "h", "k", "l", "o", "p", "q", "s", "u", "v"])
    // The whole lookback fits: nothing had to be forgotten.
    expect((state["l"] as [string, string[]])[1]).toHaveLength(LOOKBACK_REMEMBERED)
  })

  it("spells out no name: a read of the longest names leaves only order keys in its cursor", async () => {
    const repo = `${"o".repeat(39)}/${"r".repeat(100)}`
    const world = {
      commits: Array.from({ length: 3 }, (_, k) => commit("f".repeat(39) + k, `2026-11-0${k + 1}T00:00:00Z`, repo)),
      issues: Array.from({ length: 3 }, (_, k) => issue(2147483640 + k, `2026-11-0${k + 1}T00:00:00Z`, repo)),
    }
    const result = (await listEvents(github(world), async () => LOGIN, { since: "2026-10-31", limit: 4 }, NOW)) as EventsListResult
    expect(resultProblems(result)).toEqual([])
    expect(result.cursor.length).toBeLessThanOrEqual(EVENT_LIMITS.cursor)
    expect(result.more).toBe(true)
    expect(Buffer.from(result.cursor, "base64url").toString("utf8")).not.toContain("rrrr")
    expect(result.cursor.length).toBeLessThanOrEqual(CURSOR_MAX)
  })
})
