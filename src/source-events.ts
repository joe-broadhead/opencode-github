// GitHub's source under the source contract (`@we-the-rebel-alliance/source-contract`, declared in package.json's
// `sources` as `github.activity`): events_list lists what the signed-in person did or was involved in since a cursor,
// as normalised events, oldest first, for Memory's collector and other consumers, and probe names who is signed in.
//
// events_list only reads: GET requests through github_api's own spec, with the plugin's sign-in. Each GET asserts the
// tool's own permission, `github_events_list`, on its `GET /path` as the caller, unattended: it runs only under a prior
// allow rule, and the grant for the tool (Jelly writes one for a declared read) covers exactly these reads. It reaches
// nothing but EVENTS_READS. It never asks GitHub who is signed in: the account and the owner are the sign-in's own,
// the login GitHub's GET /user named when the person signed in, which /github-status shows as the Account. probe makes
// that one GET /user, under its own action `github_probe`, to confirm the sign-in still names that login.
//
// Four streams, each with its own position in the one cursor:
// - issues, and pull requests, the person is involved in (`involves:`), from /search/issues sorted by update, oldest
//   first, as two searches (`is:issue`, `is:pull-request`), because GitHub refuses a search for both together from a
//   GitHub App user token: one event each time one changes;
// - commits the person authored, from /search/commits sorted by committer date, oldest first. GitHub searches only a
//   repository's default branch and exposes no time a commit reached it, so a commit whose committer date is earlier
//   than the time it reached the default branch (typically one from a pull request merged later, or a cherry-pick)
//   becomes searchable only after the stream's position has passed its date, and is never listed, with no gap. The
//   pull-request stream still lists the merge of a pull request the person is involved in. A known limit, not re-scanned:
//   a lossless re-scan needs per-commit state the cursor cannot hold;
// - notifications, where the sign-in may read them (/notifications; a 401, 403 or 404 leaves them out), except those
//   about an issue or a pull request, which the first stream already lists.
// A search reads pages of 100 from its position up to the read's cut, paging by time: each page after the first asks
// again from the last second the one before it read, so a result that changes while the search pages moves past the cut
// and nothing slides into a page already read. When a page lies in one second, or every result it read shares one, that
// second is read whole by itself (GitHub answers up to 1,000), in the plugin's order (by a hash of each id), so the position walks it
// across calls and then moves past it. A page whose answer is over what events_list reads whole is read again in pages
// of 10, then 1; a result alone over it is left out, and the read answers a gap for it. A call makes at most 30 search
// requests, GitHub's limit a minute, and each request has READ_DEADLINE_MS.
// A read holds one cut, on every page until it ends: nothing newer is listed by it. Notifications are read under it; a
// backlog over 500 is counted and walked oldest first across calls.
// GitHub keeps inbox notifications for three months (unless saved), so a read that starts before that, from a cursor or
// from since, may have lost some: it answers `gap` (`expired` from a cursor, `window-truncated` from since) and reads
// notifications from the window's start. So does a backlog GitHub will not page through (from the oldest it read on),
// a second with more search results than GitHub answers, which the search moves past, and a search result alone over
// what events_list reads whole, which is left out. Where a read restarts counts
// from its cut; whether GitHub may have deleted some is checked on GitHub's clock, on every page. A read answers one
// gap: until it ends, the cursor carries that it did, and a loss found after it, which the next read's first page
// answers. Each read looks again at the 6 hours before the notifications' position for one GitHub delivered late, and
// the cursor remembers what it listed there, so none is listed twice. A search GitHub answers as incomplete is read again on the next call, never skipped.
// The result merges them by time, and lists only what no stream can still put before it: a stream with more pages
// than one call reads holds the others at its last time. Search lags GitHub by a little, so an event is listed once
// it is SETTLE_MS old. An event whose title or text holds a secret is refused for good (`refused[]`), and the cursor
// moves past it.
import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { CURSOR_V2, decodeBoundCursor, encodeBoundCursor, type CursorBinding } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  EVENT_LIMITS,
  GAP_REASONS,
  PAGE,
  PROBE,
  type EventsGap,
  type EventsListResult,
  type EventsOwner,
  type ProbeResult,
  type SourceEvent,
  eventsListResult,
  fitPage,
  makeEvent,
  parseEventsListInput,
  parseProbeInput,
  probeResult,
  screenEvents,
  secretKinds,
  startTime,
} from "@we-the-rebel-alliance/source-contract/events"
import type { OwnedMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import type { ApiInput, ApiOutput } from "./api/contract.js"
import type { ApiScope, Call, ReadLimits } from "./api/tool.js"
import { GitHubPluginError } from "./errors.js"
import { SERVER_NAME } from "./rpc.js"
import { EVENTS_TOOL_NAME } from "./tools.js"

/** The plugin's package name, which every page names. */
export const PACKAGE = "@joe-broadhead/opencode-github"
/** The source contract's namespace for this plugin: the source is `github.activity`, and each cursor is bound to it. */
export const NAMESPACE = "github"
/** The one source this plugin lists: events_list's `source` input. */
export const SOURCE = "github"
/** The tool's permission action: github_events_list. */
export const EVENTS_ACTION = `${SERVER_NAME}_${EVENTS_TOOL_NAME}`
/** The probe's permission action: `sources.probe.action` in package.json. */
export const PROBE_ACTION = `${SERVER_NAME}_${PROBE}`
/**
 * The only requests events_list sends, each asserted as EVENTS_ACTION on its own resource: the two searches and
 * notifications. Any other resource, a redirect elsewhere included, is refused before it is sent.
 */
export const EVENTS_READS = ["GET /search/issues", "GET /search/commits", "GET /notifications"] as const
const EVENTS_SCOPE: ApiScope = { action: EVENTS_ACTION, resources: EVENTS_READS }
/** The list snapshot `github.notifications`. One GET /notifications, the same client as the activity feed. */
export const NOTIFICATIONS_LIST = "notifications"
const LIST_CAP = 50
const LIST_SCOPE: ApiScope = { action: EVENTS_ACTION, resources: ["GET /notifications"] }
/** The only request probe sends, asserted as PROBE_ACTION on its resource: who the token belongs to. */
export const PROBE_READS = ["GET /user"] as const
const PROBE_SCOPE: ApiScope = { action: PROBE_ACTION, resources: PROBE_READS }
/** The most bytes of JSON one page holds: the source's declared `maxBytes`. */
export const PAGE_BYTES = 900_000
/** A GitHub login: letters, digits and hyphens, at most 39. */
const LOGIN = /^[A-Za-z0-9-]{1,39}$/

/** GitHub's search index lags a little behind a change; an event is listed once it is this old. */
export const SETTLE_MS = 5 * 60_000
/** Results per notifications page: GitHub's most. */
const PER_PAGE = 50
/** Results per search page: GitHub's most. */
export const SEARCH_PER_PAGE = 100
/** The smaller search page an answer over EVENTS_MAX_BYTES is read again in; then one result a page. */
export const SEARCH_SMALL_PAGE = 10
/**
 * The most bytes one answer of `events_list`'s own reads may hold, its searches and its notifications: GitHub's answer,
 * not the 100,000-byte cut `github_api` shows an agent. A page of SEARCH_PER_PAGE results usually arrives whole, but
 * nothing bounds a result's size (labels, people, a milestone, and a commit message with no limit), so a search answer
 * over this is never cut: its range is read again in smaller pages, and a result alone over it is left out with a gap.
 * A notifications answer over it (50 notifications of a few KB each) is refused by name, `TOO_LARGE`.
 */
export const EVENTS_MAX_BYTES = 32 * 1024 * 1024
/**
 * How long one of events_list's or probe's requests may take, its answer read whole included; past it the request is
 * stopped and the call answers UNAVAILABLE, with the cursor unchanged. The caller's own abort still stops it at once.
 */
export const READ_DEADLINE_MS = 60_000
/** The most pages one search reads from its position in one call. */
const SEARCH_PAGES = 6
/** GitHub answers at most this many results for one search query, whatever its total_count says. */
export const SEARCH_CAP = 1000
/**
 * The most search requests one call makes, across its three searches (issues, pull requests, commits): GitHub allows
 * 30 a minute for a signed-in user. Three reads of SEARCH_PAGES make at most 18, which leaves room for one second read
 * whole (SEARCH_CAP / SEARCH_PER_PAGE = 10 requests).
 */
export const SEARCH_BUDGET = 30
/** The most notifications one call reads (10 pages of 50); a backlog over it is walked oldest first across calls. */
export const NOTIFICATION_CAP = 500
/** The largest backlog it counts; past it, or where GitHub will not page that far, the read answers a gap. */
export const NOTIFICATION_COUNT_MAX = 64_000
const DAY_MS = 24 * 60 * 60_000
/**
 * How long GitHub keeps an inbox notification that is not saved: three months, taken as the shortest (89 days), so a
 * notification older than this may be gone.
 */
export const NOTIFICATION_RETENTION_MS = 89 * DAY_MS
/**
 * How far behind its position each read looks again for notifications GitHub delivered late: one stamped up to this
 * long before the position, and not listed yet, is listed when it appears.
 */
export const NOTIFICATION_LOOKBACK_MS = 6 * 60 * 60_000
/** The most notifications the cursor remembers as listed inside the lookback; past them, the lookback starts later. */
export const LOOKBACK_REMEMBERED = 16
/** A position after every item of its second: ids are digits, `owner/repo#n` or `owner/repo@sha`, all below it. */
const AFTER_SECOND = "\uffff"
/** Notifications about these are the issue and pull request stream's. */
const COVERED = new Set(["Issue", "PullRequest"])

type Data = Record<string, unknown>
/** Issues, pull requests, commits and notifications: GitHub searches issues and pull requests separately. */
type StreamName = "i" | "p" | "c" | "n"
const STREAMS: readonly StreamName[] = ["i", "p", "c", "n"]

/**
 * A GET through github_api's spec, as the caller. `maxBytes` is how much of the answer to read whole: a source's own
 * read (`events_list`) sets EVENTS_MAX_BYTES, and every other read keeps github_api's 100,000-byte inline cap.
 */
export type Get = (path: string, query: Record<string, string | number | boolean>, maxBytes?: number) => Promise<ApiOutput>
/** The signed-in login, as the sign-in recorded it (GitHub's GET /user at sign-in); undefined when nobody is signed in. */
export type Identity = () => Promise<string | undefined>

/**
 * A place in a stream: a time, and inside its second an order key `i` ("" before every item of the second, AFTER_SECOND
 * after all of them). An item's order key is ORDER_KEY_LENGTH characters of a hash of its id for the searches (so a
 * position never spells out a repository's name), and the notification's id for notifications. `raw` marks a position
 * carried over from a 0.0.6 or 0.0.7 cursor inside a second, which ordered that second by id: until the stream leaves
 * that second, its items there keep that order (`i` is the id), so the walk goes on where it stopped.
 */
interface Key {
  readonly t: number
  readonly i: string
  readonly raw?: true
  /** A walk through this second in GitHub's order (`searchSecond`), where `i` is a `walkKey`. */
  readonly walk?: Walk
}

interface Item extends Key {
  readonly s: StreamName
  /** What the item is, whatever its order key: `owner/repo#n`, `owner/repo@sha`, or the notification's id. */
  readonly id: string
  readonly event: SourceEvent
}

/**
 * The length of a search item's order key: 66 bits of SHA-256 of its id, in base64url. Two different items of one second
 * share a key with odds of about one in 10^16 for a second of 1,000 results; the tie is then broken by id, except
 * against a cursor's position, which holds only the key.
 */
export const ORDER_KEY_LENGTH = 11
/** A search item's order key inside its second: its id, hashed. */
export const orderKey = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, ORDER_KEY_LENGTH)
/** A notification's order key: its id, which GitHub gives as digits, or the hash of an id that is not. */
const notificationKey = (id: string) => (/^\d{1,20}$/.test(id) ? id : orderKey(id))


const record = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined)
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** Time, then the order key; two items with one key, by id. */
const compare = (a: Key & { id?: string }, b: Key & { id?: string }) => a.t - b.t || order(a.i, b.i) || (a.id !== undefined && b.id !== undefined ? order(a.id, b.id) : 0)
const time = (value: unknown) => {
  const at = text(value)
  const parsed = at === undefined ? Number.NaN : Date.parse(at)
  return Number.isFinite(parsed) ? parsed : undefined
}
/** GitHub's search qualifiers take whole seconds. */
const isoSeconds = (at: number) => `${new Date(Math.floor(at / 1000) * 1000).toISOString().slice(0, 19)}Z`

type EventsCode = "INPUT_INVALID" | "SOURCE_UNKNOWN" | "CURSOR_INVALID" | "ACCOUNT_MISMATCH" | "AUTH_REQUIRED" | "TOO_LARGE" | "UNAVAILABLE"
const fail = (code: EventsCode, message: string, next: string): never => {
  throw new GitHubPluginError(code, message, next)
}

/** The login in GET /user's answer, or a login itself. */
export function loginOf(value: unknown): string | undefined {
  let data = value
  if (typeof data === "string") {
    try {
      data = JSON.parse(data)
    } catch {
      return undefined
    }
  }
  const user = record(data) && record(data["user"]) ? data["user"] : data
  const login = record(user) ? text(user["login"]) : undefined
  return login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : undefined
}

const actor = (role: string, user: unknown) => {
  const login = record(user) ? text(user["login"]) : undefined
  return login ? [{ role, id: `github:${login}` }] : []
}

/** An issue or a pull request from /search/issues, as the event of its last change, in the issue or pull request stream. */
export function issueItem(raw: unknown, account: string): Item | undefined {
  if (!record(raw)) return undefined
  const at = time(raw["updated_at"])
  const repo = text(raw["repository_url"])?.replace(/^.*\/repos\//, "")
  const number = raw["number"]
  if (at === undefined || !repo || typeof number !== "number" || !text(raw["html_url"])) return undefined
  const pr = record(raw["pull_request"])
  const merged = pr && text((raw["pull_request"] as Data)["merged_at"]) !== undefined
  const assignees = Array.isArray(raw["assignees"]) ? raw["assignees"] : []
  const labels = Array.isArray(raw["labels"]) ? raw["labels"].flatMap((label) => (record(label) && text(label["name"]) ? [text(label["name"])!] : [])) : []
  const id = `${repo}#${number}`
  const event = makeEvent({
    source: SOURCE,
    account,
    external_id: `${id}@${new Date(at).toISOString()}`,
    // The source declares the one kind `event`, which a consumer confirms; what it was stays in `labels`.
    kind: "event",
    occurred_at: at,
    thread: `github:${id}`,
    actors: [...actor("author", raw["user"]), ...assignees.flatMap((user) => actor("assignee", user))],
    title: `${id}: ${text(raw["title"]) ?? ""}`,
    text: typeof raw["body"] === "string" ? raw["body"] : "",
    url: text(raw["html_url"])!,
    labels: [pr ? "pr" : "issue", merged ? "merged" : (text(raw["state"]) ?? "open"), ...labels],
  })
  return { s: pr ? "p" : "i", t: at, i: orderKey(id), id, event }
}

/** A commit from /search/commits, at its committer date. */
export function commitItem(raw: unknown, account: string): Item | undefined {
  if (!record(raw) || !record(raw["commit"])) return undefined
  const commit = raw["commit"]
  const sha = text(raw["sha"])
  const repo = record(raw["repository"]) ? text(raw["repository"]["full_name"]) : undefined
  const at = time(record(commit["committer"]) ? commit["committer"]["date"] : undefined) ?? time(record(commit["author"]) ? commit["author"]["date"] : undefined)
  if (!sha || !repo || at === undefined || !text(raw["html_url"])) return undefined
  const message = typeof commit["message"] === "string" ? commit["message"] : ""
  const author = record(commit["author"]) ? commit["author"] : {}
  const email = text(author["email"])?.toLowerCase()
  const actors = actor("author", raw["author"])
  return {
    s: "c",
    t: at,
    i: orderKey(`${repo}@${sha}`),
    id: `${repo}@${sha}`,
    event: makeEvent({
      source: SOURCE,
      account,
      external_id: `${repo}@${sha}`,
      // The source declares the one kind `event`, which a consumer confirms; what it was stays in `labels`.
      kind: "event",
      occurred_at: at,
      thread: `github:${repo}`,
      actors: actors.length > 0 ? actors : email && /^[^\s@]+@[^\s@]+$/.test(email) ? [{ role: "author", id: `mailto:${email}`, ...(text(author["name"]) ? { name: text(author["name"])! } : {}) }] : [],
      title: `${repo}: ${message.split(/\r?\n/, 1)[0] ?? ""}`,
      text: message,
      url: text(raw["html_url"])!,
      labels: ["commit"],
    }),
  }
}

/** A notification thread, at its last update; undefined for one about an issue or a pull request. */
export function notificationItem(raw: unknown, account: string): Item | undefined {
  if (!record(raw) || !record(raw["subject"])) return undefined
  const subject = raw["subject"]
  const type = text(subject["type"])
  const id = text(raw["id"])
  const at = time(raw["updated_at"])
  const repository = record(raw["repository"]) ? raw["repository"] : {}
  const repo = text(repository["full_name"])
  if (!id || at === undefined || !type || COVERED.has(type)) return undefined
  const reason = text(raw["reason"]) ?? "subscribed"
  return {
    s: "n",
    t: at,
    i: notificationKey(id),
    id,
    event: makeEvent({
      source: SOURCE,
      account,
      external_id: `notification:${id}@${new Date(at).toISOString()}`,
      kind: "event",
      occurred_at: at,
      thread: repo ? `github:${repo}` : null,
      actors: [],
      title: `${repo ? `${repo}: ` : ""}${text(subject["title"]) ?? type}`,
      text: `${type}, ${reason.replaceAll("_", " ")}.`,
      url: text(repository["html_url"]) ?? null,
      labels: [type.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(), reason],
    }),
  }
}

/** A GET's one page: its list, where the results end, whether GitHub timed out, and whether the answer was cut. */
interface Answer {
  readonly items: unknown[]
  readonly total?: number
  readonly incomplete: boolean
  readonly truncated: boolean
}

/**
 * A GET's list, or UNAVAILABLE; `allowed` lists the statuses that mean "not for this sign-in", read as none, and
 * `maxBytes` is how much of the answer to read whole. A cut answer is reported, not failed: each caller names its own
 * limit, and one cut below a single item is no list at all.
 */
async function list(get: Get, path: string, query: Record<string, string | number | boolean>, pick: (data: unknown) => unknown, allowed: readonly number[] = [], maxBytes?: number): Promise<Answer | undefined> {
  const output = await get(path, query, maxBytes)
  if (allowed.includes(output.status)) return undefined
  if (!output.ok) fail("UNAVAILABLE", `GitHub answered ${path} with ${output.status}.`, output.nextStep ?? "Call events_list again with the same cursor; if it keeps failing, run /github-status.")
  const items = pick(output.data)
  if (!Array.isArray(items) && !output.truncated) fail("UNAVAILABLE", `GitHub answered ${path} without a list.`, "Call events_list again with the same cursor; if it keeps failing, run /github-status.")
  const data = record(output.data) ? output.data : {}
  const total = typeof data["total_count"] === "number" ? data["total_count"] : undefined
  const incomplete = data["incomplete_results"] === true
  return { items: Array.isArray(items) ? items : [], ...(total === undefined ? {} : { total }), incomplete, truncated: output.truncated }
}

/** A search answer over EVENTS_MAX_BYTES: never a part of a list; its range is read again in smaller pages. */
const OVER = "over"

/**
 * One search page of `size` results, read whole. GitHub's answer is read up to EVENTS_MAX_BYTES, not the 100,000-byte
 * cut github_api shows an agent; an answer over it is OVER, never cut, and the caller reads its range in smaller pages.
 */
async function searchPage(get: Get, spec: Search, range: string, page: number, size: number): Promise<Answer | typeof OVER> {
  const answer = (await list(get, spec.path, { q: spec.query(range), sort: spec.sort, order: "asc", per_page: size, page }, searchItems, [], EVENTS_MAX_BYTES))!
  return answer.truncated ? OVER : answer
}

/** One stream's read: its items after its position, oldest first; whether it ended; the last time it read. */
interface Read {
  readonly items: Item[]
  readonly complete: boolean
  readonly last: number
}

/**
 * A search's read. `start` is the position the stream continues from: its own, past seconds that hold no result, or
 * past a second it finished or could not read whole (`skipped`, a second with more results than GitHub answers, which
 * the page answers as a gap). `stuck` names a second that holds every result the read found: it is read whole next, by
 * itself. `oversized` names a second read whole that held a result alone over EVENTS_MAX_BYTES, left out: the page that
 * enters that second answers a gap for it.
 */
interface SearchRead extends Read {
  readonly start: Key
  readonly stuck?: number
  readonly skipped?: number
  readonly oversized?: number
  /** Its second could not be read whole for want of requests: the next call reads it first. */
  readonly held?: boolean
  /** Its items are a walk through their second, in GitHub's order, which the position carries on. */
  readonly walk?: Walk
  /** Its items are all of their second after the position: once they are listed, the stream moves past the second. */
  readonly ends?: boolean
}

/** One search stream: where it reads, how it sorts, and its query for a range of times. */
interface Search {
  readonly path: string
  readonly sort: string
  readonly query: (range: string) => string
  readonly make: (raw: unknown) => Item | undefined
}

/** The search requests one call may still make. */
interface Budget {
  left: number
}

/** An item as the stream that read it. */
const streamOf = (item: Item | undefined, s: StreamName): Item | undefined => (item === undefined ? undefined : { ...item, s })

/** Where a search position's results begin: after its second when it is past all of it. */
const startOf = (from: Key) => (from.i === AFTER_SECOND ? from.t + 1000 : from.t)
const searchItems = (data: unknown) => (record(data) ? data["items"] : undefined)
/** The start of a time's second. */
const secondOf = (at: number) => Math.floor(at / 1000) * 1000

/**
 * One search stream, oldest first, from its position up to the read's cut (`end`): pages until it holds more than
 * `need` items, ends, or has made SEARCH_PAGES requests. It pages by time, never by page number: each page asks again
 * from the last second the page before it read, so a result that changes meanwhile leaves the range (its change is
 * after the cut, the next read's) and none slides into a page already read; a result read twice is listed once. A page
 * that lies in one second cannot be paged past by time: that second is read whole (`searchSecond`) with what is left of
 * the stream's requests, and the search goes on after it. Without enough, or when every item it found shares one second,
 * nothing in that second can be listed before it ends: the read is `stuck` there, and the caller reads that second
 * whole. An answer over EVENTS_MAX_BYTES is read again from the same point in pages of SEARCH_SMALL_PAGE; where one of
 * those is over it too, the search lists what it read before that page's second, or goes on with `pastLarge`.
 */
async function search(get: Get, spec: Search, from: Key, need: number, budget: Budget, end: number): Promise<SearchRead> {
  const hold: SearchRead = { items: [], complete: false, last: from.t, start: from }
  const cut = secondOf(end)
  const items: Item[] = []
  const keys = new Set<string>()
  let last = from.t
  let at = startOf(from)
  let size = SEARCH_PER_PAGE
  let read = false
  let requests = 0
  // The earliest second read whole here that held a result alone over the limit, left out.
  let oversized: number | undefined
  const lost = () => (oversized === undefined ? {} : { oversized })
  const take = () => {
    if (requests >= SEARCH_PAGES || budget.left <= 0) return false
    requests++
    budget.left--
    return true
  }
  while (take()) {
    const answer = await searchPage(get, spec, `${isoSeconds(at)}..${isoSeconds(cut)}`, 1, size)
    if (answer === OVER) {
      if (size > SEARCH_SMALL_PAGE) {
        size = SEARCH_SMALL_PAGE
        continue
      }
      // A result among the next few is too large to read with others: list what came before this page's second, or
      // read the first second that holds a result by itself (`pastLarge`).
      if (items.some((item) => item.t < at)) return { items: items.sort(compare), complete: false, last: at, start: from, ...lost() }
      if (items.length > 0) return { ...hold, stuck: at, ...lost() }
      return pastLarge(get, spec, from, at, cut, budget)
    }
    // GitHub's search timed out and may have left results out: list nothing past the position, and read it again on the
    // next call, rather than move past what it left out.
    if (answer.incomplete) return hold
    read = true
    // Where the page ends in GitHub's order: its last result up to the cut. A result GitHub shows changed since its index
    // placed it can carry a later time anywhere on the page, so the page's latest time is not where it ends.
    let newest = at
    for (const raw of answer.items) {
      const item = spec.make(raw)
      if (!item) continue
      if (item.t <= end) newest = Math.max(at, item.t)
      // The next page reads this page's last second again, and GitHub may order a second's results differently from one
      // request to the next: each change is listed once.
      const key = `${item.id}@${item.t}`
      if (compare(item, from) > 0 && !keys.has(key)) {
        keys.add(key)
        items.push(item)
      }
    }
    // total_count says where the results end; without it, a short page does.
    const ended = answer.items.length === 0 || (answer.total !== undefined ? answer.items.length >= answer.total : answer.items.length < size)
    if (ended) return { items: items.sort(compare), complete: true, last, start: from, ...lost() }
    last = Math.max(last, newest)
    const next = secondOf(newest)
    if (next > at) at = next
    else {
      // A page in one second cannot be paged past by time: that second is read whole, by itself, with what is left of
      // this stream's requests, and the search goes on after it. Without enough, the caller reads it (`stuck`).
      const allowed = Math.min(budget.left, SEARCH_PAGES - requests)
      const allowance: Budget = { left: allowed }
      const whole = await searchSecond(get, spec, from, at, allowance)
      requests += allowed - allowance.left
      budget.left -= allowed - allowance.left
      if (whole.skipped !== undefined || (whole.items.length === 0 && whole.start === from)) break
      const second = at
      items.splice(0, items.length, ...items.filter((item) => secondOf(item.t) !== second), ...whole.items)
      for (const item of whole.items) keys.add(`${item.id}@${item.t}`)
      if (whole.oversized !== undefined) oversized ??= whole.oversized
      // Everything before the next second is read.
      last = Math.max(last, second + 1000)
      at = second + 1000
      if (at > cut) return { items: items.sort(compare), complete: true, last, start: from, ...lost() }
    }
    if (items.length > need && items.some((item) => item.t < last)) break
  }
  if (!read) return hold
  // Every item found shares the last second read (or none is new): only that second, read whole, moves the stream on.
  if (items.every((item) => item.t === last)) return { ...hold, stuck: last, ...lost() }
  return { items: items.sort(compare), complete: false, last, start: from, ...lost() }
}

/**
 * Where a search goes on when the next few results from `at` are too large to read together, with pages of one result
 * (the first result of a range is its earliest). A first result GitHub answers within EVENTS_MAX_BYTES names the second
 * to read whole by itself (`stuck`), where one alone over it can be left out. A first result alone over it is left out
 * with a gap from `at` (`skipped`) when nothing else lies before the next result's second, and the stream moves past
 * them; otherwise that second is read whole. The stream moves past seconds that hold no result. It may use what is left
 * of the call's budget: without it, the stream holds.
 */
async function pastLarge(get: Get, spec: Search, from: Key, at: number, cut: number, budget: Budget): Promise<SearchRead> {
  const hold: SearchRead = { items: [], complete: false, last: from.t, start: from }
  /** Past every second from `at` before `second`, which hold no result this read lists. */
  const past = (second: number): Key => (second > at ? { t: second - 1000, i: AFTER_SECOND } : from)
  const stuck = (second: number): SearchRead => ({ items: [], complete: false, last: second, start: past(second), stuck: second })
  /** The result at `offset` from `at` up to `to`: OVER, the item, null past the last, or undefined when the read holds. */
  const result = async (to: number, offset: number): Promise<Item | typeof OVER | null | undefined> => {
    if (budget.left <= 0) return undefined
    budget.left--
    const answer = await searchPage(get, spec, `${isoSeconds(at)}..${isoSeconds(to)}`, offset + 1, 1)
    if (answer === OVER) return OVER
    if (answer.incomplete) return undefined
    if (answer.items.length === 0) return null
    // A result the plugin cannot read is no more listable than one over the limit.
    return spec.make(answer.items[0]) ?? OVER
  }
  const first = await result(cut, 0)
  if (first === undefined) return hold
  if (first === null) return { items: [], complete: true, last: cut, start: from }
  if (first !== OVER) return stuck(secondOf(first.t))
  // The first result is over the limit alone: the first one after it that is not bounds its range.
  let offset = 1
  let next = await result(cut, offset)
  while (next === OVER) next = await result(cut, ++offset)
  if (next === undefined) return hold
  // Nothing else up to the cut: the stream is past it for this read.
  if (next === null) return { items: [], complete: true, last: cut, start: { t: cut, i: AFTER_SECOND }, skipped: at }
  const second = secondOf(next.t)
  if (second <= at) return stuck(at)
  // At most `offset` results lie before that second: if the first of them is over the limit, all are (unless GitHub
  // reorders results of one second between requests), and they are left out together.
  const before = await result(second - 1000, 0)
  if (before === undefined) return hold
  if (before === null) return stuck(second)
  if (before !== OVER) return stuck(secondOf(before.t))
  return { items: [], complete: false, last: second, start: past(second), skipped: at }
}

/**
 * A walk through one second in GitHub's own order, for a second a call cannot read whole: its items are listed as they
 * are read, keyed by their place (`walkKey`), and the stream's position carries the walk, so the next call goes on
 * from it, in the same size of page, rather than reading the second again. `total` is the second's total_count when the
 * walk began: a second whose total changes has lost a result while it was walked.
 */
interface Walk {
  readonly total: number
  readonly size: number
}

/** The order key of the result at `offset` of a walked second: `!` sorts after "" and before every hashed key. */
const walkKey = (offset: number) => `!${offset.toString(36).padStart(2, "0")}`
const WALK_KEY = /^!([0-9a-z]{2,3})$/
/** The place a walk key names; undefined for any other key. */
const walkOffset = (key: string) => {
  const match = WALK_KEY.exec(key)
  return match ? Number.parseInt(match[1]!, 36) : undefined
}

/**
 * One second of a search stream, read whole with a query for that second alone, in the plugin's own order (by order
 * key, a hash of each id), so the position walks its items across calls whatever order GitHub gives them in. Its items
 * after the position are listed; when none is left, the stream moves past the second. A second with more results than
 * GitHub answers (SEARCH_CAP) cannot be read whole: the stream moves past it, and the page answers the gap (`skipped`).
 * A result only leaves the second while it is read (its change is after the cut), and then those after it move up a
 * place: a page whose total differs from the first page's reads the second again from its first result. A page over
 * EVENTS_MAX_BYTES is read again as pages of SEARCH_SMALL_PAGE at the same offsets, and one of those as pages of one
 * result; a result alone over it is left out (`oversized`), and the page that enters the second answers a gap for it.
 *
 * Without the budget to read it whole, the stream holds (`held`), and the next call reads it first. Read first
 * (`first`), from a position before it, a second still too large for the call is walked instead (`Walk`): what was read
 * is listed in GitHub's order, and the position carries the walk on. A walk goes on from its position (a `walkKey`);
 * when its second's total has changed, the stream moves past the second with a gap (`skipped`).
 */
async function searchSecond(get: Get, spec: Search, from: Key, second: number, budget: Budget, first = false): Promise<SearchRead> {
  // Held, the stream has nothing between its position and the second (its read found only that second), so it holds
  // back only what comes after the second: the other streams list on up to it.
  const hold: SearchRead = { items: [], complete: false, last: second + 1000, start: from, held: true }
  const past: Key = { t: second, i: AFTER_SECOND }
  const at = isoSeconds(second)
  // A walk goes on after its position's place; any other read starts at the second's first result.
  const after = from.t === second && from.walk !== undefined ? walkOffset(from.i) : undefined
  const walking = after !== undefined
  const begin = walking ? after + 1 : 0
  const mayWalk = walking || (first && compare(from, { t: second, i: "" }) <= 0)
  let entries: { offset: number; item: Item }[] = []
  let ids = new Set<string>()
  // GitHub's page `page` of `size` results; each smaller size reads one page of the larger as ten, at the same offsets.
  let size = walking ? from.walk!.size : SEARCH_PER_PAGE
  let page = Math.floor(begin / size) + 1
  // The results read, those left out included, against total_count.
  let read = (page - 1) * size
  let total: number | undefined = walking ? from.walk!.total : undefined
  let oversized = false
  // The last place, from where this read began, that holds only results left out: a walk moves past them.
  let skippedTo: number | undefined
  const walked = (ended: boolean): SearchRead => {
    const items = entries.filter((entry) => entry.offset >= begin).map((entry) => ({ ...entry.item, i: walkKey(entry.offset) }))
    const lost = oversized ? { oversized: second } : {}
    const walk: Walk = { total: total ?? read, size }
    if (ended && items.length === 0) return { items: [], complete: false, last: second + 1000, start: past, ...lost }
    const start = skippedTo !== undefined ? { t: second, i: walkKey(skippedTo), walk } : from
    return { items, complete: false, last: second + 1000, start, walk, ...(ended ? { ends: true } : {}), ...lost }
  }
  for (;;) {
    if (budget.left <= 0) return mayWalk && read > begin ? walked(false) : hold
    budget.left--
    const answer = await searchPage(get, spec, `${at}..${at}`, page, size)
    if (answer === OVER) {
      // The same results again, in smaller pages at the same offsets, from the first one this read needs.
      if (size > 1) {
        const smaller = size / SEARCH_SMALL_PAGE
        page = Math.floor(Math.max(begin, (page - 1) * size) / smaller) + 1
        size = smaller
        read = (page - 1) * size
        continue
      }
      // One result alone is over what events_list reads whole: it is left out, and the read answers a gap for it.
      oversized = true
      if (!entries.some((entry) => entry.offset >= begin && entry.offset < read)) skippedTo = read
      read += 1
    } else {
      if (answer.incomplete) return { ...hold, held: false }
      if (answer.total !== undefined && answer.total > SEARCH_CAP) return { items: [], complete: false, last: second, start: past, skipped: second }
      if (total !== undefined && answer.total !== undefined && answer.total !== total) {
        // A result left the second while it was read. A walk cannot tell where, so it moves past the second with a gap;
        // any other read reads the second again from its first result.
        if (walking) return { items: [], complete: false, last: second, start: past, skipped: second }
        entries = []
        ids = new Set()
        page = 1
        read = 0
        size = SEARCH_PER_PAGE
        total = undefined
        oversized = false
        skippedTo = undefined
        continue
      }
      total ??= answer.total
      answer.items.forEach((raw, index) => {
        const item = spec.make(raw)
        const offset = (page - 1) * size + index
        if (item && item.t === second && offset >= begin && (walking || compare(item, from) > 0) && !ids.has(item.id)) {
          ids.add(item.id)
          entries.push({ offset, item })
        }
      })
      read = (page - 1) * size + answer.items.length
    }
    // total_count says where the results end; without it, a short page does.
    const ended = (answer !== OVER && answer.items.length === 0) || (total !== undefined ? read >= total : answer !== OVER && answer.items.length < size)
    if (!ended) {
      page++
      // Back to the larger page once the smaller ones have read all of one of its pages.
      while (size < SEARCH_PER_PAGE && (page - 1) % SEARCH_SMALL_PAGE === 0) {
        page = (page - 1) / SEARCH_SMALL_PAGE + 1
        size = size * SEARCH_SMALL_PAGE
      }
      continue
    }
    if (walking) return walked(true)
    // The second is read whole: list what is after the position, or move past it.
    const lost = oversized ? { oversized: second } : {}
    const items = entries.map((entry) => entry.item)
    if (items.length === 0) return { items: [], complete: false, last: second + 1000, start: past, ...lost }
    return { items: items.sort(compare), complete: false, last: second + 1000, start: from, ends: true, ...lost }
  }
}

/**
 * The notifications' state a cursor carries: the position, the lookback's start (`floor`), and a hash of each
 * notification listed at or after it (`seen`, with its time), so one GitHub delivers late is listed once, and one already
 * listed is never listed again.
 */
interface Notified {
  readonly position: Key
  readonly floor: number
  readonly seen: ReadonlyMap<string, number>
}

/** A listed notification's hash in the lookback: its id at its time. */
const seenKey = (item: Key) => createHash("sha256").update(`${item.i}@${item.t}`).digest("hex").slice(0, 8)

/** The notifications' read: whether the sign-in may read them, where the stream continues from, and whether it lost any. */
interface NotificationsRead extends Read {
  readonly readable: boolean
  readonly state: Notified
  /** More notifications than one call reads came after the position: those before `state.position` were not read. */
  readonly truncated: boolean
}

/**
 * Notifications under the read's cut, oldest first: those after the position, and those inside the lookback not listed
 * yet; none, and not readable, when the sign-in may not read them. The cut holds for the whole read, so what GitHub
 * delivers after it is the next read's, and the set this read walks never grows at its top. At most NOTIFICATION_CAP
 * are read whole. With more (a backlog), it counts them, asking for one notification alone at a time (GitHub lists them
 * newest first), and reads the oldest NOTIFICATION_CAP: the stream lists what is before the newest second it read, and
 * the next call walks on, under the same cut. Where GitHub will not page that far, or one second holds the whole
 * backlog, the read falls back to the newest NOTIFICATION_CAP and a gap (`truncatedRead`).
 */
async function notifications(get: Get, state: Notified, account: string, cut: number): Promise<NotificationsRead> {
  const { position } = state
  const base = startOf(position)
  const before = isoSeconds(Math.floor(cut / 1000) * 1000 + 1000)
  const ask: Ask = async (since, page, perPage) => {
    const read = await list(get, "/notifications", { all: true, participating: true, since: isoSeconds(since), before, per_page: perPage, page }, (data) => data, [401, 403, 404, 422], EVENTS_MAX_BYTES)
    // A page over the limit events_list reads whole is named by that limit, as a search page is.
    if (read?.truncated === true) fail("TOO_LARGE", `GitHub's answer to /notifications is over ${EVENTS_MAX_BYTES / (1024 * 1024)} MB, the most events_list reads whole.`, "Nothing in events_list changes it: the answer is over the bytes events_list reads whole.")
    return read
  }
  /** Whether the window from `since` holds an n-th notification; undefined when GitHub will not say. */
  const has = async (since: number, n: number) => {
    const read = await ask(since, n, 1)
    return read === undefined ? undefined : read.items.length > 0
  }
  const unreadable: NotificationsRead = { items: [], complete: true, last: position.t, readable: false, state, truncated: false }
  let since = Math.min(state.floor, base)
  let floor = state.floor
  let backlog = await has(since, NOTIFICATION_CAP + 1)
  if (backlog === undefined) return unreadable
  if (backlog && since < base) {
    // A backlog with the lookback: walk from the position without it.
    since = base
    floor = Math.max(floor, base + 1000)
    backlog = await has(since, NOTIFICATION_CAP + 1)
    if (backlog === undefined) return unreadable
  }
  const next: Notified = { ...state, floor }
  if (!backlog) {
    const raws: unknown[] = []
    for (let page = 1; page <= NOTIFICATION_CAP / PER_PAGE; page++) {
      const read = await ask(since, page, PER_PAGE)
      if (read === undefined) return unreadable
      raws.push(...read.items)
      if (read.items.length < PER_PAGE) break
    }
    return { items: pick(raws, next, account), complete: true, last: Number.POSITIVE_INFINITY, readable: true, state: next, truncated: false }
  }
  // Count the backlog: double until a notification is missing, then halve the difference.
  let present = NOTIFICATION_CAP + 1
  let absent = 0
  for (let n = 2 * NOTIFICATION_CAP; absent === 0; n *= 2) {
    const found = n > NOTIFICATION_COUNT_MAX ? undefined : await has(since, n)
    if (found === undefined) return truncatedRead(ask, state, since, account)
    if (found) present = n
    else absent = n
  }
  while (absent - present > 1) {
    const middle = Math.floor((present + absent) / 2)
    const found = await has(since, middle)
    if (found === undefined) return truncatedRead(ask, state, since, account)
    if (found) present = middle
    else absent = middle
  }
  const raws: unknown[] = []
  for (let page = Math.ceil((present - NOTIFICATION_CAP + 1) / PER_PAGE); page <= Math.ceil(present / PER_PAGE); page++) {
    const read = await ask(since, page, PER_PAGE)
    if (read === undefined) return truncatedRead(ask, state, since, account)
    raws.push(...read.items)
  }
  // Everything not read is at least as new as the newest read.
  const times = raws.flatMap((raw) => (record(raw) ? (time(raw["updated_at"]) ?? []) : []))
  const last = times.length > 0 ? Math.max(...times) : Number.NaN
  const items = pick(raws, next, account)
  // Progress needs a notification before the newest second read: a backlog of one second cannot be walked.
  if (!Number.isFinite(last) || !items.some((item) => item.t < last)) return truncatedRead(ask, state, since, account)
  return { items, complete: false, last, readable: true, state: next, truncated: false }
}

/** A notifications request: from `since`, under the read's cut, one page. */
type Ask = (since: number, page: number, perPage: number) => ReturnType<typeof list>

/** The notifications to list from GitHub's answers: after the position, or inside the lookback and not listed yet; oldest first, each once. */
function pick(raws: readonly unknown[], state: Notified, account: string): Item[] {
  const items = new Map<string, Item>()
  for (const raw of raws) {
    const item = notificationItem(raw, account)
    if (!item) continue
    const after = compare(item, state.position) > 0
    const late = !after && item.t >= state.floor && !state.seen.has(seenKey(item))
    if (after || late) items.set(`${item.i}@${item.t}`, item)
  }
  return [...items.values()].sort(compare)
}

/**
 * The newest NOTIFICATION_CAP notifications, when the backlog cannot be walked: the stream restarts after the oldest
 * second read (`truncated`), and the caller answers the notifications before it as a gap.
 */
async function truncatedRead(ask: Ask, state: Notified, since: number, account: string): Promise<NotificationsRead> {
  const raws: unknown[] = []
  for (let page = 1; page <= NOTIFICATION_CAP / PER_PAGE; page++) {
    const read = await ask(since, page, PER_PAGE)
    if (read === undefined) break
    raws.push(...read.items)
    if (read.items.length < PER_PAGE) break
  }
  const times = raws.flatMap((raw) => (record(raw) ? (time(raw["updated_at"]) ?? []) : []))
  // No time GitHub named: nothing to restart from, so list none of them until it fits.
  if (times.length === 0) return { items: [], complete: false, last: state.position.t, readable: true, state, truncated: false }
  const oldest = Math.min(...times)
  const next: Notified = { position: { t: oldest, i: AFTER_SECOND }, floor: oldest + 1000, seen: new Map() }
  return { items: pick(raws, next, account), complete: true, last: Number.POSITIVE_INFINITY, readable: true, state: next, truncated: true }
}

/** The owner a page and a probe name: `github:` and the login, labelled with the login. The same everywhere. */
export const ownerOf = (login: string, host?: string): EventsOwner =>
  host === undefined ? { id: `github:${login}`, label: login } : { id: `github:${login}@${host.toLowerCase()}`, label: `${login} (${host.toLowerCase()})` }
/** The account a page names, and a cursor and a grant are bound to: the login as GitHub compares logins, lowercase. */
const accountOf = (login: string) => login.toLowerCase()
/** A cursor's owner hash: a cursor of another sign-in is refused. */
const digest = (owner: EventsOwner) => createHash("sha256").update(owner.id).digest("hex").slice(0, 16)
const bindingOf = (account: string): CursorBinding => ({ plugin: NAMESPACE, source: SOURCE, account })

const START_AGAIN = "Call events_list without a cursor, with since, to start again."
const refuseCursor = (): never => fail("CURSOR_INVALID", "The cursor was not issued by GitHub's events_list for this account and its signed-in user.", START_AGAIN)

/**
 * The account a bound cursor of this source names inside, read before its binding is checked, to tell another
 * account's cursor from a broken one; undefined for anything else, which the binding check then refuses.
 */
function cursorAccount(cursor: string): string | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    const account = record(value) && value["v"] === CURSOR_V2 && value["s"] === SOURCE ? value["a"] : undefined
    return typeof account === "string" && LOGIN.test(account) ? account.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** The contract version a cursor names (`v`); undefined for anything that is not a cursor. */
function cursorVersion(cursor: string): unknown {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    return record(value) ? value["v"] : undefined
  } catch {
    return undefined
  }
}

/** What a cursor holds: each stream's position, the notifications' lookback, and when the read answered its gap. */
interface CursorState {
  readonly from: Record<StreamName, Key>
  readonly notified: Notified
  /** When this read answered its gap: no later page of the read answers another (a consumer counts one resync per gap). */
  readonly gapAt?: number
  /** The read's cut: it lists nothing newer, on every page, and what comes after it is the next read's. */
  readonly cut?: number
  /**
   * History lost after the read answered its gap, from this time: the next read's first page answers it as a gap
   * (`expired`), so a later loss in a read is never silent.
   */
  readonly lostAt?: number
  /** A second a call could not read whole for want of requests, which the next call reads first. */
  readonly held?: { readonly stream: "i" | "p" | "c"; readonly second: number }
}

const SEEN = /^([0-9a-f]{8})([0-9a-z]{1,11})$/

/**
 * The cursor's format, `k` in it. 1: positions as a list in STREAMS order, each `[time, key]` (`[time, id, 1]` for a
 * position carried over from an older cursor inside a second, `[time, walk key, total, size]` for a walk), the lookback
 * as `[behind, hashes]`, a held second as `h: [stream, time]`, and every time in base 36 (`timeOf`). A cursor without `k` is 0.0.6's and 0.0.7's: times in milliseconds, and positions keyed by stream
 * whose search ids order their second by id.
 */
const CURSOR_FORMAT = 1
/**
 * The most characters a cursor of format 1 has, well under the source contract's 1,024 (EVENT_LIMITS.cursor): its
 * fields are bounded (a login of 39, an owner hash of 16, search order keys of ORDER_KEY_LENGTH, a notification key of
 * 20 digits, times of at most 9 characters, a walk's place, total and page size, a held second), so with every field at
 * its longest, all three searches walking a second and all LOOKBACK_REMEMBERED notifications remembered it is 799; past
 * CURSOR_MAX the lookback would forget its oldest notifications. Only a
 * position carried over from an older cursor inside a second, which keeps that cursor's id until its stream leaves the
 * second, can pass it, and stays shorter than the cursor it came from.
 */
export const CURSOR_MAX = 960
/** A time in a cursor: whole seconds in base 36, or `~` and milliseconds in base 36 for a time inside a second. */
const timeText = (at: number) => (at % 1000 === 0 ? (at / 1000).toString(36) : `~${at.toString(36)}`)
const TIME = /^(~?)([0-9a-z]{1,11})$/
const timeOf = (value: unknown): number | undefined => {
  const match = typeof value === "string" ? TIME.exec(value) : null
  if (!match) return undefined
  const at = Number.parseInt(match[2]!, 36) * (match[1] === "~" ? 1 : 1000)
  return Number.isSafeInteger(at) ? at : undefined
}

/**
 * The cursor's state. Every cursor a release wrote is read as it was written, and the read goes on from it with nothing
 * lost or listed again: format 1 (`k`); 0.0.6's and 0.0.7's (positions in milliseconds, with a lookback); 0.0.3's to
 * 0.0.5's (the same, without a lookback or a read's cut); and 0.0.0's to 0.0.2's (contract 1, unbound, account
 * `default`, one stream for issues and pull requests), which only the owner's hash ties to the sign-in. Anything else,
 * a cursor bound to another plugin, source or account, or holding another sign-in's owner, is CURSOR_INVALID: start
 * again with since.
 */
function stateOf(cursor: string, account: string, owner: EventsOwner): CursorState {
  const decoded = decodeBoundCursor(bindingOf(account), cursor, { acceptV1: true })
  if (!decoded.ok) return refuseCursor()
  const state = decoded.state
  if (state["o"] !== digest(owner)) return refuseCursor()
  if (decoded.legacy) return state["a"] === "default" ? first(state) : refuseCursor()
  if (state["a"] !== account) return refuseCursor()
  return state["k"] === CURSOR_FORMAT ? current(state) : state["k"] === undefined ? earlier(state) : refuseCursor()
}

/** A position an older cursor wrote: a time in milliseconds and an id, which ordered its second (`raw`) inside one. */
function olderKey(pair: unknown, search: boolean): Key | undefined {
  if (!(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "number" && Number.isSafeInteger(pair[0]) && typeof pair[1] === "string")) return undefined
  const inside = search && pair[1] !== "" && pair[1] !== AFTER_SECOND
  return { t: pair[0], i: pair[1], ...(inside ? { raw: true as const } : {}) }
}

/**
 * A cursor of 0.0.0 to 0.0.2: issues and pull requests were one stream, in one order, so its position is each of the
 * two streams' own: what it listed of either lies at or before it. It had no lookback.
 */
function first(state: Record<string, unknown>): CursorState {
  const positions = record(state["p"]) ? state["p"] : undefined
  if (positions === undefined || Object.keys(positions).sort().join() !== "c,i,n") return refuseCursor()
  const issues = olderKey(positions["i"], true)
  const commits = olderKey(positions["c"], true)
  const notes = olderKey(positions["n"], false)
  if (issues === undefined || commits === undefined || notes === undefined) return refuseCursor()
  return withLookback({ i: issues, p: issues, c: commits, n: notes }, [undefined, undefined, undefined], undefined, undefined)
}

/** The read's state the cursor carries, after its positions: the gap, the cut, the loss and the lookback. */
function withLookback(from: Record<StreamName, Key>, times: readonly (number | undefined)[], behind: number | undefined, hashes: unknown): CursorState {
  const [gapAt, cut, lostAt] = times
  const read = {
    ...(gapAt === undefined ? {} : { gapAt }),
    ...(cut === undefined ? {} : { cut }),
    ...(lostAt === undefined ? {} : { lostAt }),
  }
  // 0.0.5 and earlier had no lookback: it looks again at nothing before the position.
  if (behind === undefined && hashes === undefined) return { from, notified: { position: from.n, floor: from.n.t + 1000, seen: new Map() }, ...read }
  if (behind === undefined || !Array.isArray(hashes) || hashes.length > LOOKBACK_REMEMBERED) return refuseCursor()
  const seen = new Map<string, number>()
  for (const entry of hashes) {
    const match = typeof entry === "string" ? SEEN.exec(entry) : null
    if (!match) return refuseCursor()
    seen.set(match[1]!, from.n.t - Number.parseInt(match[2]!, 36))
  }
  return { from, notified: { position: from.n, floor: from.n.t - behind, seen }, ...read }
}

/** A cursor of format 1. */
function current(state: Record<string, unknown>): CursorState {
  const positions = Array.isArray(state["p"]) && state["p"].length === STREAMS.length ? state["p"] : []
  const keys = positions.map((entry: unknown, index): Key | undefined => {
    if (!Array.isArray(entry) || typeof entry[1] !== "string") return undefined
    const t = timeOf(entry[0])
    if (t === undefined) return undefined
    const i = entry[1] as string
    if (entry.length === 2) return { t, i }
    // Only a search position may be carried over from an older cursor, or walk a second.
    if (index >= 3) return undefined
    if (entry.length === 3) return entry[2] === 1 ? { t, i, raw: true } : undefined
    const total = typeof entry[2] === "string" && /^[0-9a-z]{1,3}$/.test(entry[2]) ? Number.parseInt(entry[2], 36) : undefined
    const size = typeof entry[3] === "string" ? Number.parseInt(entry[3], 36) : undefined
    const walks = entry.length === 4 && walkOffset(i) !== undefined && total !== undefined && total <= SEARCH_CAP && (size === 1 || size === SEARCH_SMALL_PAGE || size === SEARCH_PER_PAGE)
    return walks ? { t, i, walk: { total, size: size! } } : undefined
  })
  if (keys.length !== STREAMS.length || keys.some((key) => key === undefined)) return refuseCursor()
  const from = { i: keys[0]!, p: keys[1]!, c: keys[2]!, n: keys[3]! }
  const times = ["g", "u", "q"].map((name) => (state[name] === undefined ? undefined : (timeOf(state[name]) ?? refuseCursor())))
  if (!(Array.isArray(state["l"]) && state["l"].length === 2)) return refuseCursor()
  const lookback = state["l"]
  const behind = typeof lookback[0] === "string" && /^-?[0-9a-z]{1,11}$/.test(lookback[0]) ? Number.parseInt(lookback[0], 36) : undefined
  const read = withLookback(from, times, behind, lookback[1])
  if (state["h"] === undefined) return read
  const h = state["h"]
  const stream = Array.isArray(h) && h.length === 2 && typeof h[0] === "number" ? (["i", "p", "c"] as const)[h[0]] : undefined
  const second = Array.isArray(h) ? timeOf(h[1]) : undefined
  return stream !== undefined && second !== undefined ? { ...read, held: { stream, second } } : refuseCursor()
}

/**
 * A cursor of 0.0.3 to 0.0.7. Its search positions inside a second ordered that second by id: they are carried over as
 * such (`raw`), so the walk goes on where it stopped. 0.0.6 and 0.0.7 added the lookback (`l`) and the read's gap, cut
 * and loss; 0.0.5 and earlier had none of them.
 */
function earlier(state: Record<string, unknown>): CursorState {
  const positions = record(state["p"]) ? state["p"] : undefined
  const keys = STREAMS.map((stream) => olderKey(positions?.[stream], stream !== "n"))
  if (keys.some((key) => key === undefined)) return refuseCursor()
  if (state["l"] === undefined && ["g", "u", "q"].some((name) => state[name] !== undefined)) return refuseCursor()
  const from = { i: keys[0]!, p: keys[1]!, c: keys[2]!, n: keys[3]! }
  const times = ["g", "u", "q"].map((name) => {
    const value = state[name]
    return value === undefined ? undefined : typeof value === "number" && Number.isSafeInteger(value) ? value : refuseCursor()
  })
  const lookback = state["l"]
  const behind = record(lookback) && typeof lookback["f"] === "number" && Number.isSafeInteger(lookback["f"]) ? lookback["f"] : undefined
  return withLookback(from, times, behind, record(lookback) ? lookback["h"] : undefined)
}

/** The signed-in login, or AUTH_REQUIRED; `method` names the caller in the message. */
async function signedIn(identity: Identity, method: string): Promise<string> {
  const login = await identity()
  if (login === undefined) return fail("AUTH_REQUIRED", `GitHub is not signed in, so ${method} has no account to read.`, "Run /connect and choose GitHub.")
  if (!LOGIN.test(login)) return fail("UNAVAILABLE", "The GitHub sign-in does not name a GitHub login.", "Run /connect and choose GitHub to sign in again.")
  return login
}

/**
 * One page of events. `get` reads GitHub as the caller, `identity` names the signed-in login (no GitHub call), `now`
 * fixes the clock. A listing with a cursor names its account; a cursor for another account than the one named, or an
 * account that is not the signed-in one, is ACCOUNT_MISMATCH, before any GitHub call.
 */
export async function listEvents(get: Get, identity: Identity, input: unknown, now: number, host?: string): Promise<EventsListResult> {
  const parsed = parseEventsListInput(input)
  if (!parsed.ok) return fail("INPUT_INVALID", `The events_list input is invalid: ${parsed.problems.join("; ")}.`, "Pass only since, cursor, limit (1 to 500), account and source, as the tool's schema describes.")
  const request = parsed.value
  if (request.source !== undefined && request.source !== SOURCE) fail("SOURCE_UNKNOWN", `This plugin has no source "${request.source}"; its one source is "${SOURCE}".`, `Leave source out, or pass "${SOURCE}".`)
  // A cursor of 0.0.0 to 0.0.2 came with their one account, `default`, or none: it reads the signed-in account, as they
  // did, and its owner's hash still ties it to the sign-in.
  const first = request.cursor !== undefined && (request.account === undefined || request.account === "default") && cursorVersion(request.cursor) === 1
  const asked = request.account === undefined || first ? undefined : request.account.toLowerCase()
  if (request.cursor !== undefined && !first) {
    if (asked === undefined) fail("INPUT_INVALID", "A listing with a cursor names the account it reads: events_list has no account.", 'Pass "account", the signed-in login that probe and the previous result name, with the cursor.')
    const named = cursorAccount(request.cursor)
    if (named !== undefined && named !== asked) {
      fail("ACCOUNT_MISMATCH", `The cursor is for another GitHub account than "${request.account}".`, `Pass the cursor with the account it was issued for, or call events_list for "${request.account}" without a cursor, with since, to start again.`)
    }
  }
  const login = await signedIn(identity, EVENTS_TOOL_NAME)
  const account = accountOf(login)
  if (asked !== undefined && asked !== account) {
    fail("ACCOUNT_MISMATCH", `GitHub is signed in to another account than "${request.account}".`, `Sign in to GitHub as that account (/connect, GitHub), or read as "${account}", the signed-in login.`)
  }
  const owner = ownerOf(login, host)
  const start: Key = { t: startTime(request, now), i: "" }
  const state: CursorState =
    request.cursor !== undefined ? stateOf(request.cursor, account, owner) : { from: { i: start, p: start, c: start, n: start }, notified: { position: start, floor: start.t + 1000, seen: new Map() } }
  const from = state.from
  // The read's cut, pinned on its first page: an event is listed once it is SETTLE_MS old, and nothing newer than the cut
  // is listed on any page of the read; the next read lists it.
  const end = state.cut ?? Math.floor(now - SETTLE_MS)

  // A position a 0.0.6 or 0.0.7 cursor left inside a second ordered it by id: that second's items keep that order, so
  // the walk goes on exactly where it stopped, and the position stays so until the stream leaves the second.
  const carried = (stream: "i" | "p" | "c", item: Item | undefined): Item | undefined =>
    item !== undefined && from[stream].raw && item.t === from[stream].t ? { ...item, i: item.id, raw: true } : item
  // GitHub refuses a search for issues and pull requests together from a GitHub App user token (HTTP 422): one each.
  const searches: Record<"i" | "p" | "c", Search> = {
    // An item belongs to the stream that read it, so that stream's position moves past it.
    i: { path: "/search/issues", sort: "updated", query: (range) => `is:issue involves:${login} updated:${range}`, make: (raw) => carried("i", streamOf(issueItem(raw, account), "i")) },
    p: { path: "/search/issues", sort: "updated", query: (range) => `is:pull-request involves:${login} updated:${range}`, make: (raw) => carried("p", streamOf(issueItem(raw, account), "p")) },
    c: { path: "/search/commits", sort: "committer-date", query: (range) => `author:${login} committer-date:${range}`, make: (raw) => carried("c", commitItem(raw, account)) },
  }
  const budget: Budget = { left: SEARCH_BUDGET }
  const searched: Record<"i" | "p" | "c", SearchRead> = { i: { items: [], complete: true, last: Number.POSITIVE_INFINITY, start: from.i }, p: { items: [], complete: true, last: Number.POSITIVE_INFINITY, start: from.p }, c: { items: [], complete: true, last: Number.POSITIVE_INFINITY, start: from.c } }
  // A second a call could not read whole for want of requests is read first: a held second (`h` in the cursor), or one
  // its stream walks across calls. It takes the budget less one request for each other search, which is enough for each
  // to list what comes before it; nothing past it can be listed until it is read, so it never waits behind them again.
  const searchStreams = ["i", "p", "c"] as const
  const heldSecond = (stream: "i" | "p" | "c") =>
    from[stream].walk !== undefined ? from[stream].t : state.held?.stream === stream && state.held.second >= from[stream].t ? state.held.second : undefined
  const firsts = searchStreams.filter((stream) => heldSecond(stream) !== undefined).sort((a, b) => heldSecond(a)! - heldSecond(b)!)
  const others = searchStreams.filter((stream) => !firsts.includes(stream) && startOf(from[stream]) <= end)
  for (const stream of firsts) {
    const allowance: Budget = { left: Math.max(0, budget.left - others.length) }
    const allowed = allowance.left
    searched[stream] = await searchSecond(get, searches[stream], from[stream], heldSecond(stream)!, allowance, true)
    budget.left -= allowed - allowance.left
  }
  // Each search leaves one request for every search after it, so none is left without a page to read.
  for (const [index, stream] of others.entries()) {
    const allowance: Budget = { left: Math.max(0, budget.left - (others.length - 1 - index)) }
    const allowed = allowance.left
    searched[stream] = await search(get, searches[stream], from[stream], request.limit, allowance, end)
    budget.left -= allowed - allowance.left
  }
  // A stream whose read found only one second reads that second whole, with what is left of the budget: the earliest
  // second first, as the merge lists it first, so the stream that holds every other back always gets the budget. It reads
  // from where the search left the stream: its position, or past seconds the search found empty.
  const stuck = (["i", "p", "c"] as const).flatMap((stream) => (searched[stream].stuck === undefined ? [] : [{ stream, second: searched[stream].stuck! }]))
  for (const { stream, second } of stuck.sort((a, b) => a.second - b.second || (a.stream < b.stream ? -1 : 1))) {
    searched[stream] = await searchSecond(get, searches[stream], searched[stream].start, second, budget)
  }

  // GitHub keeps notifications for three months: a stream that starts before that may have lost some, so it restarts at
  // the window's start, and the read answers the gap. Where it restarts counts from the read's cut, so the position does
  // not slide while the read pages; whether GitHub may have deleted some counts from GitHub's clock (below).
  const floor = end + SETTLE_MS - NOTIFICATION_RETENTION_MS
  const outside = state.notified.position.t < floor
  const restarted: Key = { t: floor, i: "" }
  const notifiedFrom: Notified = outside ? { position: restarted, floor: restarted.t + 1000, seen: new Map() } : state.notified
  const notified: NotificationsRead =
    startOf(notifiedFrom.position) > end
      ? { items: [], complete: true, last: Number.POSITIVE_INFINITY, readable: false, state: state.notified, truncated: false }
      : await notifications(get, notifiedFrom, account, end)
  const reads: Record<StreamName, Read> = { ...searched, n: notified }
  // Nothing at or after a stream's last read time is listed while that stream has more: it could still come first.
  const horizon = Math.min(end + 1, ...STREAMS.filter((stream) => !reads[stream].complete).map((stream) => reads[stream].last))
  const merged = STREAMS.flatMap((stream) => reads[stream].items)
    .filter((item) => item.t < horizon)
    .sort((a, b) => a.t - b.t || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) || compare(a, b))
  // The package's screening: an event that holds a secret is refused for good, and the cursor moves past it.
  const screened = screenEvents(merged.map((item) => item.event))
  const refusedIds = new Map(screened.refused.map((entry) => [entry.external_id, entry]))
  const fits = fitPage(screened.events.slice(0, request.limit), request.limit, PAGE_BYTES)
  const listed: Item[] = []
  // Each stream continues from where its read left it: its own position, past a second, or inside the window.
  const positions: Record<StreamName, Key> = {
    i: searched.i.start,
    p: searched.p.start,
    c: searched.c.start,
    n: notified.readable ? notified.state.position : from.n,
  }
  const seen = new Map(notified.readable ? notified.state.seen : state.notified.seen)
  let lookback = notified.readable ? notified.state.floor : state.notified.floor
  let consumed = 0
  let notificationsListed = 0
  for (const item of merged) {
    const refused = refusedIds.has(item.event.external_id)
    if (!refused && listed.length === fits) break
    if (!refused) listed.push(item)
    // A late notification lies behind the position: it never moves the position back.
    if (compare(item, positions[item.s]) > 0) {
      const walk = item.s === "n" ? undefined : searched[item.s].walk
      positions[item.s] = { t: item.t, i: item.i, ...(item.raw ? { raw: true as const } : {}), ...(walk !== undefined && walkOffset(item.i) !== undefined ? { walk } : {}) }
    }
    if (item.s === "n") {
      seen.set(seenKey(item), item.t)
      notificationsListed++
    }
    consumed++
  }
  // Every notification GitHub has up to the settle time is listed: the stream's position moves there, so a quiet inbox's
  // position never falls outside the retention window while it is read; the lookback still finds one delivered late.
  if (notified.readable && notified.complete && notificationsListed === notified.items.length && compare(positions.n, { t: end, i: "" }) < 0) {
    positions.n = { t: end, i: "" }
  }
  const remembered = remember(positions.n, lookback, seen)
  lookback = remembered.floor
  // A second read to its end, and listed all of it, is past: the next call does not read it again.
  for (const stream of searchStreams) {
    const { ends, items } = searched[stream]
    if (ends && items.length > 0 && positions[stream].i === items[items.length - 1]!.i && positions[stream].t === items[0]!.t) positions[stream] = { t: items[0]!.t, i: AFTER_SECOND }
  }
  // The earliest second held for want of requests, or read whole and listed in part, which the next call reads first:
  // either is a second the stream's search would only find stuck again.
  const held = searchStreams
    .flatMap((stream) => {
      const { held: wanting, ends, items, last } = searched[stream]
      const position = positions[stream]
      if (position.walk !== undefined) return []
      if (wanting) return [{ stream, second: last - 1000 }]
      const second = items[0]?.t
      return ends && second !== undefined && position.t === second && position.i !== AFTER_SECOND ? [{ stream, second }] : []
    })
    .sort((a, b) => a.second - b.second)[0]

  // History lost: notifications GitHub no longer keeps or will not page to, a second with more search results than
  // GitHub answers, or a search result alone over what events_list reads whole. A read answers one gap, on the page where it restarts; no later page of the read answers another
  // (`g` in the cursor, which the read carries until it ends). A loss after that is carried in the cursor (`q`, also past
  // the read's end) and answered by the next read's first page, as `expired`: never silent.
  // The read's window says where it restarts; GitHub deletes on its own clock, so a position GitHub's window has passed
  // while the read pages may have lost notifications too.
  const passed = notified.readable && !outside && state.notified.position.t < now - NOTIFICATION_RETENTION_MS
  // A result alone over what events_list reads whole is left out of its second: the page whose stream enters that second
  // answers it, once, as the stream walks the second across calls.
  const entered = (stream: "i" | "p" | "c", second: number) => compare(from[stream], { t: second, i: "" }) <= 0 && compare(positions[stream], { t: second, i: "" }) > 0
  const lostSince = [
    ...(notified.readable && (outside || notified.truncated || passed) ? [state.notified.position.t] : []),
    ...(["i", "p", "c"] as const).flatMap((stream) => searched[stream].skipped ?? []),
    ...(["i", "p", "c"] as const).flatMap((stream) => {
      const second = searched[stream].oversized
      return second !== undefined && entered(stream, second) ? [second] : []
    }),
  ]
  const answered = state.gapAt !== undefined
  const owed = [...lostSince, ...(state.lostAt === undefined ? [] : [state.lostAt])]
  const gap: EventsGap | undefined =
    owed.length > 0 && !answered
      ? { reason: state.lostAt !== undefined || (outside && request.cursor !== undefined) ? "expired" : "window-truncated", since: new Date(Math.min(...owed)).toISOString() }
      : undefined
  const lostAt = answered && owed.length > 0 ? Math.min(...owed) : undefined
  const refused = merged.slice(0, consumed).flatMap((item) => refusedIds.get(item.event.external_id) ?? [])
  const more = merged.length > consumed || STREAMS.some((stream) => !reads[stream].complete)
  const gapAt = more ? (gap !== undefined ? now : answered ? state.gapAt : undefined) : undefined
  const cursor = encodeState(account, owner, positions, lookback, remembered.seen, { gapAt, cut: more ? end : undefined, lostAt, held: more ? held : undefined })
  return eventsListResult({ source: SOURCE, account, owner }, listed.map((item) => item.event), cursor, more, {
    refused,
    ...(gap === undefined ? {} : { gap }),
    plugin: PACKAGE,
    asOf: new Date(now).toISOString(),
  })
}

/**
 * The lookback a cursor carries: from LOOKBACK behind the position (never before the floor it had), with the hashes of
 * the notifications listed since. Past LOOKBACK_REMEMBERED of them, it starts after the newest one it forgets, so every
 * notification listed at or after its start is remembered.
 */
function remember(position: Key, floor: number, seen: ReadonlyMap<string, number>): { floor: number; seen: Map<string, number> } {
  let start = Math.max(floor, position.i === AFTER_SECOND ? position.t + 1000 : position.t - NOTIFICATION_LOOKBACK_MS)
  const newest = [...seen].filter(([, at]) => at >= start).sort((a, b) => b[1] - a[1])
  if (newest.length > LOOKBACK_REMEMBERED) start = Math.max(start, newest[LOOKBACK_REMEMBERED]![1] + 1000)
  return { floor: start, seen: new Map(newest.filter(([, at]) => at >= start)) }
}

/**
 * The cursor, of format CURSOR_FORMAT: each stream's position, the lookback, while a read goes on its cut and its gap,
 * and any loss the next read answers; the lookback forgets its oldest notifications until the cursor is at most
 * CURSOR_MAX characters.
 */
export function encodeState(
  account: string,
  owner: EventsOwner,
  positions: Record<StreamName, Key>,
  floor: number,
  seen: Map<string, number>,
  read: { gapAt: number | undefined; cut: number | undefined; lostAt: number | undefined; held?: CursorState["held"] },
): string {
  const p = STREAMS.map((stream) => {
    const { t, i, raw, walk } = positions[stream]
    return raw ? [timeText(t), i, 1] : walk !== undefined ? [timeText(t), i, walk.total.toString(36), walk.size.toString(36)] : [timeText(t), i]
  })
  const held = read.held === undefined ? {} : { h: [STREAMS.indexOf(read.held.stream), timeText(read.held.second)] }
  const times = Object.fromEntries(
    (
      [
        ["g", read.gapAt],
        ["u", read.cut],
        ["q", read.lostAt],
      ] as const
    ).flatMap(([name, at]) => (at === undefined ? [] : [[name, timeText(at)]])),
  )
  let entries = [...seen].sort((a, b) => b[1] - a[1])
  let start = floor
  for (;;) {
    const l = [(positions.n.t - start).toString(36), entries.map(([hash, at]) => `${hash}${(positions.n.t - at).toString(36)}`)]
    // The package refuses a cursor over EVENT_LIMITS.cursor characters; only one carried over from an older cursor can
    // pass CURSOR_MAX with no lookback left.
    const cursor = encodeBoundCursor(bindingOf(account), { k: CURSOR_FORMAT, a: account, o: digest(owner), p, l, ...times, ...held })
    if (cursor.length <= CURSOR_MAX || entries.length === 0) return cursor
    // Too long: forget the oldest, and start the lookback after it.
    start = Math.max(start, entries[entries.length - 1]![1] + 1000)
    entries = entries.filter(([, at]) => at >= start)
  }
}

/**
 * `probe` (the source contract's): who is signed in to GitHub, for the source, and nothing it reads. The account and
 * the owner are the sign-in's, as on every page; one GET /user, asserted as `github_probe`, confirms the token still
 * belongs to that login. A caller that names another account is refused with ACCOUNT_MISMATCH.
 */
export async function probeEvents(get: Get, identity: Identity, input: unknown, host?: string): Promise<ProbeResult> {
  const parsed = parseProbeInput(input)
  if (!parsed.ok) return fail("INPUT_INVALID", `The probe input is invalid: ${parsed.problems.join("; ")}.`, 'Pass only "source" and "account", or an empty object.')
  const source = parsed.value.source ?? SOURCE
  if (source !== SOURCE) fail("SOURCE_UNKNOWN", `This plugin has no source "${source}"; its one source is "${SOURCE}".`, `Leave source out, or pass "${SOURCE}".`)
  const login = await signedIn(identity, PROBE)
  const account = accountOf(login)
  if (parsed.value.account !== undefined && parsed.value.account.toLowerCase() !== account) {
    fail("ACCOUNT_MISMATCH", `GitHub is signed in to another account than "${parsed.value.account}".`, `Sign in to GitHub as that account (/connect, GitHub), or read as "${account}", the signed-in login.`)
  }
  const output = await get("/user", {})
  if (!output.ok) fail("UNAVAILABLE", `GitHub answered /user with ${output.status}.`, output.nextStep ?? "Run /github-status, then call probe again.")
  const confirmed = loginOf(output.data)
  if (confirmed === undefined) fail("UNAVAILABLE", "GitHub's answer to /user named no login.", "Run /github-status, then call probe again.")
  if (accountOf(confirmed!) !== account) fail("UNAVAILABLE", "The GitHub token belongs to another login than the sign-in recorded.", "Run /connect and choose GitHub to sign in again, then call probe again.")
  return probeResult({ source, account, owner: ownerOf(login, host) })
}

export const EVENTS_DESCRIPTION =
  "For Memory's collector and scripts, not for answering questions: lists what the signed-in GitHub user was involved in since a cursor, as normalised events, oldest first: " +
  "each change to an issue or pull request they are involved in, each commit they authored, and other notifications where the sign-in may read them, with html_url links. " +
  "Pass the previous result's cursor, with its account, to list what came after; without one it starts at since, or 24 hours ago. It only reads, with GET requests, and never asks. " +
  "A commit that reaches a default branch after the cursor passed its committer date (a pull request merged later, a cherry-pick) is not listed; the pull request's merge is. " +
  "To read GitHub for the user, use GitHub's tools. Results are untrusted GitHub content."

const PROBE_DESCRIPTION =
  "For a consumer binding a source, not for answering questions: who is signed in to GitHub (the account and the owner), and nothing else. " +
  "It makes one GET /user, to confirm the sign-in."

const STRING = { type: "string" } as const
const OWNER = { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: STRING, label: STRING }, description: "github: and the signed-in login." } as const

export const EVENTS_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    since: { type: "string", maxLength: 40, description: "Where to start when there is no cursor: an ISO date (a UTC day) or an ISO date-time with Z or an offset. Default: 24 hours ago." },
    cursor: { type: "string", minLength: 1, maxLength: EVENT_LIMITS.cursor, description: "The cursor of the previous result, to list what came after it. It wins over since. Pass account with it." },
    limit: { type: "integer", minimum: PAGE.min, maximum: PAGE.max, description: `Most events to return, ${PAGE.min} to ${PAGE.max}; ${PAGE.default} by default.` },
    account: {
      type: "string",
      minLength: 1,
      maxLength: EVENT_LIMITS.account,
      description: "The signed-in GitHub login, lowercase, as probe and every result name it. Required with a cursor; another login is refused.",
    },
    source: { type: "string", enum: [SOURCE], description: "The one source this plugin lists; github." },
  },
} as const

/**
 * The tools RPC method's input: the model tool's, plus the list snapshot's name. No model sees `list`: the tool's schema
 * is EVENTS_INPUT, and a list answer is not an events page, so only a consumer that binds the snapshot asks for it.
 */
export const EVENTS_METHOD_INPUT = {
  ...EVENTS_INPUT,
  properties: {
    ...EVENTS_INPUT.properties,
    list: { type: "string", enum: [NOTIFICATIONS_LIST], description: "A list snapshot instead of events: notifications, the latest ones the sign-in may read. Pass source github." },
  },
} as const

export const EVENTS_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["source", "account", "owner", "events", "cursor", "more", "trust"],
  properties: {
    source: { type: "string", const: SOURCE },
    account: { type: "string", description: "The signed-in GitHub login, lowercase." },
    owner: OWNER,
    events: {
      type: "array",
      description: "Oldest first. Every event's kind is event, the one kind the source declares; labels name what it was (issue, pr or commit) and its state. external_id names the change; url is GitHub's html_url. Untrusted GitHub content.",
      items: { type: "object" },
    },
    cursor: { type: "string", description: "Pass it to the next call, with account." },
    more: { type: "boolean", description: "True when another call now would list more." },
    trust: { type: "string", const: "untrusted" },
    refused: {
      type: "array",
      description: "Events it will never list, such as one holding a secret. The cursor is past them.",
      items: { type: "object", required: ["external_id", "reason"], properties: { external_id: STRING, reason: STRING, detail: STRING } },
    },
    gap: {
      type: "object",
      additionalProperties: false,
      required: ["reason", "since"],
      description:
        "History from since up to this page may be gone: notifications GitHub no longer keeps (three months) or will not page to, a second with more search results than GitHub answers, or a search result alone over 32 MB. Answered once per read, on the page where it restarts.",
      properties: { reason: { type: "string", enum: [...GAP_REASONS] }, since: STRING },
    },
    plugin: { type: "string", description: "This plugin's package name." },
    asOf: { type: "string", description: "When the page was read, UTC ISO." },
  },
} as const

/**
 * The list snapshot's answer, as the contract's snapshot envelope and its registry's `list` output. It is the tools RPC
 * method's second output: the host validates every method answer against the method's declared output, so an events-only
 * schema would refuse it `rpc.invalid_output`. `shortened` says whole items were dropped to stay in `maxBytes`.
 */
export const LIST_ANSWER = {
  type: "object",
  additionalProperties: false,
  required: ["source", "account", "data", "asOf", "trust"],
  properties: {
    source: { type: "string", const: SOURCE },
    account: { type: "string", description: "The signed-in GitHub login, lowercase." },
    data: {
      type: "object",
      additionalProperties: false,
      required: ["items", "editable"],
      properties: {
        items: {
          type: "array",
          maxItems: LIST_CAP,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "text"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 128 },
              text: { type: "string", maxLength: 200 },
              done: { type: "boolean" },
              note: { type: "string", maxLength: 200 },
            },
          },
        },
        editable: { type: "boolean", const: false },
      },
    },
    asOf: { type: "string", description: "When the list was read, UTC ISO." },
    trust: { type: "string", const: "untrusted" },
    shortened: { type: "boolean", description: "True when whole items were dropped from the end to stay within maxBytes." },
  },
} as const

/** The tools RPC method's output: an events page, or the list snapshot's answer, whichever the input asked for. */
export const EVENTS_METHOD_OUTPUT = { anyOf: [EVENTS_OUTPUT, LIST_ANSWER] } as const

const PROBE_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", enum: [SOURCE], description: "The source to probe; github, the one source." },
    account: { type: "string", minLength: 1, maxLength: EVENT_LIMITS.account, description: "The GitHub login the caller expects to be signed in; another is refused." },
  },
} as const

const PROBE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["source", "account", "owner", "trust"],
  properties: {
    source: { type: "string", const: SOURCE },
    account: { type: "string", description: "The signed-in GitHub login, lowercase." },
    owner: OWNER,
    trust: { type: "string", const: "untrusted" },
  },
} as const

export interface EventsDeps {
  readonly ctx: { readonly permission: Pick<Plugin.Context["permission"], "assert"> }
  /** github_api's spec, as `registerApiTool` returns it. */
  readonly api: { run(input: ApiInput, call: Call, scope?: ApiScope, limits?: ReadLimits): Promise<ApiOutput> }
  /** The signed-in login, as the sign-in recorded it: `registerApiTool`'s `identity`. It calls no GitHub API. */
  readonly identity: Identity
  /** The GitHub Enterprise Server host (the `host` option), which qualifies the owner; absent for github.com. */
  readonly host?: string
  readonly now?: () => number
  /** READ_DEADLINE_MS unless a test sets a shorter one. */
  readonly deadlineMs?: number
}

/** True when the call asks for the notifications list snapshot, including a list value this plugin does not have. */
export const isNotificationsList = (input: unknown): boolean => record(input) && "list" in input

/** The most bytes the list answer may hold: the source's declared `maxBytes`. */
export const LIST_MAX_BYTES = 65_536

/** A string's UTF-8 bytes, as JSON carries it. */
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/**
 * The latest notifications as the contract's `list` output, for a consumer that binds `github.notifications` and does
 * not know GitHub. One `GET /notifications` through the same client as `events_list`, not a second one, read whole up
 * to the same EVENTS_MAX_BYTES the activity feed's notifications read takes: the source's declared `maxBytes` bounds
 * what this answer holds, not what GitHub answers. Every notification is listed, read or unread, as GitHub's inbox
 * holds them, not only threads the person participates in, newest first and once each. A title that holds a secret is
 * left out, screened whole before it is cut. The answer stays inside LIST_MAX_BYTES by dropping whole items from its
 * end, which it says with `shortened: true`: it never cuts an item's bytes.
 */
export async function listNotifications(get: Get, identity: Identity, input: unknown, now: number) {
  const data = record(input) ? input : {}
  if (data["list"] !== NOTIFICATIONS_LIST) {
    fail("SOURCE_UNKNOWN", `A list read names "${NOTIFICATIONS_LIST}", not "${text(data["list"]) ?? ""}".`, `Pass "list" as "${NOTIFICATIONS_LIST}".`)
  }
  if (data["source"] !== undefined && data["source"] !== SOURCE) {
    fail("SOURCE_UNKNOWN", `This plugin has no list for "${text(data["source"]) ?? ""}".`, `Pass source "${SOURCE}" with list "${NOTIFICATIONS_LIST}".`)
  }
  const asked = text(data["account"])?.toLowerCase()
  const login = await signedIn(identity, EVENTS_TOOL_NAME)
  const account = accountOf(login)
  if (asked !== undefined && asked !== account) {
    fail("ACCOUNT_MISMATCH", `GitHub is signed in to another account than "${text(data["account"])}".`, `Sign in to GitHub as that account (/connect, GitHub), or read as "${account}", the signed-in login.`)
  }
  const page = await list(get, "/notifications", { all: true, per_page: LIST_CAP }, (body) => body, [401, 403, 404, 422], EVENTS_MAX_BYTES)
  if (page?.truncated === true) {
    fail("TOO_LARGE", "GitHub's answer to /notifications is over 32 MB, the most the list reads whole.", "Nothing in the list read changes it: the answer is over the bytes it reads whole.")
  }
  const seen = new Set<string>()
  const found: { at: number; item: { id: string; text: string; note?: string } }[] = []
  for (const raw of page?.items ?? []) {
    if (!record(raw)) continue
    const id = text(raw["id"])?.slice(0, 128)
    const subject = record(raw["subject"]) ? raw["subject"] : {}
    const title = text(subject["title"]) ?? text(subject["type"])
    const at = time(raw["updated_at"])
    if (id === undefined || title === undefined || at === undefined || seen.has(id)) continue
    // The whole title, whitespace collapsed and control characters dropped, is screened before any of it is cut.
    const full = title.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    if (full === "" || secretKinds(full).length > 0) continue
    seen.add(id)
    const repository = record(raw["repository"]) ? raw["repository"] : {}
    const note = [text(repository["full_name"]), text(raw["reason"])?.replaceAll("_", " ")].filter((part) => part !== undefined).join(", ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200)
    found.push({ at, item: { id, text: full.slice(0, 200), ...(note === "" ? {} : { note }) } })
  }
  // Newest first, then the cap: GitHub lists notifications by update already, and this holds across pages.
  const items = found.sort((a, b) => b.at - a.at).slice(0, LIST_CAP).map((row) => row.item)
  const answer = { source: SOURCE, account, data: { items, editable: false as const }, asOf: new Date(now).toISOString(), trust: "untrusted" as const }
  // Whole items, from the end, never an item's bytes: a pathological page cannot answer TOO_LARGE from the consumer.
  let shortened = false
  while (items.length > 0 && jsonBytes({ ...answer, shortened }) > LIST_MAX_BYTES) {
    items.pop()
    shortened = true
  }
  return shortened ? { ...answer, shortened } : answer
}

/** Asserts a method's own action for the caller, as the calling tool, before anything else. */
const assertAction = (deps: EventsDeps, action: string, call: Call) =>
  deps.ctx.permission.assert({
    sessionID: call.sessionID as never,
    agent: call.agent as never,
    action,
    resources: ["*"],
    save: ["*"],
    metadata: {},
    source: { type: "tool", messageID: call.messageID as never, id: call.id as never },
  })

/**
 * A GET as an unattended call of github_api's spec under `scope`: asserted as the scope's action on its `GET /path`.
 * Each request has its own deadline, READ_DEADLINE_MS, its answer read whole included: past it the request is stopped,
 * and the call answers UNAVAILABLE with `next`, having listed nothing, so its cursor is unchanged. The caller's abort
 * still stops it at once, as itself.
 */
const getter =
  (deps: EventsDeps, call: Call, scope: ApiScope, next: string): Get =>
  async (path, query, maxBytes) => {
    const ms = deps.deadlineMs ?? READ_DEADLINE_MS
    const deadline = new AbortController()
    const signal = call.signal === undefined ? deadline.signal : AbortSignal.any([call.signal, deadline.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Settled first, so the request stopping after it is not what the call answers.
        reject(new GitHubPluginError("UNAVAILABLE", `GitHub did not answer GET ${path} within ${ms / 1000} seconds.`, next))
        deadline.abort()
      }, ms)
    })
    try {
      return await Promise.race([deps.api.run({ method: "GET", path, query }, { ...call, script: true, signal }, scope, maxBytes === undefined ? undefined : { inlineBytes: maxBytes, readBytes: maxBytes }), late])
    } finally {
      clearTimeout(timer)
    }
  }

/**
 * The tool's and the method's one run: asserts github_events_list for the caller, then lists, with GETs only. Each GET
 * runs as an unattended call of github_api's spec under EVENTS_SCOPE, so it resolves and asserts `github_events_list`
 * (not `github_api`) on its own `GET /path` before it is sent: an agent with no base allow rule, as Jelly's are, needs
 * only the tool's own allow; a rule that asks or denies refuses it, and nothing is sent.
 */
export async function runEvents(deps: EventsDeps, input: unknown, call: Call): Promise<EventsListResult> {
  await assertAction(deps, EVENTS_ACTION, call)
  return listEvents(getter(deps, call, EVENTS_SCOPE, "Call events_list again with the same cursor; if GitHub keeps answering slowly, run /github-status."), deps.identity, input, (deps.now ?? Date.now)(), deps.host)
}

/** `events_list` for either path: the notifications list, or the activity feed. The list asserts the same action, on `GET /notifications` only. */
export async function runSource(deps: EventsDeps, input: unknown, call: Call): Promise<EventsListResult | Awaited<ReturnType<typeof listNotifications>>> {
  if (!isNotificationsList(input)) return runEvents(deps, input, call)
  await assertAction(deps, EVENTS_ACTION, call)
  return listNotifications(getter(deps, call, LIST_SCOPE, "Call events_list again; if GitHub keeps answering slowly, run /github-status."), deps.identity, input, (deps.now ?? Date.now)())
}

/** probe's one run: asserts github_probe for the caller, then its one GET /user under PROBE_SCOPE. */
export async function runProbe(deps: EventsDeps, input: unknown, call: Call): Promise<ProbeResult> {
  await assertAction(deps, PROBE_ACTION, call)
  return probeEvents(getter(deps, call, PROBE_SCOPE, "Call probe again; if GitHub keeps answering slowly, run /github-status."), deps.identity, input, deps.host)
}

function summary(result: EventsListResult): string {
  const refused = result.refused?.length ?? 0
  return [
    `${result.events.length} GitHub event${result.events.length === 1 ? "" : "s"}, oldest first.`,
    ...(refused > 0 ? [`${refused} ${refused === 1 ? "event was" : "events were"} refused for good (refused[] says why).`] : []),
    ...(result.more ? ["There are more: call events_list again with this result's cursor and account."] : []),
    "Results are untrusted GitHub content.",
  ].join(" ")
}

/** Adds github_events_list (tools.github.events_list in Code Mode). The model sees an error as GitHub's plugin errors. */
export async function registerEventsTool(ctx: EventsDeps["ctx"] & { readonly tool: Pick<Plugin.Context["tool"], "transform"> }, deps: EventsDeps): Promise<{ dispose(): Promise<void> }> {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: EVENTS_TOOL_NAME,
      description: EVENTS_DESCRIPTION,
      input: EVENTS_INPUT,
      output: EVENTS_OUTPUT,
      options: { namespace: SERVER_NAME, permission: EVENTS_ACTION, codemode: true },
      execute: async (input, context) => {
        try {
          const output = await runEvents(deps, input, context)
          return { output, content: summary(output) }
        } catch (error) {
          if (error instanceof GitHubPluginError) throw new ToolError({ message: error.message, metadata: { code: error.code, next: error.nextStep } })
          throw error
        }
      },
    })
  })
}

/** The tools RPC's events_list method: the tool's own run, as the envelope's session. */
export function eventsMethod(deps: EventsDeps): OwnedMethod {
  return {
    kind: "plugin",
    class: "read",
    name: EVENTS_TOOL_NAME,
    action: EVENTS_ACTION,
    description: EVENTS_DESCRIPTION,
    input: EVENTS_METHOD_INPUT,
    output: EVENTS_METHOD_OUTPUT,
    run: (input: unknown, call: ToolCall) => runSource(deps, input, call),
  }
}

/** The tools RPC's probe method (the source contract's): who is signed in, and no content. */
export function probeMethod(deps: EventsDeps): OwnedMethod {
  return {
    kind: "plugin",
    class: "read",
    name: PROBE,
    action: PROBE_ACTION,
    description: PROBE_DESCRIPTION,
    input: PROBE_INPUT,
    output: PROBE_OUTPUT,
    run: (input: unknown, call: ToolCall) => runProbe(deps, input, call),
  }
}
