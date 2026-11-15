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
// Three streams, each with its own position in the one cursor:
// - issues and pull requests the person is involved in (`involves:`), from /search/issues sorted by update, oldest
//   first: one event each time one changes;
// - commits the person authored, from /search/commits sorted by committer date, oldest first;
// - notifications, where the sign-in may read them (/notifications; a 401, 403 or 404 leaves them out), except those
//   about an issue or a pull request, which the first stream already lists.
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
  PAGE,
  PROBE,
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
  startTime,
} from "@we-the-rebel-alliance/source-contract/events"
import type { OwnedMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import type { ApiInput, ApiOutput } from "./api/contract.js"
import type { ApiScope, Call } from "./api/tool.js"
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
/** The only request probe sends, asserted as PROBE_ACTION on its resource: who the token belongs to. */
export const PROBE_READS = ["GET /user"] as const
const PROBE_SCOPE: ApiScope = { action: PROBE_ACTION, resources: PROBE_READS }
/** The most bytes of JSON one page holds: the source's declared `maxBytes`. */
export const PAGE_BYTES = 900_000
/** A GitHub login: letters, digits and hyphens, at most 39. */
const LOGIN = /^[A-Za-z0-9-]{1,39}$/

/** GitHub's search index lags a little behind a change; an event is listed once it is this old. */
export const SETTLE_MS = 5 * 60_000
/** Results per search or notifications page. */
const PER_PAGE = 50
/** GitHub's search returns at most 1000 results: 20 pages of 50. */
const SEARCH_PAGES = 20
const NOTIFICATION_PAGES = 10
/** Notifications about these are the issue and pull request stream's. */
const COVERED = new Set(["Issue", "PullRequest"])

type Data = Record<string, unknown>
type StreamName = "i" | "c" | "n"
const STREAMS: readonly StreamName[] = ["i", "c", "n"]

/** A GET through github_api's spec, as the caller. */
export type Get = (path: string, query: Record<string, string | number | boolean>) => Promise<ApiOutput>
/** The signed-in login, as the sign-in recorded it (GitHub's GET /user at sign-in); undefined when nobody is signed in. */
export type Identity = () => Promise<string | undefined>

interface Key {
  readonly t: number
  readonly i: string
}

interface Item extends Key {
  readonly s: StreamName
  readonly event: SourceEvent
}

/** One stream's read: its items after its position, oldest first; whether it ended; the last time it read. */
interface Read {
  readonly items: Item[]
  readonly complete: boolean
  readonly last: number
}

const record = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined)
const compare = (a: Key, b: Key) => a.t - b.t || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0)
const time = (value: unknown) => {
  const at = text(value)
  const parsed = at === undefined ? Number.NaN : Date.parse(at)
  return Number.isFinite(parsed) ? parsed : undefined
}
/** GitHub's search qualifiers take whole seconds. */
const isoSeconds = (at: number) => `${new Date(Math.floor(at / 1000) * 1000).toISOString().slice(0, 19)}Z`

type EventsCode = "INPUT_INVALID" | "SOURCE_UNKNOWN" | "CURSOR_INVALID" | "ACCOUNT_MISMATCH" | "AUTH_REQUIRED" | "UNAVAILABLE"
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

/** An issue or a pull request from /search/issues, as the event of its last change. */
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
    kind: pr ? "pr" : "issue",
    occurred_at: at,
    thread: `github:${id}`,
    actors: [...actor("author", raw["user"]), ...assignees.flatMap((user) => actor("assignee", user))],
    title: `${id}: ${text(raw["title"]) ?? ""}`,
    text: typeof raw["body"] === "string" ? raw["body"] : "",
    url: text(raw["html_url"])!,
    labels: [merged ? "merged" : (text(raw["state"]) ?? "open"), ...labels],
  })
  return { s: "i", t: at, i: id, event }
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
    i: `${repo}@${sha}`,
    event: makeEvent({
      source: SOURCE,
      account,
      external_id: `${repo}@${sha}`,
      kind: "commit",
      occurred_at: at,
      thread: `github:${repo}`,
      actors: actors.length > 0 ? actors : email && /^[^\s@]+@[^\s@]+$/.test(email) ? [{ role: "author", id: `mailto:${email}`, ...(text(author["name"]) ? { name: text(author["name"])! } : {}) }] : [],
      title: `${repo}: ${message.split(/\r?\n/, 1)[0] ?? ""}`,
      text: message,
      url: text(raw["html_url"])!,
      labels: [],
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
    i: id,
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

/** A GET's list, or UNAVAILABLE; `allowed` lists the statuses that mean "not for this sign-in", read as none. */
async function list(get: Get, path: string, query: Record<string, string | number | boolean>, pick: (data: unknown) => unknown, allowed: readonly number[] = []): Promise<{ items: unknown[]; total?: number; incomplete: boolean } | undefined> {
  const output = await get(path, query)
  if (allowed.includes(output.status)) return undefined
  if (!output.ok) fail("UNAVAILABLE", `GitHub answered ${path} with ${output.status}.`, output.nextStep ?? "Call events_list again with the same cursor; if it keeps failing, run /github-status.")
  if (output.truncated) fail("UNAVAILABLE", `GitHub's answer to ${path} was too large to read whole.`, "Call events_list again with the same cursor and a smaller limit.")
  const items = pick(output.data)
  if (!Array.isArray(items)) fail("UNAVAILABLE", `GitHub answered ${path} without a list.`, "Call events_list again with the same cursor; if it keeps failing, run /github-status.")
  const total = record(output.data) && typeof output.data["total_count"] === "number" ? output.data["total_count"] : undefined
  const incomplete = record(output.data) && output.data["incomplete_results"] === true
  return { items: items as unknown[], ...(total === undefined ? {} : { total }), incomplete }
}

/** One search stream, oldest first: pages until it holds more than `need` items after `from`, or ends. */
async function search(get: Get, path: string, q: string, sort: string, from: Key, need: number, make: (raw: unknown) => Item | undefined): Promise<Read> {
  const items: Item[] = []
  let last = from.t
  let fetched = 0
  for (let page = 1; page <= SEARCH_PAGES; page++) {
    const read = (await list(get, path, { q, sort, order: "asc", per_page: PER_PAGE, page }, (data) => (record(data) ? data["items"] : undefined)))!
    fetched += read.items.length
    for (const raw of read.items) {
      const item = make(raw)
      if (!item) continue
      last = Math.max(last, item.t)
      if (compare(item, from) > 0) items.push(item)
    }
    // total_count says where the results end; without it, a short page does.
    const ended = read.items.length === 0 || (read.total !== undefined ? fetched >= read.total : read.items.length < PER_PAGE)
    if (ended && !read.incomplete) return { items: items.sort(compare), complete: true, last }
    // A page boundary can split a time: read on while every item shares one, so the next call can move past it.
    if (items.length > need && items.some((item) => item.t < last)) break
  }
  return { items: items.sort(compare), complete: false, last }
}

/** Notifications since `from`, all pages, oldest first; undefined when the sign-in may not read them. */
async function notifications(get: Get, from: Key, account: string): Promise<Read> {
  const items: Item[] = []
  for (let page = 1; page <= NOTIFICATION_PAGES; page++) {
    const read = await list(get, "/notifications", { all: true, participating: true, since: isoSeconds(from.t), per_page: PER_PAGE, page }, (data) => data, [401, 403, 404])
    if (!read) return { items: [], complete: true, last: from.t }
    for (const raw of read.items) {
      const item = notificationItem(raw, account)
      if (item && compare(item, from) > 0) items.push(item)
    }
    if (read.items.length < PER_PAGE) return { items: items.sort(compare), complete: true, last: Number.POSITIVE_INFINITY }
  }
  // Newest first, so what was not read is older than everything read: list none of them until it fits.
  return { items: [], complete: false, last: from.t }
}

/** The owner a page and a probe name: `github:` and the login, labelled with the login. The same everywhere. */
const ownerOf = (login: string): EventsOwner => ({ id: `github:${login}`, label: login })
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

/**
 * The cursor's position in each stream. A cursor bound to another plugin, source or account, holding another sign-in's
 * owner, or of another version (one issued before the source contract) is CURSOR_INVALID: start again with since.
 */
function positionsOf(cursor: string, account: string, owner: EventsOwner): Record<StreamName, Key> {
  const decoded = decodeBoundCursor(bindingOf(account), cursor)
  if (!decoded.ok) return refuseCursor()
  const state = decoded.state
  const named = state["a"] === account
  const positions = record(state["p"]) ? state["p"] : undefined
  const keys = STREAMS.map((stream) => {
    const pair = positions?.[stream]
    return Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "number" && Number.isSafeInteger(pair[0]) && typeof pair[1] === "string" ? { t: pair[0], i: pair[1] } : undefined
  })
  if (!named || state["o"] !== digest(owner) || keys.some((key) => key === undefined)) return refuseCursor()
  return { i: keys[0]!, c: keys[1]!, n: keys[2]! }
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
export async function listEvents(get: Get, identity: Identity, input: unknown, now: number): Promise<EventsListResult> {
  const parsed = parseEventsListInput(input)
  if (!parsed.ok) return fail("INPUT_INVALID", `The events_list input is invalid: ${parsed.problems.join("; ")}.`, "Pass only since, cursor, limit (1 to 500), account and source, as the tool's schema describes.")
  const request = parsed.value
  if (request.source !== undefined && request.source !== SOURCE) fail("SOURCE_UNKNOWN", `This plugin has no source "${request.source}"; its one source is "${SOURCE}".`, `Leave source out, or pass "${SOURCE}".`)
  const asked = request.account === undefined ? undefined : request.account.toLowerCase()
  if (request.cursor !== undefined) {
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
  const owner = ownerOf(login)
  const start: Key = { t: startTime(request, now), i: "" }
  const from = request.cursor !== undefined ? positionsOf(request.cursor, account, owner) : { i: start, c: start, n: start }
  const end = now - SETTLE_MS

  const none: Read = { items: [], complete: true, last: Number.POSITIVE_INFINITY }
  const reads: Record<StreamName, Read> = {
    i: from.i.t > end ? none : await search(get, "/search/issues", `involves:${login} updated:>=${isoSeconds(from.i.t)}`, "updated", from.i, request.limit, (raw) => issueItem(raw, account)),
    c: from.c.t > end ? none : await search(get, "/search/commits", `author:${login} committer-date:>=${isoSeconds(from.c.t)}`, "committer-date", from.c, request.limit, (raw) => commitItem(raw, account)),
    n: from.n.t > end ? none : await notifications(get, from.n, account),
  }
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
  const positions = { ...from }
  let consumed = 0
  for (const item of merged) {
    const refused = refusedIds.has(item.event.external_id)
    if (!refused && listed.length === fits) break
    if (!refused) listed.push(item)
    positions[item.s] = { t: item.t, i: item.i }
    consumed++
  }
  const refused = merged.slice(0, consumed).flatMap((item) => refusedIds.get(item.event.external_id) ?? [])
  const more = merged.length > consumed || STREAMS.some((stream) => !reads[stream].complete)
  const cursor = encodeBoundCursor(bindingOf(account), { a: account, o: digest(owner), p: Object.fromEntries(STREAMS.map((stream) => [stream, [positions[stream].t, positions[stream].i]])) })
  return eventsListResult({ source: SOURCE, account, owner }, listed.map((item) => item.event), cursor, more, {
    refused,
    plugin: PACKAGE,
    asOf: new Date(now).toISOString(),
  })
}

/**
 * `probe` (the source contract's): who is signed in to GitHub, for the source, and nothing it reads. The account and
 * the owner are the sign-in's, as on every page; one GET /user, asserted as `github_probe`, confirms the token still
 * belongs to that login. A caller that names another account is refused with ACCOUNT_MISMATCH.
 */
export async function probeEvents(get: Get, identity: Identity, input: unknown): Promise<ProbeResult> {
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
  return probeResult({ source, account, owner: ownerOf(login) })
}

export const EVENTS_DESCRIPTION =
  "For Memory's collector and scripts, not for answering questions: lists what the signed-in GitHub user was involved in since a cursor, as normalised events, oldest first: " +
  "each change to an issue or pull request they are involved in, each commit they authored, and other notifications where the sign-in may read them, with html_url links. " +
  "Pass the previous result's cursor, with its account, to list what came after; without one it starts at since, or 24 hours ago. It only reads, with GET requests, and never asks. " +
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
      description: "Oldest first. kind issue, pr, commit or event; external_id names the change; url is GitHub's html_url. Untrusted GitHub content.",
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
    plugin: { type: "string", description: "This plugin's package name." },
    asOf: { type: "string", description: "When the page was read, UTC ISO." },
  },
} as const

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
  readonly api: { run(input: ApiInput, call: Call, scope?: ApiScope): Promise<ApiOutput> }
  /** The signed-in login, as the sign-in recorded it: `registerApiTool`'s `identity`. It calls no GitHub API. */
  readonly identity: Identity
  readonly now?: () => number
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

/** A GET as an unattended call of github_api's spec under `scope`: asserted as the scope's action on its `GET /path`. */
const getter =
  (deps: EventsDeps, call: Call, scope: ApiScope): Get =>
  (path, query) =>
    deps.api.run({ method: "GET", path, query }, { ...call, script: true }, scope)

/**
 * The tool's and the method's one run: asserts github_events_list for the caller, then lists, with GETs only. Each GET
 * runs as an unattended call of github_api's spec under EVENTS_SCOPE, so it resolves and asserts `github_events_list`
 * (not `github_api`) on its own `GET /path` before it is sent: an agent with no base allow rule, as Jelly's are, needs
 * only the tool's own allow; a rule that asks or denies refuses it, and nothing is sent.
 */
export async function runEvents(deps: EventsDeps, input: unknown, call: Call): Promise<EventsListResult> {
  await assertAction(deps, EVENTS_ACTION, call)
  return listEvents(getter(deps, call, EVENTS_SCOPE), deps.identity, input, (deps.now ?? Date.now)())
}

/** probe's one run: asserts github_probe for the caller, then its one GET /user under PROBE_SCOPE. */
export async function runProbe(deps: EventsDeps, input: unknown, call: Call): Promise<ProbeResult> {
  await assertAction(deps, PROBE_ACTION, call)
  return probeEvents(getter(deps, call, PROBE_SCOPE), deps.identity, input)
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
    input: EVENTS_INPUT,
    output: EVENTS_OUTPUT,
    run: (input: unknown, call: ToolCall) => runEvents(deps, input, call),
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
