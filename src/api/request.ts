// Sends one github_api call. Requests go only to the configured API base (uploads to the
// uploads base); the token goes only to those origins. Redirects are handled by hand: a change
// (any method but GET and HEAD) never follows one; a read follows one on the API host only after
// github_api's permission check passes for the new path, and refuses one to another host; a
// download also follows GitHub's redirects to its storage hosts (logs, artifacts and release
// assets), without the Authorization header. Results are capped for inline display.
import { createHash } from "node:crypto"
import { link, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Endpoints } from "../config.js"
import { GitHubPluginError } from "../errors.js"
import { permissionName } from "../token-permissions.js"
import { permissionPath } from "./names.js"
import { ACCEPT, type ApiOutput, type GraphqlInput, type RestInput } from "./contract.js"

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const API_VERSION = "2022-11-28"
/** Inline result cap, in bytes of JSON. */
export const MAX_INLINE_BYTES = 100_000
/** Most bytes read from one response into memory; larger responses need download. */
const MAX_READ_BYTES = 10 * 1024 * 1024
/** Largest file upload accepts. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Largest file download saves; a bigger response is stopped and its partial file removed. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REDIRECTS = 5
const DEFAULT_MAX_PAGES = 10
const DEFAULT_MAX_ITEMS = 1000
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const TRUST = { githubContent: "untrusted" } as const

export type CallDeps = {
  readonly token: string
  readonly endpoints: Endpoints
  /** The name /connect shows for the sign-in. */
  readonly service: string
  /** Whether device sign-in is offered (a clientId is set), so a token problem can point to it. */
  readonly deviceSignIn?: boolean
  readonly fetch: Fetch
  readonly signal?: AbortSignal
  /** The project folder; download and upload files must be inside it. */
  readonly root: string
  /** The download cap; MAX_DOWNLOAD_BYTES unless a test sets a smaller one. */
  readonly maxDownloadBytes?: number
  /**
   * github_api's permission check for a read's redirect on the API host, on its new `METHOD /path` resource. It
   * throws when the rules refuse, and then the redirect is not followed.
   */
  readonly checkRedirect: (resource: string) => Promise<void>
}

/** How a request may follow redirects: never for a change; for a read, on the API host after a check; a download also to storage hosts. */
type Follow = "never" | "api" | "storage"

/**
 * A REST call's target: the URL, and the `METHOD /path` that permissions see. `path` is exactly the path sent; the
 * resource has its case-insensitive name segments in lower case (permissionPath).
 */
export type RestTarget = { readonly url: URL; readonly resource: string; readonly path: string }

/** Characters a path segment holds as themselves (RFC 3986 pchar); percent-encoding one only hides it. */
const PLAIN = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/
/** Characters the URL parser would percent-encode in a path, encoded here first so nothing changes after the check. */
const URL_ENCODED = /[^!-~]|["<>`{}^]/gu

/** A path with every percent-encoding decoded, as often as it decodes (double encoding too). */
function decodedFully(path: string): string | undefined {
  let current = path
  for (let round = 0; round < 8; round++) {
    const next = current.replace(/%[0-9A-Fa-f]{2}/g, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
    if (next === current) return current
    current = next
  }
  return undefined
}

/**
 * Builds the URL for a relative path on the API base (or the uploads base), and refuses
 * anything that could leave it or that the URL parser or GitHub would read as another path:
 * full URLs, `//`, `.` and `..` segments however they are encoded, an encoded plain character,
 * backslashes and control characters. The resource permissions see is the path that is sent.
 */
export function restTarget(input: Pick<RestInput, "method" | "path" | "query" | "upload">, endpoints: Endpoints): RestTarget {
  const split = input.path.indexOf("?")
  const rawPath = split === -1 ? input.path : input.path.slice(0, split)
  const rawQuery = split === -1 ? "" : input.path.slice(split + 1)
  const invalid = (why: string) =>
    new GitHubPluginError("API_PATH_INVALID", `The path ${JSON.stringify(input.path.slice(0, 200))} ${why}.`, "Pass a relative API path such as /repos/OWNER/REPO/pulls.")
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) throw invalid("must start with a single /")
  if (/[\s\\#%]|[\u0000-\u001f\u007f]/.test(rawPath.replace(/%[0-9A-Fa-f]{2}/g, ""))) throw invalid("has characters a path cannot have")
  // A . or .. segment, also encoded (%2e, .%2e, %2E., %252e…) or behind an encoded / or \, is refused.
  const decoded = decodedFully(rawPath)
  if (decoded === undefined || decoded.split(/[/\\]/).some((segment) => segment === "." || segment === "..")) throw invalid("has a . or .. segment")
  let path: string
  try {
    path = rawPath
      .replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
        const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16))
        if (PLAIN.test(char)) throw invalid(`percent-encodes ${JSON.stringify(char)}; write it as itself`)
        return escape.toUpperCase()
      })
      .replace(URL_ENCODED, (char) => encodeURIComponent(char))
  } catch (error) {
    if (error instanceof GitHubPluginError) throw error
    throw invalid("has characters a path cannot have")
  }
  if (/^\/graphql\/?$/i.test(path)) {
    throw new GitHubPluginError("API_GRAPHQL_PATH", "GraphQL calls do not go through method and path.", "Pass { graphql: { query, variables } } instead.")
  }
  const base = new URL(input.upload ? endpoints.uploads : endpoints.api)
  const basePath = base.pathname.replace(/\/$/, "")
  const url = new URL(`${base.origin}${basePath}${path}`)
  // The URL parser must send exactly the checked path; anything it would rewrite is refused.
  if (url.origin !== base.origin || url.pathname !== `${basePath}${path}`) throw invalid("is not sent as written")
  for (const [key, value] of new URLSearchParams(rawQuery)) url.searchParams.append(key, value)
  for (const [key, value] of Object.entries(input.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item))
  }
  return { url, path, resource: `${input.method} ${permissionPath(path)}` }
}

/** Whether a URL is on the API origin and under its base path (on GitHub Enterprise Server the web shares the origin). */
function onApiBase(url: URL, endpoints: Endpoints): boolean {
  const base = new URL(endpoints.api)
  const basePath = base.pathname.replace(/\/$/, "")
  return url.origin === base.origin && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
}

/** A redirect's target as a REST target on the API base, or undefined when it leaves the API host or base path. */
function apiTarget(next: URL, method: RestInput["method"], endpoints: Endpoints): RestTarget | undefined {
  if (!onApiBase(next, endpoints)) return undefined
  const basePath = new URL(endpoints.api).pathname.replace(/\/$/, "")
  return restTarget({ method, path: `${next.pathname.slice(basePath.length) || "/"}${next.search}` }, endpoints)
}

/** Resolves a download or upload path inside the project, following symbolic links. */
export async function projectPath(root: string, path: string): Promise<{ absolute: string; relative: string }> {
  const realRoot = await realpath(root)
  const absolute = resolve(realRoot, path)
  // The nearest folder that exists decides where the path really goes.
  let existing = absolute
  while (!(await stat(existing).then(() => true, () => false))) existing = dirname(existing)
  const real = join(await realpath(existing), relative(existing, absolute))
  const inside = relative(realRoot, real)
  if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
    throw new GitHubPluginError("API_FILE_OUTSIDE_PROJECT", `The file ${JSON.stringify(path)} is outside the project.`, "Use a path inside the project folder.")
  }
  return { absolute: real, relative: inside.split(sep).join("/") }
}

export async function callRest(input: RestInput, target: RestTarget, deps: CallDeps): Promise<ApiOutput> {
  const accept = ACCEPT[input.accept ?? (input.download ? "octet-stream" : "json")]
  let body: BodyInit | undefined
  const headers: Record<string, string> = { Accept: accept }
  if (input.upload) {
    const file = await projectPath(deps.root, input.upload.path)
    const size = (await stat(file.absolute)).size
    if (size > MAX_UPLOAD_BYTES) {
      throw new GitHubPluginError("API_UPLOAD_TOO_LARGE", `The file ${file.relative} is ${size} bytes.`, `Upload files up to ${MAX_UPLOAD_BYTES} bytes.`)
    }
    body = new Uint8Array(await readFile(file.absolute))
    headers["Content-Type"] = input.upload.contentType
  } else if (input.body !== undefined) {
    body = JSON.stringify(input.body)
    headers["Content-Type"] = "application/json"
  }

  if (input.download) {
    const overwrite = input.download.overwrite === true
    const file = await downloadTarget(deps.root, input.download.path, overwrite)
    const response = await send(target.url, { method: input.method, headers, body }, deps, { follow: "storage", what: target.resource })
    if (!response.ok) return finish(response, await readBody(response, input.method), deps)
    const saved = await save(response, file, { overwrite, maxBytes: deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES })
    return { ...base(response), download: saved, truncated: false }
  }

  const follow: Follow = input.method === "GET" || input.method === "HEAD" ? "api" : "never"
  const response = await send(target.url, { method: input.method, headers, body }, deps, { follow, what: target.resource })
  const first = await readBody(response, input.method)
  if (!input.paginate || input.method !== "GET" || !response.ok) return finish(response, first, deps)

  // Pages: join arrays, or the one array of a list object such as { total_count, items }.
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS
  let data = first.data
  let pages = 1
  let last = response
  let next = nextLink(response, deps.endpoints)
  while (next && pages < maxPages && itemCount(data) < maxItems) {
    const page = await send(next, { method: "GET", headers }, deps, { follow: "api", what: target.resource })
    const read = await readBody(page, "GET")
    if (!page.ok) return finish(page, read, deps)
    const joined = join_(data, read.data)
    if (joined === undefined) break
    data = joined
    pages++
    last = page
    next = nextLink(page, deps.endpoints)
  }
  const capped = capItems(data, maxItems)
  const output = finish(last, { ...first, data: capped.data }, deps)
  return { ...output, pagination: { pages, items: itemCount(capped.data), more: next !== undefined || capped.dropped } }
}

export async function callGraphql(input: GraphqlInput, deps: CallDeps): Promise<ApiOutput> {
  const body = JSON.stringify({ query: input.graphql.query, ...(input.graphql.variables ? { variables: input.graphql.variables } : {}) })
  const response = await send(new URL(deps.endpoints.graphql), { method: "POST", headers: { Accept: ACCEPT.json, "Content-Type": "application/json" }, body }, deps, {
    follow: "never",
    what: "POST /graphql",
  })
  const output = finish(response, await readBody(response, "POST"), deps)
  const errors = (output.data as { errors?: unknown } | undefined)?.errors
  return Array.isArray(errors) && errors.length > 0 ? { ...output, ok: false } : output
}

/**
 * One request with redirects handled by hand (see the top of the file); Authorization goes only to the API and
 * uploads origins. `what` names the request, `METHOD /path`, in errors.
 */
async function send(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: BodyInit | undefined },
  deps: CallDeps,
  policy: { follow: Follow; what: string },
): Promise<Response> {
  const trusted = new Set([new URL(deps.endpoints.api).origin, new URL(deps.endpoints.uploads).origin, new URL(deps.endpoints.graphql).origin])
  let current = url
  const { method, body, headers } = init
  for (let hop = 0; ; hop++) {
    const auth: Record<string, string> = trusted.has(current.origin)
      ? { Authorization: `Bearer ${deps.token}`, "X-GitHub-Api-Version": API_VERSION }
      : {}
    let response: Response
    try {
      response = await deps.fetch(current.href, {
        method,
        headers: { "User-Agent": "opencode-github", ...headers, ...auth },
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
    } catch (error) {
      deps.signal?.throwIfAborted()
      throw new GitHubPluginError("API_UNREACHABLE", `Could not reach ${current.host}.`, "Check your network, then try again.")
    }
    const location = response.headers.get("location")
    if (!REDIRECTS.has(response.status) || !location) return response
    await response.body?.cancel().catch(() => undefined)
    const next = new URL(location, current)
    if (policy.follow === "never") throw redirected(policy.what, next, quietly(() => apiTarget(next, method as RestInput["method"], deps.endpoints)))
    const onApi = next.protocol === "https:" ? apiTarget(next, method as RestInput["method"], deps.endpoints) : undefined
    if (hop >= MAX_REDIRECTS) throw new GitHubPluginError("API_REDIRECT_LOOP", `GitHub redirected more than ${MAX_REDIRECTS} times.`, "Try again later.")
    if (next.protocol !== "https:") throw new GitHubPluginError("API_REDIRECT_INSECURE", "GitHub redirected to a non-HTTPS address.", "Try again later.")
    if (onApi) {
      // The same check the request would get for the new path, before anything is sent there.
      await deps.checkRedirect(onApi.resource)
      current = onApi.url
    } else if (policy.follow === "storage") current = next
    else {
      throw new GitHubPluginError(
        "API_REDIRECT_OFF_HOST",
        `GitHub redirected ${policy.what} outside its API, to ${next.host}, and a read follows redirects only within the API.`,
        "Pass download: { path } to save the response; a download follows GitHub's storage redirects, without the token.",
      )
    }
  }
}

const quietly = <T>(make: () => T): T | undefined => {
  try {
    return make()
  } catch {
    return undefined
  }
}

/** A change that GitHub redirected: not followed, so it can be sent again to the new path and checked there. */
function redirected(what: string, next: URL, onApi: RestTarget | undefined): GitHubPluginError {
  if (!onApi) {
    return new GitHubPluginError(
      "API_REDIRECTED",
      `GitHub answered ${what} with a redirect outside its API, to ${next.host}, and a change never follows a redirect.`,
      "Check the path; github_api sends changes only to GitHub's API.",
    )
  }
  const path = `${onApi.path}${onApi.url.search}`
  return new GitHubPluginError(
    "API_REDIRECTED",
    `GitHub answered ${what} with a redirect to ${path}, and a change never follows a redirect.`,
    `Call github_api again with path ${path}, so the change is checked for that path.`,
  )
}

type Body = { data?: unknown; contentType?: string; truncated: boolean; binary?: number }

async function readBody(response: Response, method: string): Promise<Body> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined
  if (method === "HEAD" || response.status === 204 || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    return { truncated: false, ...(contentType ? { contentType } : {}) }
  }
  const { bytes, truncated } = await readCapped(response, MAX_READ_BYTES)
  const text = () => new TextDecoder().decode(bytes)
  if (contentType && /json/i.test(contentType)) {
    try {
      return { data: JSON.parse(text()), contentType, truncated }
    } catch {
      return { data: text(), contentType, truncated: true }
    }
  }
  if (!contentType || /^text\/|diff|patch|xml|yaml/i.test(contentType)) return { data: text(), ...(contentType ? { contentType } : {}), truncated }
  return { contentType, truncated, binary: bytes.byteLength }
}

async function readCapped(response: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size))
      size = limit
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

const fileExists = (file: { relative: string }) =>
  new GitHubPluginError("API_FILE_EXISTS", `The file ${file.relative} already exists.`, "Choose another path, or pass download.overwrite: true.")

/** The download file inside the project; refused when it exists and overwrite is off. */
export async function downloadTarget(root: string, path: string, overwrite: boolean): Promise<{ absolute: string; relative: string }> {
  const file = await projectPath(root, path)
  if (!overwrite && (await stat(file.absolute).then(() => true, () => false))) throw fileExists(file)
  return file
}

const tooLarge = (limit: number) =>
  new GitHubPluginError("API_DOWNLOAD_TOO_LARGE", `The download is over ${limit} bytes.`, "Narrow the request, or download it outside OpenCode.")

/**
 * Streams the body to a temporary file beside the target, then publishes it: with a hard link
 * when overwrite is off, so a file that appeared meanwhile is never replaced, else with rename.
 */
async function save(
  response: Response,
  file: { absolute: string; relative: string },
  options: { overwrite: boolean; maxBytes: number },
): Promise<{ path: string; bytes: number; sha256: string }> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge(options.maxBytes)
  }
  await mkdir(dirname(file.absolute), { recursive: true })
  const temporary = join(dirname(file.absolute), `.${basename(file.absolute)}.${process.pid}.${Date.now()}.part`)
  const hash = createHash("sha256")
  const handle = await open(temporary, "wx")
  let bytes = 0
  try {
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength
        if (bytes > options.maxBytes) throw tooLarge(options.maxBytes)
        hash.update(chunk)
        await handle.write(chunk)
      }
    }
    await handle.close()
    if (options.overwrite) await rename(temporary, file.absolute)
    else {
      await link(temporary, file.absolute).catch((error: NodeJS.ErrnoException) => {
        throw error.code === "EEXIST" ? fileExists(file) : error
      })
      await rm(temporary, { force: true })
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
  return { path: file.relative, bytes, sha256: hash.digest("hex") }
}

function base(response: Response): Omit<ApiOutput, "truncated"> {
  const limit = Number(response.headers.get("x-ratelimit-limit"))
  const remaining = Number(response.headers.get("x-ratelimit-remaining"))
  const reset = Number(response.headers.get("x-ratelimit-reset"))
  const rateLimit =
    response.headers.has("x-ratelimit-remaining") && Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(reset)
      ? { limit, remaining, resetAt: new Date(reset * 1000).toISOString() }
      : undefined
  return { ok: response.ok, status: response.status, ...(rateLimit ? { rateLimit } : {}), trust: TRUST }
}

/** The output for a response: status, rate limit, a capped body, and a next step for failures. */
function finish(response: Response, body: Body, deps: CallDeps): ApiOutput {
  const output: ApiOutput = { ...base(response), ...(body.contentType ? { contentType: body.contentType } : {}), truncated: body.truncated }
  const nextStep = failureStep(response, deps, body.data)
  if (body.binary !== undefined) {
    return { ...output, truncated: false, nextStep: nextStep ?? `The response is ${body.binary} bytes of ${body.contentType}; pass download: { path } to save it.` }
  }
  if (body.data === undefined) return { ...output, ...(nextStep ? { nextStep } : {}) }
  const capped = capInline(body.data)
  const truncated = output.truncated || capped.truncated
  return {
    ...output,
    data: capped.data,
    truncated,
    ...(nextStep
      ? { nextStep }
      : truncated
        ? { nextStep: "The result was cut. Narrow it with query parameters such as per_page or filters, or save it with download." }
        : {}),
  }
}

function failureStep(response: Response, deps: CallDeps, data: unknown): string | undefined {
  if (response.ok) return undefined
  if (response.status === 401) return `GitHub rejected the saved sign-in. Run /connect and choose ${deps.service} to sign in again.`
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"))
    return `The rate limit is used up. Try again after ${Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : "the reset time"}.`
  }
  const accepted = scopes(response.headers.get("x-accepted-oauth-scopes"))
  const granted = scopes(response.headers.get("x-oauth-scopes"))
  if (response.status === 403 && accepted.length > 0 && !accepted.some((scope) => granted.includes(scope))) {
    return `The sign-in lacks the scope ${accepted.join(" or ")}. Add it to the plugin option scopes, then run /connect and choose ${deps.service} to sign in again.`
  }
  // A fine-grained token without the permission an endpoint needs. GitHub names it in X-Accepted-GitHub-Permissions.
  const message = (data as { message?: unknown } | undefined)?.message
  if (response.status === 403 && typeof message === "string" && /not accessible by personal access token/i.test(message)) {
    const needed = acceptedPermissions(response.headers.get("x-accepted-github-permissions"))
    const what = needed.length > 0 ? `the fine-grained permission ${needed.join(" or ")}` : "a fine-grained permission this endpoint needs"
    const instead = deps.deviceSignIn ? `, or run /connect, choose ${deps.service} and sign in with GitHub instead of a token` : ""
    return `The token lacks ${what}. Add it to the token on GitHub (Settings, Developer settings, Personal access tokens)${instead}.`
  }
  if (response.status === 404) return `GitHub answers 404 for a wrong path and for one the account cannot see on ${new URL(deps.endpoints.api).host}. Check the path and the account's access.`
  return undefined
}

/** "actions=read; contents=read" as ["Actions (read)", "Contents (read)"]. */
function acceptedPermissions(header: string | null): string[] {
  return (header ?? "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter((part) => /^[a-z_]+=[a-z]+$/.test(part))
    .map((part) => {
      const [key, level] = part.split("=") as [string, string]
      return `${permissionName(key)} (${level})`
    })
}

function scopes(header: string | null): string[] {
  return (header ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
}

function nextLink(response: Response, endpoints: Endpoints): URL | undefined {
  const link = response.headers.get("link")
  const match = link && /<([^>]+)>\s*;\s*rel="next"/.exec(link)
  if (!match) return undefined
  const url = URL.parse(match[1]!)
  // Only pages under the API base; anything else ends the pagination.
  return url && onApiBase(url, endpoints) ? url : undefined
}

/** The list inside a page: the page itself, or the only array field of a list object. */
function listOf(value: unknown): { key?: string; items: unknown[] } | undefined {
  if (Array.isArray(value)) return { items: value }
  if (value && typeof value === "object") {
    const arrays = Object.entries(value).filter(([, item]) => Array.isArray(item))
    if (arrays.length === 1) return { key: arrays[0]![0], items: arrays[0]![1] as unknown[] }
  }
  return undefined
}

function join_(previous: unknown, page: unknown): unknown {
  const left = listOf(previous)
  const right = listOf(page)
  if (!left || !right || left.key !== right.key) return undefined
  const items = [...left.items, ...right.items]
  return left.key === undefined ? items : { ...(previous as object), [left.key]: items }
}

function itemCount(value: unknown): number {
  return listOf(value)?.items.length ?? 0
}

function capItems(value: unknown, max: number): { data: unknown; dropped: boolean } {
  const list = listOf(value)
  if (!list || list.items.length <= max) return { data: value, dropped: false }
  const items = list.items.slice(0, max)
  return { data: list.key === undefined ? items : { ...(value as object), [list.key]: items }, dropped: true }
}

/** Keeps the inline result under MAX_INLINE_BYTES: whole list items where it can, else a cut text. */
function capInline(value: unknown): { data: unknown; truncated: boolean } {
  const size = (item: unknown) => Buffer.byteLength(typeof item === "string" ? item : (JSON.stringify(item) ?? ""))
  if (size(value) <= MAX_INLINE_BYTES) return { data: value, truncated: false }
  if (typeof value === "string") return { data: Buffer.from(value).subarray(0, MAX_INLINE_BYTES).toString("utf8"), truncated: true }
  const list = listOf(value)
  if (list) {
    const kept: unknown[] = []
    let used = list.key === undefined ? 2 : size({ ...(value as object), [list.key]: [] })
    for (const item of list.items) {
      used += size(item) + 1
      if (used > MAX_INLINE_BYTES) break
      kept.push(item)
    }
    return { data: list.key === undefined ? kept : { ...(value as object), [list.key]: kept }, truncated: true }
  }
  return { data: Buffer.from(JSON.stringify(value)).subarray(0, MAX_INLINE_BYTES).toString("utf8"), truncated: true }
}
