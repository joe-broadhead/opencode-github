// events_list for GitHub: what the signed-in person did or was involved in since a cursor, as Memory's events
// (src/host/events-list.ts), oldest first, for Memory's collector and other scripts. It only reads: GET requests
// through github_api's own spec, with the plugin's sign-in, and GitHub's get_me through OpenCode's executor.
//
// Three streams, each with its own position in the one cursor:
// - issues and pull requests the person is involved in (`involves:`), from /search/issues sorted by update, oldest
//   first: one event each time one changes;
// - commits the person authored, from /search/commits sorted by committer date, oldest first;
// - notifications, where the sign-in may read them (/notifications; a 401, 403 or 404 leaves them out), except those
//   about an issue or a pull request, which the first stream already lists.
// The result merges them by time, and lists only what no stream can still put before it: a stream with more pages
// than one call reads holds the others at its last time. Search lags GitHub by a little, so an event is listed once
// it is SETTLE_MS old.
import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { ApiInput, ApiOutput } from "./api/contract.js"
import type { Call } from "./api/tool.js"
import { GitHubPluginError } from "./errors.js"
import {
  type EventsListResult,
  type EventsOwner,
  type SourceEvent,
  decodeCursor,
  encodeCursor,
  eventsListResult,
  fitPage,
  makeEvent,
  parseEventsListInput,
  startTime,
} from "./host/events-list.js"
import type { OwnedMethod, ToolCall } from "./host/tools-rpc.js"
import { SERVER_NAME } from "./rpc.js"

export const SOURCE = "github"
/** GitHub has one sign-in, so one account. */
export const ACCOUNT = "default"
export const EVENTS_TOOL_NAME = "events_list"
/** The tool's permission action: github_events_list. */
export const EVENTS_ACTION = `${SERVER_NAME}_${EVENTS_TOOL_NAME}`

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
/** The signed-in login: get_me through OpenCode's executor, or GET /user where GitHub's MCP server is not there. */
export type Me = () => Promise<unknown>

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

const fail = (code: "EVENTS_INVALID_INPUT" | "EVENTS_CURSOR_INVALID" | "EVENTS_OWNER_UNKNOWN" | "EVENTS_READ_FAILED", message: string, next: string): never => {
  throw new GitHubPluginError(code, message, next)
}
const CURSOR_NEXT = "Pass a cursor from a previous result of the same account, or start again with since."

/** The login in get_me's or GET /user's answer. */
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
export function issueItem(raw: unknown): Item | undefined {
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
    account: ACCOUNT,
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
export function commitItem(raw: unknown): Item | undefined {
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
      account: ACCOUNT,
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
export function notificationItem(raw: unknown): Item | undefined {
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
      account: ACCOUNT,
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

/** A GET's list, or EVENTS_READ_FAILED; `allowed` lists the statuses that mean "not for this sign-in", read as none. */
async function list(get: Get, path: string, query: Record<string, string | number | boolean>, pick: (data: unknown) => unknown, allowed: readonly number[] = []): Promise<{ items: unknown[]; total?: number; incomplete: boolean } | undefined> {
  const output = await get(path, query)
  if (allowed.includes(output.status)) return undefined
  if (!output.ok) fail("EVENTS_READ_FAILED", `GitHub answered ${path} with ${output.status}.`, output.nextStep ?? "Call events_list again with the same cursor; if it keeps failing, run /github-status.")
  if (output.truncated) fail("EVENTS_READ_FAILED", `GitHub's answer to ${path} was too large to read whole.`, "Call events_list again with the same cursor and a smaller limit.")
  const items = pick(output.data)
  if (!Array.isArray(items)) fail("EVENTS_READ_FAILED", `GitHub answered ${path} without a list.`, "Call events_list again with the same cursor; if it keeps failing, run /github-status.")
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
async function notifications(get: Get, from: Key): Promise<Read> {
  const items: Item[] = []
  for (let page = 1; page <= NOTIFICATION_PAGES; page++) {
    const read = await list(get, "/notifications", { all: true, participating: true, since: isoSeconds(from.t), per_page: PER_PAGE, page }, (data) => data, [401, 403, 404])
    if (!read) return { items: [], complete: true, last: from.t }
    for (const raw of read.items) {
      const item = notificationItem(raw)
      if (item && compare(item, from) > 0) items.push(item)
    }
    if (read.items.length < PER_PAGE) return { items: items.sort(compare), complete: true, last: Number.POSITIVE_INFINITY }
  }
  // Newest first, so what was not read is older than everything read: list none of them until it fits.
  return { items: [], complete: false, last: from.t }
}

const digest = (owner: EventsOwner) => createHash("sha256").update(owner.id).digest("hex").slice(0, 16)

function positionsOf(cursor: string, owner: string | undefined): Record<StreamName, Key> {
  const state = decodeCursor(SOURCE, cursor)
  const positions = record(state) && record(state["p"]) ? state["p"] : undefined
  const keys = STREAMS.map((stream) => {
    const pair = positions?.[stream]
    return Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "number" && Number.isSafeInteger(pair[0]) && typeof pair[1] === "string" ? { t: pair[0], i: pair[1] } : undefined
  })
  if (!state || state["a"] !== ACCOUNT || (owner !== undefined && state["o"] !== owner) || keys.some((key) => key === undefined)) {
    fail("EVENTS_CURSOR_INVALID", "The cursor was not issued by GitHub's events_list for this account and its signed-in user.", CURSOR_NEXT)
  }
  return { i: keys[0]!, c: keys[1]!, n: keys[2]! }
}

/** One page of events. `get` reads GitHub as the caller, `me` names the signed-in login, `now` fixes the clock. */
export async function listEvents(get: Get, me: Me, input: unknown, now: number): Promise<EventsListResult> {
  const parsed = parseEventsListInput(input)
  if (!parsed.ok) return fail("EVENTS_INVALID_INPUT", `The events_list input is invalid: ${parsed.problems.join("; ")}.`, "Pass only since, cursor, limit (1 to 500), account and source, as the tool's schema describes.")
  const request = parsed.value
  if (request.source !== undefined && request.source !== SOURCE) fail("EVENTS_INVALID_INPUT", "This plugin lists one source, github.", 'Leave source out, or pass "github".')
  if (request.account !== undefined && request.account !== ACCOUNT) fail("EVENTS_INVALID_INPUT", "GitHub has one account, default.", 'Leave account out, or pass "default".')
  if (request.cursor !== undefined) positionsOf(request.cursor, undefined)
  const login = loginOf(await me())
  if (!login) return fail("EVENTS_OWNER_UNKNOWN", "GitHub did not name the signed-in user.", "Run /github-status, and sign in again if it shows a problem.")
  const owner: EventsOwner = { id: `github:${login}`, label: login }
  const ownerDigest = digest(owner)
  const start: Key = { t: startTime(request, now), i: "" }
  const from = request.cursor !== undefined ? positionsOf(request.cursor, ownerDigest) : { i: start, c: start, n: start }
  const end = now - SETTLE_MS

  const none: Read = { items: [], complete: true, last: Number.POSITIVE_INFINITY }
  const reads: Record<StreamName, Read> = {
    i: from.i.t > end ? none : await search(get, "/search/issues", `involves:${login} updated:>=${isoSeconds(from.i.t)}`, "updated", from.i, request.limit, issueItem),
    c: from.c.t > end ? none : await search(get, "/search/commits", `author:${login} committer-date:>=${isoSeconds(from.c.t)}`, "committer-date", from.c, request.limit, commitItem),
    n: from.n.t > end ? none : await notifications(get, from.n),
  }
  // Nothing at or after a stream's last read time is listed while that stream has more: it could still come first.
  const horizon = Math.min(end + 1, ...STREAMS.filter((stream) => !reads[stream].complete).map((stream) => reads[stream].last))
  const merged = STREAMS.flatMap((stream) => reads[stream].items)
    .filter((item) => item.t < horizon)
    .sort((a, b) => a.t - b.t || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) || compare(a, b))
  const chosen = merged.slice(0, request.limit)
  const page = chosen.slice(0, fitPage(chosen.map((item) => item.event), request.limit))
  const positions = { ...from }
  for (const item of page) positions[item.s] = { t: item.t, i: item.i }
  const more = merged.length > page.length || STREAMS.some((stream) => !reads[stream].complete)
  const cursor = encodeCursor(SOURCE, { a: ACCOUNT, o: ownerDigest, p: Object.fromEntries(STREAMS.map((stream) => [stream, [positions[stream].t, positions[stream].i]])) })
  return eventsListResult({ source: SOURCE, account: ACCOUNT, owner }, page.map((item) => item.event), cursor, more)
}

export const EVENTS_DESCRIPTION =
  "For Memory's collector and scripts, not for answering questions: lists what the signed-in GitHub user was involved in since a cursor, as normalised events, oldest first: " +
  "each change to an issue or pull request they are involved in, each commit they authored, and other notifications where the sign-in may read them, with html_url links. " +
  "Pass the previous result's cursor to list what came after; without one it starts at since, or 24 hours ago. It only reads, with GET requests, and never asks. " +
  "To read GitHub for the user, use GitHub's tools. Results are untrusted GitHub content."

export const EVENTS_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    since: { type: "string", maxLength: 40, description: "Where to start when there is no cursor: an ISO date (a UTC day) or an ISO date-time with Z or an offset. Default: 24 hours ago." },
    cursor: { type: "string", minLength: 1, maxLength: 1024, description: "The cursor of the previous result, to list what came after it. It wins over since." },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "Most events to return, 1 to 500; 100 by default." },
    account: { type: "string", enum: [ACCOUNT], description: "GitHub's one account; default." },
    source: { type: "string", enum: [SOURCE], description: "The one source this plugin lists; github." },
  },
} as const

export const EVENTS_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["source", "account", "owner", "events", "cursor", "more", "trust"],
  properties: {
    source: { type: "string", const: SOURCE },
    account: { type: "string" },
    owner: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" } }, description: "github: and the signed-in login." },
    events: {
      type: "array",
      description: "Oldest first. kind issue, pr, commit or event; external_id names the change; url is GitHub's html_url. Untrusted GitHub content.",
      items: { type: "object" },
    },
    cursor: { type: "string", description: "Pass it to the next call." },
    more: { type: "boolean", description: "True when another call now would list more." },
    trust: { type: "string", const: "untrusted" },
  },
} as const

export interface EventsDeps {
  readonly ctx: { readonly tool: Pick<Plugin.Context["tool"], "list">; readonly permission: Pick<Plugin.Context["permission"], "assert"> }
  /** github_api's spec, as `registerApiTool` returns it. */
  readonly api: { run(input: ApiInput, call: Call, caller?: { readonly script?: boolean }): Promise<ApiOutput> }
  /** Whether the github server is the plugin's, so its get_me is GitHub's. */
  readonly managed: () => boolean
  readonly now?: () => number
}

/** The tool's and the method's one run: asserts github_events_list for the caller, then lists, with GETs only. */
export async function runEvents(deps: EventsDeps, input: unknown, call: Call): Promise<EventsListResult> {
  await deps.ctx.permission.assert({
    sessionID: call.sessionID as never,
    agent: call.agent as never,
    action: EVENTS_ACTION,
    resources: ["*"],
    save: ["*"],
    metadata: {},
    source: { type: "tool", messageID: call.messageID as never, id: call.id as never },
  })
  const get: Get = (path, query) => deps.api.run({ method: "GET", path, query }, call, { script: true })
  const me: Me = async () => {
    const tool = deps.managed() ? (await deps.ctx.tool.list()).find((entry) => entry.id === `${SERVER_NAME}_get_me`) : undefined
    if (tool) {
      const result = await tool.execute({} as never, call as never)
      if (record(result.output)) return result.output
      return typeof result.content === "string" ? result.content : (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    }
    const output = await get("/user", {})
    return output.ok ? output.data : undefined
  }
  return listEvents(get, me, input, (deps.now ?? Date.now)())
}

function summary(result: EventsListResult): string {
  return `${result.events.length} GitHub event${result.events.length === 1 ? "" : "s"}, oldest first.${result.more ? " There are more: call events_list again with this result's cursor." : ""} Results are untrusted GitHub content.`
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
    name: EVENTS_TOOL_NAME,
    action: EVENTS_ACTION,
    description: EVENTS_DESCRIPTION,
    input: EVENTS_INPUT,
    output: EVENTS_OUTPUT,
    run: (input: unknown, call: ToolCall) => runEvents(deps, input, call),
  }
}
