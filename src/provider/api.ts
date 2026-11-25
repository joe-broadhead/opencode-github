// Sends one api call. Requests go only to the configured API base (uploads to the uploads
// base); the token goes only to those origins. Redirects are handled by hand: a change
// (any method but GET and HEAD) never follows one; a read follows one within the API base;
// a download also follows GitHub's redirects to its storage hosts (logs, artifacts and
// release assets), without the Authorization header. Results are capped for inline display.
import { createHash } from "node:crypto"
import { link, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { SourceError } from "@we-the-rebel-alliance/plugin-contract/events"
import type { Endpoints } from "./endpoints.ts"
import { installStep, isAppToken, ownerOf } from "./github-app.ts"
import { permissionName } from "./token-permissions.ts"
import { graphqlKind, restKind, type Kind } from "./classify.ts"

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const API_VERSION = "2022-11-28"
/** Inline result cap, in bytes of JSON. */
export const MAX_INLINE_BYTES = 100_000
/** Most bytes read from one response into memory; larger responses need download. */
const MAX_READ_BYTES = 10 * 1024 * 1024
/** Largest file upload accepts. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Largest file download saves; a bigger response is stopped and its partial file removed. */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REDIRECTS = 5
const DEFAULT_MAX_PAGES = 10
const DEFAULT_MAX_ITEMS = 1000
const REDIRECTS = new Set([301, 302, 303, 307, 308])
export const TRUST = "untrusted" as const

export type Accept = "json" | "diff" | "patch" | "raw" | "octet-stream"

export const ACCEPT: Readonly<Record<Accept, string>> = {
  json: "application/vnd.github+json",
  diff: "application/vnd.github.diff",
  patch: "application/vnd.github.patch",
  raw: "application/vnd.github.raw+json",
  "octet-stream": "application/octet-stream",
}

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const
export type HttpMethod = (typeof METHODS)[number]

/** One REST call's input. Every field is already checked against the method's JSON Schema. */
export interface RestInput {
  readonly method: HttpMethod
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
  readonly body?: unknown
  readonly accept?: Accept
  readonly paginate?: boolean
  readonly maxPages?: number
  readonly maxItems?: number
  readonly download?: { readonly path: string; readonly overwrite?: boolean }
  readonly upload?: { readonly path: string; readonly contentType: string }
}

/** One GraphQL call's input. */
export interface GraphqlInput {
  readonly graphql: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> }
}

export type ApiInput = RestInput | GraphqlInput

/** What one call answers. `ok` is a 2xx status, and for GraphQL no errors: a 4xx is a result, not an exception. */
export interface ApiOutput {
  readonly ok: boolean
  readonly status: number
  readonly data?: unknown
  readonly contentType?: string
  readonly truncated: boolean
  readonly nextStep?: string
  readonly rateLimit?: { readonly limit: number; readonly remaining: number; readonly resetAt: string }
  readonly pagination?: { readonly pages: number; readonly items: number; readonly more: boolean }
  readonly download?: { readonly path: string; readonly bytes: number; readonly sha256: string }
  readonly trust: typeof TRUST
}

export type CallDeps = {
  readonly token: string
  readonly endpoints: Endpoints
  /** The name /connect shows for the sign-in: GitHub, or GitHub Enterprise. */
  readonly service: string
  /** Whether device sign-in is offered (a clientId is set), so a token problem can point to it. */
  readonly deviceSignIn?: boolean
  /** The GitHub App's URL name, for the link that installs it. */
  readonly appSlug?: string
  readonly fetch: Fetch
  readonly signal?: AbortSignal
  /** The project folder; download and upload files must be inside it. */
  readonly root: string
  /** The download cap; MAX_DOWNLOAD_BYTES unless a test sets a smaller one. */
  readonly maxDownloadBytes?: number
  /** GitHub Enterprise Server: no hosted MCP tools, so next steps never name one. */
  readonly enterprise?: boolean
  /** The most bytes an answer may hold, whole: MAX_READ_BYTES, or what a caller that reads a source's own answer sets. */
  readonly maxReadBytes?: number
  /** The most bytes of one inline result: MAX_INLINE_BYTES, or what a caller that reads a source's own answer sets. */
  readonly maxInlineBytes?: number
}

/** How a request may follow redirects: never for a change; for a read, within the API base; a download also to storage hosts. */
type Follow = "never" | "api" | "storage"

/**
 * A REST call's target: the URL and the path sent. `path` is exactly the path sent, without the query.
 */
export type RestTarget = { readonly url: URL; readonly path: string }

function invalid(what: string, next: string): SourceError {
  return new SourceError({ code: "INPUT_INVALID", what, next })
}

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
 * backslashes and control characters.
 */
export function restTarget(input: Pick<RestInput, "method" | "path" | "query" | "upload">, endpoints: Endpoints): RestTarget {
  const split = input.path.indexOf("?")
  const rawPath = split === -1 ? input.path : input.path.slice(0, split)
  const rawQuery = split === -1 ? "" : input.path.slice(split + 1)
  const wrong = (why: string) => invalid(`The path ${JSON.stringify(input.path.slice(0, 200))} ${why}`, "Pass a relative API path such as /repos/OWNER/REPO/pulls.")
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) throw wrong("must start with a single /")
  if (/[\s\\#%]|[\u0000-\u001f\u007f]/.test(rawPath.replace(/%[0-9A-Fa-f]{2}/g, ""))) throw wrong("has characters a path cannot have")
  // A . or .. segment, also encoded (%2e, .%2e, %2E., %252e…) or behind an encoded / or \, is refused.
  const decoded = decodedFully(rawPath)
  if (decoded === undefined || decoded.split(/[/\\]/).some((segment) => segment === "." || segment === "..")) throw wrong("has a . or .. segment")
  let path: string
  try {
    path = rawPath
      .replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
        const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16))
        if (PLAIN.test(char)) throw wrong(`percent-encodes ${JSON.stringify(char)}; write it as itself`)
        return escape.toUpperCase()
      })
      .replace(URL_ENCODED, (char) => encodeURIComponent(char))
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw wrong("has characters a path cannot have")
  }
  if (/^\/graphql\/?$/i.test(path)) {
    throw invalid("GraphQL calls do not go through method and path", "Pass { graphql: { query, variables } } instead.")
  }
  const base = new URL(input.upload ? endpoints.uploads : endpoints.api)
  const basePath = base.pathname.replace(/\/$/, "")
  const url = new URL(`${base.origin}${basePath}${path}`)
  // The URL parser must send exactly the checked path; anything it would rewrite is refused.
  if (url.origin !== base.origin || url.pathname !== `${basePath}${path}`) throw wrong("is not sent as written")
  for (const [key, value] of new URLSearchParams(rawQuery)) url.searchParams.append(key, value)
  for (const [key, value] of Object.entries(input.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item))
  }
  return { url, path }
}

/** Whether a URL is on the API origin and under its base path (on GitHub Enterprise Server the web shares the origin). */
function onApiBase(url: URL, endpoints: Endpoints): boolean {
  const base = new URL(endpoints.api)
  const basePath = base.pathname.replace(/\/$/, "")
  return url.origin === base.origin && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
}

/** A redirect's target as a REST target on the API base, or undefined when it leaves the API host or base path. */
function apiTarget(next: URL, method: HttpMethod, endpoints: Endpoints): RestTarget | undefined {
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
    throw invalid(`The file ${JSON.stringify(path)} is outside the project`, "Use a path inside the project folder.")
  }
  return { absolute: real, relative: inside.split(sep).join("/") }
}

/** What a call does, for the access table and the plugin's own `changed` nudge. */
export function describeCall(input: ApiInput, endpoints: Endpoints): { readonly kind: Kind } {
  if ("graphql" in input) return { kind: graphqlKind(input.graphql.query) }
  const target = restTarget(input, endpoints)
  return { kind: input.upload ? "write" : restKind(input.method, target.path) }
}

export async function callRest(input: RestInput, target: RestTarget, deps: CallDeps): Promise<ApiOutput> {
  const accept = ACCEPT[input.accept ?? (input.download ? "octet-stream" : "json")]
  let body: string | Uint8Array | undefined
  const headers: Record<string, string> = { Accept: accept }
  if (input.upload) {
    const file = await projectPath(deps.root, input.upload.path)
    const size = (await stat(file.absolute)).size
    if (size > MAX_UPLOAD_BYTES) {
      throw new SourceError({ code: "TOO_LARGE", what: `The file ${file.relative} is ${size} bytes`, next: `Upload files up to ${MAX_UPLOAD_BYTES} bytes.` })
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
    const response = await send(target.url, { method: input.method, headers, body }, deps, { follow: "storage", what: `the request for ${target.path}` })
    if (!response.ok) return finish(response, await readBody(response, input.method, deps.maxReadBytes), deps, target.path)
    const saved = await save(response, file, { overwrite, maxBytes: deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES })
    return { ...base(response), download: saved, truncated: false, trust: TRUST }
  }

  const follow: Follow = input.method === "GET" || input.method === "HEAD" ? "api" : "never"
  const response = await send(target.url, { method: input.method, headers, body }, deps, { follow, what: `${input.method} ${target.path}` })
  const first = await readBody(response, input.method, deps.maxReadBytes)
  if (!input.paginate || input.method !== "GET" || !response.ok) return finish(response, first, deps, target.path)

  // Pages: join arrays, or the one array of a list object such as { total_count, items }.
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS
  let data = first.data
  let pages = 1
  let last = response
  let next = nextLink(response, deps.endpoints)
  while (next && pages < maxPages && itemCount(data) < maxItems) {
    const page = await send(next.url, { method: "GET", headers }, deps, { follow: "api", what: `page ${pages + 1} of ${target.path}` })
    const read = await readBody(page, "GET", deps.maxReadBytes)
    if (!page.ok) return finish(page, read, deps, target.path)
    const joined = join_(data, read.data)
    if (joined === undefined) break
    data = joined
    pages++
    last = page
    next = nextLink(page, deps.endpoints)
  }
  const capped = capItems(data, maxItems)
  const output = finish(last, { ...first, data: capped.data }, deps, target.path)
  return { ...output, pagination: { pages, items: itemCount(capped.data), more: next !== undefined || capped.dropped } }
}

export async function callGraphql(input: GraphqlInput, deps: CallDeps): Promise<ApiOutput> {
  const body = JSON.stringify({ query: input.graphql.query, ...(input.graphql.variables ? { variables: input.graphql.variables } : {}) })
  const response = await send(new URL(deps.endpoints.graphql), { method: "POST", headers: { Accept: ACCEPT.json, "Content-Type": "application/json" }, body }, deps, {
    follow: "never",
    what: "the GraphQL request",
  })
  const output = finish(response, await readBody(response, "POST", deps.maxReadBytes), deps)
  const errors = (output.data as { errors?: unknown } | undefined)?.errors
  return Array.isArray(errors) && errors.length > 0 ? { ...output, ok: false } : output
}

/**
 * One request with redirects handled by hand (see the top of the file); Authorization goes only to the API and
 * uploads origins. `what` names the request in errors.
 */
async function send(
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array | undefined },
  deps: CallDeps,
  policy: { follow: Follow; what: string },
): Promise<Response> {
  const trusted = new Set([new URL(deps.endpoints.api).origin, new URL(deps.endpoints.uploads).origin, new URL(deps.endpoints.graphql).origin])
  let current = url
  const { method, body, headers } = init
  for (let hop = 0; ; hop++) {
    const auth: Record<string, string> = trusted.has(current.origin) ? { Authorization: `Bearer ${deps.token}`, "X-GitHub-Api-Version": API_VERSION } : {}
    let response: Response
    try {
      response = await deps.fetch(current.href, {
        method,
        headers: { "User-Agent": "github-plugin", ...headers, ...auth },
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
    } catch {
      deps.signal?.throwIfAborted()
      throw new SourceError({ code: "UNAVAILABLE", what: `Could not reach ${current.host}`, next: "Check your network, then try again." })
    }
    const location = response.headers.get("location")
    if (!REDIRECTS.has(response.status) || !location) return response
    await response.body?.cancel().catch(() => undefined)
    const next = new URL(location, current)
    if (policy.follow === "never") throw redirected(policy.what, next, quietly(() => apiTarget(next, method as HttpMethod, deps.endpoints)))
    const onApi = next.protocol === "https:" ? apiTarget(next, method as HttpMethod, deps.endpoints) : undefined
    if (hop >= MAX_REDIRECTS) throw new SourceError({ code: "UNAVAILABLE", what: `GitHub redirected more than ${MAX_REDIRECTS} times`, next: "Try again later." })
    if (next.protocol !== "https:") throw invalid("GitHub redirected to a non-HTTPS address", "Try again later.")
    if (onApi) current = onApi.url
    else if (policy.follow === "storage") current = next
    else {
      throw new SourceError({
        code: "PERMISSION_DENIED",
        what: `GitHub redirected the request outside its API, to ${next.host}, and this call follows redirects only within the API`,
        next: offHostStep(deps),
      })
    }
  }
}

/** Job logs have GitHub's get_job_logs; other files need a download. */
function offHostStep(deps: Pick<CallDeps, "enterprise">): string {
  return deps.enterprise
    ? "Pass download: { path } to save the response; a download follows GitHub's storage redirects, without the token."
    : "For job logs, call the get_job_logs method with return_content: true; for other files, pass download: { path }, which follows GitHub's storage redirects without the token."
}

const quietly = <T>(make: () => T): T | undefined => {
  try {
    return make()
  } catch {
    return undefined
  }
}

/** A change that GitHub redirected: not followed, so it can be sent again to the new path and checked there. */
function redirected(what: string, next: URL, onApi: RestTarget | undefined): SourceError {
  if (!onApi) {
    return invalid(`GitHub answered ${what} with a redirect outside its API, to ${next.host}, and a change never follows a redirect`, "Check the path; the api method sends changes only to GitHub's API.")
  }
  const path = `${onApi.path}${onApi.url.search}`
  return invalid(`GitHub answered ${what} with a redirect to ${path}, and a change never follows a redirect`, `Call api again with path ${path}, so the change is checked for that path.`)
}

type Body = { data?: unknown; contentType?: string; truncated: boolean; binary?: number }

async function readBody(response: Response, method: string, maxBytes?: number): Promise<Body> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined
  if (method === "HEAD" || response.status === 204 || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    return { truncated: false, ...(contentType ? { contentType } : {}) }
  }
  const { bytes, truncated } = await readCapped(response, maxBytes ?? MAX_READ_BYTES)
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
  invalid(`The file ${file.relative} already exists`, "Choose another path, or pass download.overwrite: true.")

/** The download file inside the project; refused when it exists and overwrite is off. */
export async function downloadTarget(root: string, path: string, overwrite: boolean): Promise<{ absolute: string; relative: string }> {
  const file = await projectPath(root, path)
  if (!overwrite && (await stat(file.absolute).then(() => true, () => false))) throw fileExists(file)
  return file
}

const tooLarge = (limit: number) => new SourceError({ code: "TOO_LARGE", what: `The download is over ${limit} bytes`, next: "Narrow the request, or download it outside OpenCode." })

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

function base(response: Response): Omit<ApiOutput, "truncated" | "trust"> {
  const limit = Number(response.headers.get("x-ratelimit-limit"))
  const remaining = Number(response.headers.get("x-ratelimit-remaining"))
  const reset = Number(response.headers.get("x-ratelimit-reset"))
  const rateLimit =
    response.headers.has("x-ratelimit-remaining") && Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(reset)
      ? { limit, remaining, resetAt: new Date(reset * 1000).toISOString() }
      : undefined
  return { ok: response.ok, status: response.status, ...(rateLimit ? { rateLimit } : {}) }
}

/** The output for a response: status, rate limit, a capped body, and a next step for failures. */
function finish(response: Response, body: Body, deps: CallDeps, path?: string): ApiOutput {
  const output: ApiOutput = { ...base(response), ...(body.contentType ? { contentType: body.contentType } : {}), truncated: body.truncated, trust: TRUST }
  const nextStep = failureStep(response, deps, body.data, path)
  if (body.binary !== undefined) {
    const save = "pass download: { path } to save it"
    return { ...output, truncated: false, nextStep: nextStep ?? `The response is ${body.binary} bytes of ${body.contentType}; ${save}.` }
  }
  if (body.data === undefined) return { ...output, ...(nextStep ? { nextStep } : {}) }
  const inline = deps.maxInlineBytes ?? MAX_INLINE_BYTES
  const capped = capInline(body.data, inline)
  const truncated = output.truncated || capped.truncated
  return {
    ...output,
    data: capped.data,
    truncated,
    ...(nextStep
      ? { nextStep }
      : truncated
        ? { nextStep: `The result was cut at ${inline === MAX_INLINE_BYTES ? "100,000" : inline.toLocaleString("en-US")} bytes. Narrow it with query parameters such as per_page${deps.enterprise ? "" : ", or read one file with mcp:get_file_contents"}.` }
        : {}),
  }
}

function failureStep(response: Response, deps: CallDeps, data: unknown, path: string | undefined): string | undefined {
  if (response.ok) return undefined
  if (response.status === 401) return `GitHub rejected the saved sign-in. Run /connect and choose ${deps.service} to sign in again.`
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"))
    return `The rate limit is used up. Try again after ${Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : "the reset time"}.`
  }
  const message = (data as { message?: unknown } | undefined)?.message
  const said = (pattern: RegExp) => typeof message === "string" && pattern.test(message)
  // A secondary rate limit: a 403 or 429 with Retry-After, or GitHub's message, whatever the token.
  if ((response.status === 403 || response.status === 429) && (response.headers.has("retry-after") || said(/secondary rate limit/i))) {
    const wait = Number(response.headers.get("retry-after"))
    return `GitHub's secondary rate limit stopped this call. Wait ${Number.isFinite(wait) && wait > 0 ? `${wait} seconds` : "a minute"}, then try again, and make fewer calls at once.`
  }
  // An organization's SAML single sign-on, which the sign-in has not passed yet.
  const sso = response.headers.get("x-github-sso")
  if (response.status === 403 && sso) {
    const url = ssoUrl(sso, deps.endpoints)
    return `The organization requires SAML single sign-on for this sign-in. ${url ? `Open ${url} to authorize it` : "Authorize it for the organization on GitHub"}, then try again.`
  }
  // A GitHub App user token: GitHub Apps have permissions and installations, not OAuth scopes. Its wording is only for
  // the 403s about them: GitHub's "not accessible by integration", or one that names the permission it accepts.
  const app = isAppToken(deps.token)
  const owner = ownerOf(path)
  if (response.status === 403 && (said(/not accessible by integration/i) || (app && response.headers.has("x-accepted-github-permissions")))) {
    const needed = acceptedPermissions(response.headers.get("x-accepted-github-permissions"))
    const what = needed.length > 0 ? `the permission ${needed.join(" or ")}` : "a permission this endpoint needs"
    return `The GitHub App you signed in with lacks ${what}, or is not installed on ${owner ?? "that account or organization"}. ${installStep(deps.endpoints, deps.appSlug)}, or ask its owner to add the permission.`
  }
  const accepted = scopes(response.headers.get("x-accepted-oauth-scopes"))
  const granted = scopes(response.headers.get("x-oauth-scopes"))
  if (response.status === 403 && !app && accepted.length > 0 && !accepted.some((scope) => granted.includes(scope))) {
    const scope = accepted.join(" or ")
    // The scopes option only shapes device sign-in; a pasted token carries the scopes it was created with.
    return deps.deviceSignIn
      ? `The sign-in lacks the scope ${scope}. Add it to the plugin option scopes, then run /connect and choose ${deps.service} to sign in again.`
      : `The token lacks the scope ${scope}. Create a token with it on GitHub (Settings, Developer settings, Personal access tokens), then run /connect and choose ${deps.service} to replace it.`
  }
  // A fine-grained token without the permission an endpoint needs. GitHub names it in X-Accepted-GitHub-Permissions.
  if (response.status === 403 && typeof message === "string" && /not accessible by personal access token/i.test(message)) {
    const needed = acceptedPermissions(response.headers.get("x-accepted-github-permissions"))
    const what = needed.length > 0 ? `the fine-grained permission ${needed.join(" or ")}` : "a fine-grained permission this endpoint needs"
    const instead = deps.deviceSignIn ? `, or run /connect, choose ${deps.service} and sign in with GitHub instead of a token` : ""
    return `The token lacks ${what}. Add it to the token on GitHub (Settings, Developer settings, Personal access tokens)${instead}.`
  }
  if (response.status === 404 && app) {
    return `GitHub answers 404 for a wrong path, for one the account cannot see, and for a repository the GitHub App you signed in with is not installed on. Check the path; if it is right, the App may not be installed on ${owner ?? "that account or organization"}: ${installStep(deps.endpoints, deps.appSlug).replace(/^I/, "i")}.`
  }
  if (response.status === 404) return `GitHub answers 404 for a wrong path and for one the account cannot see on ${new URL(deps.endpoints.api).host}. Check the path and the account's access.`
  return undefined
}

/** The SAML authorization link in X-GitHub-SSO ("required; url=…"), only when it is on GitHub's own web host. */
function ssoUrl(header: string, endpoints: Endpoints): string | undefined {
  const url = URL.parse(/url=(\S+)/.exec(header)?.[1] ?? "")
  return url && url.protocol === "https:" && url.host === new URL(endpoints.web).host ? url.href : undefined
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

/**
 * The next page, as a REST target on the API base; a link off the API base, or one whose path the plugin would not send
 * as written, ends the pagination silently: the result's `pagination.more` is then false.
 */
function nextLink(response: Response, endpoints: Endpoints): RestTarget | undefined {
  const link = response.headers.get("link")
  const match = link && /<([^>]+)>\s*;\s*rel="next"/.exec(link)
  if (!match) return undefined
  const url = URL.parse(match[1]!)
  return url ? quietly(() => apiTarget(url, "GET", endpoints)) : undefined
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

/** Keeps the inline result under `max`: whole list items where it can, else a cut text. */
function capInline(value: unknown, max: number): { data: unknown; truncated: boolean } {
  const size = (item: unknown) => Buffer.byteLength(typeof item === "string" ? item : (JSON.stringify(item) ?? ""))
  if (size(value) <= max) return { data: value, truncated: false }
  if (typeof value === "string") return { data: Buffer.from(value).subarray(0, max).toString("utf8"), truncated: true }
  const list = listOf(value)
  if (list) {
    const kept: unknown[] = []
    let used = list.key === undefined ? 2 : size({ ...(value as object), [list.key]: [] })
    for (const item of list.items) {
      used += size(item) + 1
      if (used > max) break
      kept.push(item)
    }
    return { data: list.key === undefined ? kept : { ...(value as object), [list.key]: kept }, truncated: true }
  }
  return { data: Buffer.from(JSON.stringify(value)).subarray(0, max).toString("utf8"), truncated: true }
}
