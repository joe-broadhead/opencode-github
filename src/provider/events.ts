// The activity source: the issues and pull requests the signed-in user is involved in, the commits they authored, and
// the notifications they may read, as one merged feed with a cursor.
//
// GitHub has no single feed for these. The source reads three searches (issues, pull requests, commits) and the
// notifications inbox, merges them by time and lists one page oldest first. The cursor carries each stream's position,
// the read's cut, a gap it answered and the notifications' lookback, so a page never repeats an item and a late
// notification is listed once.
import { createHash } from "node:crypto"
import { decodeBoundCursor, encodeBoundCursor, type CursorBinding } from "@we-the-rebel-alliance/plugin-contract/cursor"
import {
  eventsListResult,
  fitPage,
  makeEvent,
  probeResult,
  screenEvents,
  startTime,
  SourceError,
  type EventsListRequest,
  type EventsListResult,
  type EventsOwner,
  type ProbeResult,
  type SourceEvent,
} from "@we-the-rebel-alliance/plugin-contract/events"
import type { ApiOutput } from "./api.ts"

export const SOURCE = "github"
/** The page's plugin name, as a consumer sees it. The handler also states it in the page. */
export const PACKAGE = "@we-the-rebel-alliance/github-plugin"

/** The plugin id a cursor is bound to. */
const PLUGIN = "github"

/** The most bytes one page's events hold; the cursor and the page's own fields take the rest of the source's 900,000. */
export const PAGE_BYTES = 860_000

const LOGIN = /^[A-Za-z0-9-]{1,39}$/

/**
 * How old an item must be before a page lists it: GitHub's search index reaches a result within minutes, and listing a
 * second twice is worse than listing it on the next page.
 */
export const SETTLE_MS = 5 * 60_000

/** The notifications page GitHub serves. */
const PER_PAGE = 50
/** The most search results one search page reads. */
export const SEARCH_PER_PAGE = 100
/** The size a search page falls back to when its answer is over the read's byte limit. */
export const SEARCH_SMALL_PAGE = 10

/** The most bytes a source read takes from one GitHub answer whole. */
export const EVENTS_MAX_BYTES = 32 * 1024 * 1024

/** The most pages one search reads from its position in one call. */
const SEARCH_PAGES = 6
/** GitHub answers at most this many results for one search query, whatever its total_count says. */
export const SEARCH_CAP = 1000
/** The most search requests one call makes, across its three searches: GitHub allows 30 a minute for a signed-in user. */
export const SEARCH_BUDGET = 30
/** The most notifications one call reads (10 pages of 50); a backlog over it is walked oldest first across calls. */
export const NOTIFICATION_CAP = 500
/** The largest backlog it counts; past it, or where GitHub will not page that far, the read answers a gap. */
export const NOTIFICATION_COUNT_MAX = 64_000
const DAY_MS = 24 * 60 * 60_000
/** GitHub keeps an inbox notification that is not saved for three months, taken as the shortest (89 days). */
export const NOTIFICATION_RETENTION_MS = 89 * DAY_MS
/** How far behind its position each read looks again for notifications GitHub delivered late. */
export const NOTIFICATION_LOOKBACK_MS = 6 * 60 * 60_000
/** The most notifications the cursor remembers as listed inside the lookback. */
export const LOOKBACK_REMEMBERED = 16
/** A position after every item of its second: ids are digits, `owner/repo#n` or `owner/repo@sha`, all below it. */
const AFTER_SECOND = "\uffff"
/** Notifications about these are the issue and pull request stream's. */
const COVERED = new Set(["Issue", "PullRequest"])

type Data = Record<string, unknown>
/** Issues, pull requests, commits and notifications: GitHub searches issues and pull requests separately. */
type StreamName = "i" | "p" | "c" | "n"
const STREAMS: readonly StreamName[] = ["i", "p", "c", "n"]
/** The external id a page's `failed[]` uses when a whole stream could not be read. */
const STREAM_IDS: Readonly<Record<StreamName, string>> = {
  i: "github:issues",
  p: "github:pull_requests",
  c: "github:commits",
  n: "github:notifications",
}

/** A GET through the api client: `maxBytes` is how much of the answer to read whole. */
export type Get = (path: string, query: Record<string, string | number | boolean>, maxBytes?: number) => Promise<ApiOutput>

/**
 * A place in a stream: a time, and inside its second an order key `i` ("" before every item of the second, AFTER_SECOND
 * after all of them). An item's order key is ORDER_KEY_LENGTH characters of a hash of its id for the searches, and the
 * notification's id for notifications.
 */
interface Key {
  readonly t: number
  readonly i: string
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

const fail: (code: string, what: string, next: string) => never = (code, what, next) => {
  throw new SourceError({ code, what, next })
}

/** The owner a page and a probe name: `github:` and the login, labelled with the login. The same everywhere. */
export const ownerOf = (login: string, host?: string): EventsOwner =>
  host === undefined ? { id: `github:${login}`, label: login } : { id: `github:${login}@${host.toLowerCase()}`, label: `${login} (${host.toLowerCase()})` }

const loginOf = (login: string): string => login.toLowerCase()

/** A sign-in GitHub refuses, as the contract's sign-in failure. */
const signIn = (service: string): never => fail("NEEDS_SIGN_IN", "GitHub rejected the saved sign-in", `Run /connect and choose ${service} to sign in again.`)

/** A 401 on a required read rejects the token. Notifications can also answer 401 for lack of scope. */
const requiresSignIn = (get: Get, service: string): Get =>
  async (...args) => {
    const output = await get(...args)
    if (output.status === 401) signIn(service)
    return output
  }

/** The login in GET /user's answer, or a login itself. */
export function loginOfAnswer(value: unknown): string | undefined {
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
  return login && LOGIN.test(login) ? login : undefined
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
 * `maxBytes` is how much of the answer to read whole. A cut answer is reported, not failed.
 */
async function list(get: Get, path: string, query: Record<string, string | number | boolean>, pick: (data: unknown) => unknown, allowed: readonly number[] = [], maxBytes?: number): Promise<Answer | undefined> {
  const output = await get(path, query, maxBytes)
  if (allowed.includes(output.status)) return undefined
  if (!output.ok) fail("UNAVAILABLE", `GitHub answered ${path} with ${output.status}`, output.nextStep ?? "Call events_list again with the same cursor; if it keeps failing, read the plugin's status.")
  const items = pick(output.data)
  if (!Array.isArray(items) && !output.truncated) fail("UNAVAILABLE", `GitHub answered ${path} without a list`, "Call events_list again with the same cursor; if it keeps failing, read the plugin's status.")
  const data = record(output.data) ? output.data : {}
  const total = typeof data["total_count"] === "number" ? data["total_count"] : undefined
  const incomplete = data["incomplete_results"] === true
  return { items: Array.isArray(items) ? items : [], ...(total === undefined ? {} : { total }), incomplete, truncated: output.truncated }
}

/** A search answer over EVENTS_MAX_BYTES: never a part of a list; its range is read again in smaller pages. */
const OVER = "over"

/** One search page of `size` results, read whole. */
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
 * itself.
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
 * `need` items, ends, or has made SEARCH_PAGES requests.
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
      if (items.some((item) => item.t < at)) return { items: items.sort(compare), complete: false, last: at, start: from, ...lost() }
      if (items.length > 0) return { ...hold, stuck: at, ...lost() }
      return pastLarge(get, spec, from, at, cut, budget)
    }
    // GitHub's search timed out and may have left results out: list nothing past the position, and read it again on the
    // next call, rather than move past what it left out.
    if (answer.incomplete) return hold
    read = true
    let newest = at
    for (const raw of answer.items) {
      const item = spec.make(raw)
      if (!item) continue
      if (item.t <= end) newest = Math.max(at, item.t)
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
      // A page in one second cannot be paged past by time: that second is read whole, by itself.
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
      last = Math.max(last, second + 1000)
      at = second + 1000
      if (at > cut) return { items: items.sort(compare), complete: true, last, start: from, ...lost() }
    }
    if (items.length > need && items.some((item) => item.t < last)) break
  }
  if (!read) return hold
  if (items.every((item) => item.t === last)) return { ...hold, stuck: last, ...lost() }
  return { items: items.sort(compare), complete: false, last, start: from, ...lost() }
}

/**
 * Where a search goes on when the next few results from `at` are too large to read together, with pages of one result
 * (the first result of a range is its earliest).
 */
async function pastLarge(get: Get, spec: Search, from: Key, at: number, cut: number, budget: Budget): Promise<SearchRead> {
  const hold: SearchRead = { items: [], complete: false, last: from.t, start: from }
  /** Past every second from `at` before `second`, which hold no result this read lists. */
  const past = (second: number): Key => (second > at ? { t: second - 1000, i: AFTER_SECOND } : from)
  const stuck = (second: number): SearchRead => ({ items: [], complete: false, last: second, start: past(second), stuck: second })
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
  const before = await result(second - 1000, 0)
  if (before === undefined) return hold
  if (before === null) return stuck(second)
  if (before !== OVER) return stuck(secondOf(before.t))
  return { items: [], complete: false, last: second, start: past(second), skipped: at }
}

/**
 * A walk through one second in GitHub's own order, for a second a call cannot read whole: its items are listed as they
 * are read, keyed by their place (`walkKey`), and the stream's position carries the walk, so the next call goes on
 * from it, in the same size of page, rather than reading the second again.
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
 * key, a hash of each id), so the position walks its items across calls whatever order GitHub gives them in.
 */
async function searchSecond(get: Get, spec: Search, from: Key, second: number, budget: Budget, first = false): Promise<SearchRead> {
  const hold: SearchRead = { items: [], complete: false, last: second + 1000, start: from, held: true }
  const past: Key = { t: second, i: AFTER_SECOND }
  const at = isoSeconds(second)
  const after = from.t === second && from.walk !== undefined ? walkOffset(from.i) : undefined
  const walking = after !== undefined
  const begin = walking ? after + 1 : 0
  const mayWalk = walking || (first && compare(from, { t: second, i: "" }) <= 0)
  let entries: { offset: number; item: Item }[] = []
  let ids = new Set<string>()
  let size = walking ? from.walk!.size : SEARCH_PER_PAGE
  let page = Math.floor(begin / size) + 1
  let read = (page - 1) * size
  let total: number | undefined = walking ? from.walk!.total : undefined
  let oversized = false
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
      if (size > 1) {
        const smaller = size / SEARCH_SMALL_PAGE
        page = Math.floor(Math.max(begin, (page - 1) * size) / smaller) + 1
        size = smaller
        read = (page - 1) * size
        continue
      }
      oversized = true
      if (!entries.some((entry) => entry.offset >= begin && entry.offset < read)) skippedTo = read
      read += 1
    } else {
      if (answer.incomplete) return { ...hold, held: false }
      if (answer.total !== undefined && answer.total > SEARCH_CAP) return { items: [], complete: false, last: second, start: past, skipped: second }
      if (total !== undefined && answer.total !== undefined && answer.total !== total) {
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
    const ended = (answer !== OVER && answer.items.length === 0) || (total !== undefined ? read >= total : answer !== OVER && answer.items.length < size)
    if (!ended) {
      page++
      while (size < SEARCH_PER_PAGE && (page - 1) % SEARCH_SMALL_PAGE === 0) {
        page = (page - 1) / SEARCH_SMALL_PAGE + 1
        size = size * SEARCH_SMALL_PAGE
      }
      continue
    }
    if (walking) return walked(true)
    const lost = oversized ? { oversized: second } : {}
    const items = entries.map((entry) => entry.item)
    if (items.length === 0) return { items: [], complete: false, last: second + 1000, start: past, ...lost }
    return { items: items.sort(compare), complete: false, last: second + 1000, start: from, ends: true, ...lost }
  }
}

/**
 * The notifications' state a cursor carries: the position, the lookback's start (`floor`), and a hash of each
 * notification listed at or after it (`seen`, with its time), so one GitHub delivers late is listed once.
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
  /** More notifications than one call reads came after the position. */
  readonly truncated: boolean
}

/** Notifications under the read's cut, oldest first. */
async function notifications(get: Get, state: Notified, account: string, cut: number): Promise<NotificationsRead> {
  const { position } = state
  const base = startOf(position)
  const before = isoSeconds(Math.floor(cut / 1000) * 1000 + 1000)
  const ask: Ask = async (since, page, perPage) => {
    const read = await list(get, "/notifications", { all: true, participating: true, since: isoSeconds(since), before, per_page: perPage, page }, (data) => data, [401, 403, 404, 422], EVENTS_MAX_BYTES)
    if (read?.truncated === true) fail("TOO_LARGE", `GitHub's answer to /notifications is over ${EVENTS_MAX_BYTES / (1024 * 1024)} MB, the most events_list reads whole`, "Nothing in events_list changes it: the answer is over the bytes events_list reads whole.")
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
  const times = raws.flatMap((raw) => (record(raw) ? (time(raw["updated_at"]) ?? []) : []))
  const last = times.length > 0 ? Math.max(...times) : Number.NaN
  const items = pick(raws, next, account)
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

/** The newest NOTIFICATION_CAP notifications, when the backlog cannot be walked. */
async function truncatedRead(ask: Ask, state: Notified, since: number, account: string): Promise<NotificationsRead> {
  const raws: unknown[] = []
  for (let page = 1; page <= NOTIFICATION_CAP / PER_PAGE; page++) {
    const read = await ask(since, page, PER_PAGE)
    if (read === undefined) break
    raws.push(...read.items)
    if (read.items.length < PER_PAGE) break
  }
  const times = raws.flatMap((raw) => (record(raw) ? (time(raw["updated_at"]) ?? []) : []))
  if (times.length === 0) return { items: [], complete: false, last: state.position.t, readable: true, state, truncated: false }
  const oldest = Math.min(...times)
  const next: Notified = { position: { t: oldest, i: AFTER_SECOND }, floor: oldest + 1000, seen: new Map() }
  return { items: pick(raws, next, account), complete: true, last: Number.POSITIVE_INFINITY, readable: true, state: next, truncated: true }
}

/** A cursor's owner hash: a cursor of another sign-in is refused. */
const digest = (owner: EventsOwner) => createHash("sha256").update(owner.id).digest("hex").slice(0, 16)
const bindingOf = (alias: string): CursorBinding => ({ plugin: PLUGIN, source: SOURCE, account: alias })

const START_AGAIN = "Call events_list without a cursor, with since, to start again."
const refuseCursor = (): never => fail("CURSOR_INVALID", "The cursor was not issued by this plugin's events_list for this account and its signed-in user", START_AGAIN)

/** What a cursor holds: each stream's position, the notifications' lookback, and when the read answered its gap. */
interface CursorState {
  readonly from: Record<StreamName, Key>
  readonly notified: Notified
  readonly gapAt?: number
  readonly cut?: number
  readonly lostAt?: number
  readonly held?: { readonly stream: "i" | "p" | "c"; readonly second: number }
}

const SEEN = /^([0-9a-f]{8})([0-9a-z]{1,11})$/

/** The cursor's format, `k` in it. */
const CURSOR_FORMAT = 1
/** The most characters a cursor of format 1 has, well under the contract's MAX_CURSOR_LENGTH (1024). */
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
 * The cursor's state: anything but format 1, a cursor bound to another plugin, source or account, or holding another
 * sign-in's owner, is CURSOR_INVALID: start again with since.
 */
function stateOf(cursor: string, alias: string, login: string, owner: EventsOwner): CursorState {
  const decoded = decodeBoundCursor(bindingOf(alias), cursor)
  if (!decoded.ok) return refuseCursor()
  const state = decoded.state
  if (state["o"] !== digest(owner)) return refuseCursor()
  if (state["a"] !== loginOf(login)) return refuseCursor()
  return state["k"] === CURSOR_FORMAT ? current(state) : refuseCursor()
}

/** The read's state the cursor carries, after its positions: the gap, the cut, the loss and the lookback. */
function withLookback(from: Record<StreamName, Key>, times: readonly (number | undefined)[], behind: number | undefined, hashes: unknown): CursorState {
  const [gapAt, cut, lostAt] = times
  const read = {
    ...(gapAt === undefined ? {} : { gapAt }),
    ...(cut === undefined ? {} : { cut }),
    ...(lostAt === undefined ? {} : { lostAt }),
  }
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
    // Only a search position walks a second.
    if (index >= 3) return undefined
    const total = typeof entry[2] === "string" && /^[0-9a-z]{1,3}$/.test(entry[2]) ? Number.parseInt(entry[2], 36) : undefined
    const size = typeof entry[3] === "string" ? Number.parseInt(entry[3], 36) : undefined
    const walks = entry.length === 4 && walkOffset(i) !== undefined && total !== undefined && total <= SEARCH_CAP && (size === 1 || size === SEARCH_SMALL_PAGE || size === SEARCH_PER_PAGE)
    return walks ? { t, i, walk: { total, size: size! } } : undefined
  })
  if (keys.length !== STREAMS.length || keys.some((key) => key === undefined)) return refuseCursor()
  const from = { i: keys[0]!, p: keys[1]!, c: keys[2]!, n: keys[3]! }
  const times = ["g", "u", "q"].map((name) => (state[name] === undefined ? undefined : (timeOf(state[name]) ?? refuseCursor())))
  if (!(Array.isArray(state["l"]) && state["l"].length === 2)) return refuseCursor()
  const lookback = state["l"] as unknown[]
  const behind = typeof lookback[0] === "string" && /^-?[0-9a-z]{1,11}$/.test(lookback[0]) ? Number.parseInt(lookback[0], 36) : undefined
  const heldState = state["h"]
  let held: CursorState["held"]
  if (Array.isArray(heldState) && heldState.length === 2) {
    const index = heldState[0]
    const second = timeOf(heldState[1])
    const stream = typeof index === "number" && index >= 0 && index <= 2 ? (["i", "p", "c"] as const)[index] : undefined
    if (stream !== undefined && second !== undefined) held = { stream, second }
  }
  return { ...withLookback(from, times, behind, lookback[1]), ...(held === undefined ? {} : { held }) }
}

/**
 * The lookback a cursor carries: from NOTIFICATION_LOOKBACK_MS behind the position (never before the floor it had), with
 * the hashes of the notifications listed since.
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
  alias: string,
  login: string,
  owner: EventsOwner,
  positions: Record<StreamName, Key>,
  floor: number,
  seen: Map<string, number>,
  read: { gapAt: number | undefined; cut: number | undefined; lostAt: number | undefined; held?: CursorState["held"] },
): string {
  const p = STREAMS.map((stream) => {
    const { t, i, walk } = positions[stream]
    return walk !== undefined ? [timeText(t), i, walk.total.toString(36), walk.size.toString(36)] : [timeText(t), i]
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
    const cursor = encodeBoundCursor(bindingOf(alias), { k: CURSOR_FORMAT, a: loginOf(login), o: digest(owner), p, l, ...times, ...held })
    if (cursor.length <= CURSOR_MAX || entries.length === 0) return cursor
    start = Math.max(start, entries[entries.length - 1]![1] + 1000)
    entries = entries.filter(([, at]) => at >= start)
  }
}

/** What one page read needs: the alias, the signed-in login, the host, the parsed request and the clock. */
export interface PageRequest {
  readonly alias: string
  readonly login: string
  readonly host?: string | undefined
  readonly request: EventsListRequest
  readonly now: number
  readonly service: string
}

/**
 * One page of events. `get` reads GitHub as the caller, `login` is the sign-in's GitHub login, and `now` fixes the clock.
 * The page's account is the alias; the cursor is bound to the alias and carries the login it was issued for.
 */
export async function listEvents(get: Get, input: PageRequest): Promise<EventsListResult> {
  const { alias, login, host, request, now, service } = input
  const owner = ownerOf(login, host)
  const start: Key = { t: startTime(request, now), i: "" }
  const state: CursorState =
    request.cursor !== undefined ? stateOf(request.cursor, alias, login, owner) : { from: { i: start, p: start, c: start, n: start }, notified: { position: start, floor: start.t + 1000, seen: new Map() } }
  const from = state.from
  // The read's cut, pinned on its first page: an event is listed once it is SETTLE_MS old, and nothing newer than the cut
  // is listed on any page of the read; the next read lists it.
  const end = state.cut ?? Math.floor(now - SETTLE_MS)
  const failed: { external_id: string; code: string; retryAfterSec?: number }[] = []
  const failStream = (stream: StreamName, error: unknown): void => {
    const code = error instanceof SourceError ? error.code : "UNAVAILABLE"
    if (code === "NEEDS_SIGN_IN") throw error
    failed.push({
      external_id: STREAM_IDS[stream],
      code,
      ...(error instanceof SourceError && error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
    })
  }
  const failedRead = (start: Key): SearchRead => ({ items: [], complete: false, last: Number.POSITIVE_INFINITY, start })

  // GitHub refuses a search for issues and pull requests together from a GitHub App user token (HTTP 422): one each.
  const searches: Record<"i" | "p" | "c", Search> = {
    // An item belongs to the stream that read it, so that stream's position moves past it.
    i: { path: "/search/issues", sort: "updated", query: (range) => `is:issue involves:${login} updated:${range}`, make: (raw) => streamOf(issueItem(raw, alias), "i") },
    p: { path: "/search/issues", sort: "updated", query: (range) => `is:pull-request involves:${login} updated:${range}`, make: (raw) => streamOf(issueItem(raw, alias), "p") },
    c: { path: "/search/commits", sort: "committer-date", query: (range) => `author:${login} committer-date:${range}`, make: (raw) => commitItem(raw, alias) },
  }
  const searchGet = requiresSignIn(get, service)
  const budget: Budget = { left: SEARCH_BUDGET }
  const searched: Record<"i" | "p" | "c", SearchRead> = {
    i: { items: [], complete: true, last: Number.POSITIVE_INFINITY, start: from.i },
    p: { items: [], complete: true, last: Number.POSITIVE_INFINITY, start: from.p },
    c: { items: [], complete: true, last: Number.POSITIVE_INFINITY, start: from.c },
  }
  // A second a call could not read whole for want of requests is read first: a held second (`h` in the cursor), or one
  // its stream walks across calls.
  const searchStreams = ["i", "p", "c"] as const
  const heldSecond = (stream: "i" | "p" | "c") =>
    from[stream].walk !== undefined ? from[stream].t : state.held?.stream === stream && state.held.second >= from[stream].t ? state.held.second : undefined
  const firsts = searchStreams.filter((stream) => heldSecond(stream) !== undefined).sort((a, b) => heldSecond(a)! - heldSecond(b)!)
  const others = searchStreams.filter((stream) => !firsts.includes(stream) && startOf(from[stream]) <= end)
  for (const stream of firsts) {
    const allowance: Budget = { left: Math.max(0, budget.left - others.length) }
    const allowed = allowance.left
    try {
      searched[stream] = await searchSecond(searchGet, searches[stream], from[stream], heldSecond(stream)!, allowance, true)
    } catch (error) {
      failStream(stream, error)
      searched[stream] = failedRead(from[stream])
    }
    budget.left -= allowed - allowance.left
  }
  // Each search leaves one request for every search after it, so none is left without a page to read.
  for (const [index, stream] of others.entries()) {
    const allowance: Budget = { left: Math.max(0, budget.left - (others.length - 1 - index)) }
    const allowed = allowance.left
    try {
      searched[stream] = await search(searchGet, searches[stream], from[stream], request.limit, allowance, end)
    } catch (error) {
      failStream(stream, error)
      searched[stream] = failedRead(from[stream])
    }
    budget.left -= allowed - allowance.left
  }
  // A stream whose read found only one second reads that second whole, with what is left of the budget.
  const stuck = (["i", "p", "c"] as const).flatMap((stream) => (searched[stream].stuck === undefined ? [] : [{ stream, second: searched[stream].stuck! }]))
  for (const { stream, second } of stuck.sort((a, b) => a.second - b.second || (a.stream < b.stream ? -1 : 1))) {
    try {
      searched[stream] = await searchSecond(searchGet, searches[stream], searched[stream].start, second, budget)
    } catch (error) {
      failStream(stream, error)
    }
  }

  // GitHub keeps notifications for three months: a stream that starts before that may have lost some, so it restarts at
  // the window's start, and the read answers the gap.
  const floor = end + SETTLE_MS - NOTIFICATION_RETENTION_MS
  const outside = state.notified.position.t < floor
  const restarted: Key = { t: floor, i: "" }
  const notifiedFrom: Notified = outside ? { position: restarted, floor: restarted.t + 1000, seen: new Map() } : state.notified
  let notified: NotificationsRead
  try {
    notified =
      startOf(notifiedFrom.position) > end
        ? { items: [], complete: true, last: Number.POSITIVE_INFINITY, readable: false, state: state.notified, truncated: false }
        : await notifications(get, notifiedFrom, alias, end)
  } catch (error) {
    failStream("n", error)
    notified = { items: [], complete: false, last: Number.POSITIVE_INFINITY, readable: false, state: state.notified, truncated: false }
  }
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
      positions[item.s] = { t: item.t, i: item.i, ...(walk !== undefined && walkOffset(item.i) !== undefined ? { walk } : {}) }
    }
    if (item.s === "n") {
      seen.set(seenKey(item), item.t)
      notificationsListed++
    }
    consumed++
  }
  // Every notification GitHub has up to the settle time is listed: the stream's position moves there.
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
  // The earliest second held for want of requests, or read whole and listed in part, which the next call reads first.
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
  // GitHub answers, or a search result alone over what events_list reads whole.
  const passed = notified.readable && !outside && state.notified.position.t < now - NOTIFICATION_RETENTION_MS
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
  const gap =
    owed.length > 0 && !answered
      ? { reason: state.lostAt !== undefined || (outside && request.cursor !== undefined) ? ("expired" as const) : ("window-truncated" as const), since: new Date(Math.min(...owed)).toISOString() }
      : undefined
  const lostAt = answered && owed.length > 0 ? Math.min(...owed) : undefined
  const refused = merged.slice(0, consumed).flatMap((item) => refusedIds.get(item.event.external_id) ?? [])
  const more = merged.length > consumed || STREAMS.some((stream) => !reads[stream].complete)
  const gapAt = more ? (gap !== undefined ? now : answered ? state.gapAt : undefined) : undefined
  const cursor = encodeState(alias, login, owner, positions, lookback, remembered.seen, { gapAt, cut: more ? end : undefined, lostAt, held: more ? held : undefined })
  return eventsListResult({ source: SOURCE, account: alias, owner }, listed.map((item) => item.event), cursor, more, {
    ...(refused.length === 0 ? {} : { refused }),
    ...(failed.length === 0 ? {} : { failed }),
    ...(gap === undefined ? {} : { gap }),
    plugin: PACKAGE,
    asOf: new Date(now).toISOString(),
  })
}

/** One probe read: the alias, the signed-in login, the host and the name /connect shows. */
export interface ProbeRequest {
  readonly alias: string
  readonly login: string
  readonly host?: string | undefined
  readonly service: string
}

/**
 * `probe` (contract §11): who is signed in, for the source, and nothing it reads. One GET /user confirms the token still
 * belongs to that login.
 */
export async function probeEvents(get: Get, input: ProbeRequest): Promise<ProbeResult> {
  const { alias, login, host, service } = input
  const owner = ownerOf(login, host)
  const output = await get("/user", {})
  if (output.status === 401) signIn(service)
  if (!output.ok) fail("UNAVAILABLE", `GitHub answered /user with ${output.status}`, output.nextStep ?? "Read the plugin's status, then call probe again.")
  const confirmed = loginOfAnswer(output.data)
  if (confirmed === undefined) fail("UNAVAILABLE", "GitHub's answer to /user named no login", "Read the plugin's status, then call probe again.")
  if (loginOf(confirmed!) !== loginOf(login)) fail("UNAVAILABLE", "The GitHub token belongs to another login than the sign-in recorded", "Run /connect and choose the account again, then call probe again.")
  return probeResult({ source: SOURCE, account: alias, owner })
}
