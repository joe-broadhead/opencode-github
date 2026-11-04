import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { RestInput } from "../../src/api/contract.js"
import { MAX_INLINE_BYTES, callGraphql, callRest, projectPath, restTarget } from "../../src/api/request.js"
import { type Endpoints, GITHUB_COM } from "../../src/config.js"

const TOKEN = "gho_" + "t".repeat(36)
const GHES: Endpoints = {
  web: "https://ghe.example.com",
  api: "https://ghe.example.com/api/v3",
  graphql: "https://ghe.example.com/api/graphql",
  uploads: "https://ghe.example.com/api/uploads",
}

type Seen = { url: string; method: string; headers: Record<string, string>; body?: unknown; redirect?: string }

/** A fetch that answers each URL from `routes` and records what it was sent. */
function fakeFetch(routes: Record<string, (seen: Seen) => Response | Response[]>) {
  const seen: Seen[] = []
  const queues = new Map<string, Response[]>()
  const fetch = async (url: string, init: RequestInit) => {
    const request: Seen = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    }
    seen.push(request)
    const route = routes[url]
    if (!route) throw new TypeError(`fetch failed: no route for ${url}`)
    if (!queues.has(url)) {
      const answer = route(request)
      queues.set(url, Array.isArray(answer) ? answer : [answer])
    }
    const queue = queues.get(url)!
    return queue.length > 1 ? queue.shift()! : queue[0]!.clone()
  }
  return { fetch, seen }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json; charset=utf-8", ...(init.headers as object) } })
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })
const rest = (input: Partial<RestInput> & Pick<RestInput, "method" | "path">): RestInput => input as RestInput

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "github-api-test-")))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** The redirect checks callRest asked for, in order; a resource in `refuse` is refused, as a deny would be. */
let checked: string[] = []
let refuse = new Set<string>()
beforeEach(() => {
  checked = []
  refuse = new Set()
})
const checkRedirect = async (resource: string) => {
  checked.push(resource)
  if (refuse.has(resource)) throw new Error(`refused ${resource}`)
}
const deps = (fetch: ReturnType<typeof fakeFetch>["fetch"], endpoints: Endpoints = GITHUB_COM) => ({ token: TOKEN, endpoints, service: "GitHub", fetch, root, checkRedirect })

describe("restTarget pins requests to the API host", () => {
  it.each([
    ["a full URL", "https://evil.example/repos"],
    ["a scheme-relative URL", "//evil.example/repos"],
    ["no leading slash", "repos/o/r"],
    ["a .. segment", "/repos/../user"],
    ["an encoded .. segment", "/repos/%2e%2e/user"],
    ["a backslash", "/repos\\o"],
    ["whitespace", "/repos/o r"],
    ["a fragment", "/repos#x"],
    ["a control character", "/repos/\u0000"],
  ])("refuses %s", (_name, path) => {
    expect(() => restTarget(rest({ method: "GET", path }), GITHUB_COM)).toThrow(/^API_PATH_INVALID: /)
  })

  // QA GITHUB-1: the URL parser reads all of these as dot segments, so the path sent was not the path checked.
  const DOT_BYPASSES = [
    "/repos/OWNER/REPO/pulls/1/.%2e/.%2e/.%2e/.%2e/OTHER/PROD/pulls/9/merge",
    "/repos/OWNER/x/%2E./%2e./.%2E/user/repos",
    "/repos/OWNER/x/.%2e/.%2e/OTHER/y/hooks",
    "/repos/OWNER/x/%2e/OTHER",
    "/repos/OWNER/x/%2E",
    "/repos/OWNER/x/%2e%2E/y",
    "/repos/OWNER/x/%2E%2e",
    "/repos/OWNER/x/%252e%252e/y",
    "/repos/OWNER/x/%25252E%25252E/y",
    "/repos/OWNER/x/.%252e/y",
    "/repos/OWNER/x/..%2fOTHER/y",
    "/repos/OWNER/x/%2e%2e%5cOTHER",
    "/repos/OWNER/x/a%2f..%2f..",
    "/repos/OWNER/x/.",
    "/repos/OWNER/x/../y",
  ]
  it.each(DOT_BYPASSES.flatMap((path) => ["github.com", "host"].flatMap((on) => ["api", "uploads"].map((base) => [path, on, base] as const))))(
    "refuses the dot segment in %s (%s, %s base)",
    (path, on, base) => {
      const upload = base === "uploads" ? { upload: { path: "a.zip", contentType: "application/zip" } } : {}
      const input = rest({ method: base === "uploads" ? "POST" : "PUT", path, ...upload })
      expect(() => restTarget(input, on === "host" ? GHES : GITHUB_COM)).toThrow(/^API_PATH_INVALID: .* has a \. or \.\. segment\./)
    },
  )

  it("refuses an encoded plain character, which GitHub would read as itself", () => {
    for (const path of ["/repos/OWNER/pr%6Fd/hooks", "/repos/OWNER/x/%2D", "/repos/o/r/branches/release%2B1", "/user%40x", "/graphq%6C"]) {
      expect(() => restTarget(rest({ method: "DELETE", path }), GITHUB_COM)).toThrow(/^API_PATH_INVALID: .* percent-encodes /)
    }
  })

  it("sends exactly the path it names: encodings in upper case, the URL parser's own encodings done first", () => {
    for (const [path, sent] of [
      ["/repos/o/r/environments/a%2fb", "/repos/o/r/environments/a%2Fb"],
      ["/repos/o/r/branches/caf%c3%a9", "/repos/o/r/branches/caf%C3%A9"],
      ["/repos/o/r/branches/café", "/repos/o/r/branches/caf%C3%A9"],
      ["/repos/o/r/contents/a^b{c}", "/repos/o/r/contents/a%5Eb%7Bc%7D"],
      ["/repos/o/r/contents/.github/x...y", "/repos/o/r/contents/.github/x...y"],
      ["/repos/o/r/git/refs/heads/a!$&'()*+,;=:@~", "/repos/o/r/git/refs/heads/a!$&'()*+,;=:@~"],
    ] as const) {
      for (const endpoints of [GITHUB_COM, GHES]) {
        const target = restTarget(rest({ method: "PUT", path }), endpoints)
        expect(target.resource).toBe(`PUT ${sent}`)
        expect(target.path).toBe(sent)
        expect(target.url.pathname).toBe(`${new URL(endpoints.api).pathname.replace(/\/$/, "")}${sent}`)
      }
    }
  })

  // QA GITHUB-1 follow-up: GitHub reads owner and repo names without regard to case, so the resource does too.
  it("names the resource with owner, repo and other case-insensitive names in lower case, and sends the path as written", () => {
    for (const [path, resource] of [
      ["/repos/Owner/Prod/pulls/1/merge", "/repos/owner/prod/pulls/1/merge"],
      ["/repos/OWNER/REPO/branches/Main/protection", "/repos/owner/repo/branches/Main/protection"],
      ["/orgs/Acme/teams/Core-Team/repos/Acme/Site", "/orgs/acme/teams/core-team/repos/acme/site"],
      ["/orgs/Acme/members/Octo-Cat", "/orgs/acme/members/octo-cat"],
      ["/users/Octo/repos", "/users/octo/repos"],
      ["/user/following/Octo", "/user/following/octo"],
      ["/repos/O/R/collaborators/Someone/permission", "/repos/o/r/collaborators/someone/permission"],
      ["/repos/O/R/environments/Production/secrets/API_KEY", "/repos/o/r/environments/production/secrets/api_key"],
      ["/orgs/Acme/actions/variables/Region", "/orgs/acme/actions/variables/region"],
      ["/repos/O/R/labels/Bug%20Fix", "/repos/o/r/labels/bug%20fix"],
      ["/repos/O/R/issues/3/labels/Bug", "/repos/o/r/issues/3/labels/bug"],
      ["/enterprises/Big/actions/runners", "/enterprises/big/actions/runners"],
      ["/repos/O/R/contents/README.md", "/repos/o/r/contents/README.md"],
      ["/repos/O/R/git/refs/heads/Feature", "/repos/o/r/git/refs/heads/Feature"],
      ["/markdown", "/markdown"],
    ] as const) {
      const target = restTarget(rest({ method: "DELETE", path }), GITHUB_COM)
      expect(target.resource).toBe(`DELETE ${resource}`)
      expect(target.path).toBe(path)
      expect(target.url.pathname).toBe(path)
    }
  })

  it("keeps every ? after the first in the query", () => {
    expect(restTarget(rest({ method: "GET", path: "/search/code?q=a?b" }), GITHUB_COM).url.href).toBe("https://api.github.com/search/code?q=a%3Fb")
  })

  it("refuses /graphql through method and path", () => {
    expect(() => restTarget(rest({ method: "POST", path: "/graphql" }), GITHUB_COM)).toThrow(/^API_GRAPHQL_PATH: .* Next step: Pass \{ graphql/)
  })

  it("joins the path to the base, merges the query, and names the resource without the query", () => {
    const target = restTarget(rest({ method: "GET", path: "/repos/o/r/issues?state=open", query: { per_page: 5, labels: ["a", "b"] } }), GITHUB_COM)
    expect(target.url.href).toBe("https://api.github.com/repos/o/r/issues?state=open&per_page=5&labels=a&labels=b")
    expect(target.resource).toBe("GET /repos/o/r/issues")
  })

  it("keeps a GitHub Enterprise Server API path, and sends uploads to the uploads base", () => {
    expect(restTarget(rest({ method: "GET", path: "/user" }), GHES).url.href).toBe("https://ghe.example.com/api/v3/user")
    const upload = rest({ method: "POST", path: "/repos/o/r/releases/1/assets?name=a.zip", upload: { path: "a.zip", contentType: "application/zip" } })
    expect(restTarget(upload, GITHUB_COM).url.href).toBe("https://uploads.github.com/repos/o/r/releases/1/assets?name=a.zip")
    expect(restTarget(upload, GHES).url.href).toBe("https://ghe.example.com/api/uploads/repos/o/r/releases/1/assets?name=a.zip")
  })
})

describe("callRest", () => {
  it("sends the token and API version only to the API host, with manual redirects", async () => {
    const { fetch, seen } = fakeFetch({ "https://api.github.com/user": () => json({ login: "octocat" }, { headers: rateHeaders(4999) }) })
    const input = rest({ method: "GET", path: "/user" })
    const output = await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))
    expect(output).toMatchObject({ ok: true, status: 200, data: { login: "octocat" }, truncated: false, trust: { githubContent: "untrusted" } })
    expect(output.rateLimit).toEqual({ limit: 5000, remaining: 4999, resetAt: "2026-10-31T00:00:00.000Z" })
    expect(seen[0]).toMatchObject({ redirect: "manual", headers: { authorization: `Bearer ${TOKEN}`, "x-github-api-version": "2022-11-28", accept: "application/vnd.github+json" } })
  })

  // QA GITHUB-1 follow-up: a redirect never takes a call past the rules that checked it.
  it("follows a read's redirect within the API only after the permission check passes for the new path", async () => {
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/repos/Old/Name/pulls": () => redirect("/repositories/10/pulls?state=all", 301),
      "https://api.github.com/repositories/10/pulls?state=all": () => json([{ number: 1 }]),
    })
    const moved = rest({ method: "GET", path: "/repos/Old/Name/pulls" })
    expect(await callRest(moved, restTarget(moved, GITHUB_COM), deps(fetch))).toMatchObject({ ok: true, data: [{ number: 1 }] })
    expect(checked).toEqual(["GET /repositories/10/pulls"])
    expect(seen.at(-1)).toMatchObject({ url: "https://api.github.com/repositories/10/pulls?state=all", headers: { authorization: `Bearer ${TOKEN}` } })

    refuse.add("GET /repositories/10/pulls")
    const before = seen.length
    await expect(callRest(moved, restTarget(moved, GITHUB_COM), deps(fetch))).rejects.toThrow("refused GET /repositories/10/pulls")
    expect(seen.slice(before).map((request) => request.url)).toEqual(["https://api.github.com/repos/Old/Name/pulls"])
  })

  it("checks a GitHub Enterprise Server redirect as a path on its API base, in lower case, and refuses one outside it", async () => {
    const { fetch } = fakeFetch({
      "https://ghe.example.com/api/v3/repos/a/b": () => redirect("https://ghe.example.com/api/v3/repos/Other/Prod"),
      "https://ghe.example.com/api/v3/repos/Other/Prod": () => json({ id: 1 }),
      "https://ghe.example.com/api/v3/repos/c/d": () => redirect("https://ghe.example.com/admin/x"),
    })
    const moved = rest({ method: "GET", path: "/repos/a/b" })
    await callRest(moved, restTarget(moved, GHES), deps(fetch, GHES))
    expect(checked).toEqual(["GET /repos/other/prod"])
    const outside = rest({ method: "GET", path: "/repos/c/d" })
    await expect(callRest(outside, restTarget(outside, GHES), deps(fetch, GHES))).rejects.toThrow(/^API_REDIRECT_OFF_HOST: /)
  })

  it("refuses a read's redirect to another host, and points to download", async () => {
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/repos/o/r/actions/jobs/1/logs": () => redirect("https://blob.example.net/logs/1?sig=x"),
    })
    const logs = rest({ method: "GET", path: "/repos/o/r/actions/jobs/1/logs" })
    await expect(callRest(logs, restTarget(logs, GITHUB_COM), deps(fetch))).rejects.toThrow(
      "API_REDIRECT_OFF_HOST: GitHub redirected GET /repos/o/r/actions/jobs/1/logs outside its API, to blob.example.net, and a read follows redirects only within the API. Next step: Pass download: { path } to save the response; a download follows GitHub's storage redirects, without the token.",
    )
    expect(seen).toHaveLength(1)
  })

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("never follows a redirect for %s, and names the new path", async (method) => {
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/repos/Old/Name/pulls/1/merge": () => redirect("/repositories/10/pulls/1/merge", 307),
      "https://api.github.com/repos/o/r/x": () => redirect("https://evil.example/x?sig=s", 308),
    })
    const moved = rest({ method, path: "/repos/Old/Name/pulls/1/merge", body: {} })
    await expect(callRest(moved, restTarget(moved, GITHUB_COM), deps(fetch))).rejects.toThrow(
      `API_REDIRECTED: GitHub answered ${method} /repos/old/name/pulls/1/merge with a redirect to /repositories/10/pulls/1/merge, and a change never follows a redirect. Next step: Call github_api again with path /repositories/10/pulls/1/merge, so the change is checked for that path.`,
    )
    const away = rest({ method, path: "/repos/o/r/x" })
    const error = await callRest(away, restTarget(away, GITHUB_COM), deps(fetch)).catch((cause: Error) => cause.message)
    expect(error).toMatch(/^API_REDIRECTED: .* outside its API, to evil\.example, .* Next step: Check the path/)
    expect(error).not.toContain("sig=")
    expect(seen.map((request) => request.url)).toEqual(["https://api.github.com/repos/Old/Name/pulls/1/merge", "https://api.github.com/repos/o/r/x"])
    expect(checked).toEqual([])
  })

  it("never follows a redirect for GraphQL or an upload", async () => {
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "a.zip"), "zip")
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/graphql": () => redirect("/graphql2", 307),
      "https://uploads.github.com/repos/o/r/releases/1/assets?name=a.zip": () => redirect("https://uploads.github.com/repos/p/q/releases/1/assets", 307),
    })
    await expect(callGraphql({ graphql: { query: "{ viewer { login } }" } }, deps(fetch))).rejects.toThrow(/^API_REDIRECTED: GitHub answered POST \/graphql /)
    const upload = rest({ method: "POST", path: "/repos/o/r/releases/1/assets", query: { name: "a.zip" }, upload: { path: "dist/a.zip", contentType: "application/zip" } })
    await expect(callRest(upload, restTarget(upload, GITHUB_COM), deps(fetch))).rejects.toThrow(/^API_REDIRECTED: /)
    expect(seen).toHaveLength(2)
  })

  it("relies on Node's fetch returning a manual redirect with its Location, not following it", async () => {
    const server = createServer((request, response) => {
      response.writeHead(302, { location: "https://blob.example.net/x" }).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address() as { port: number }
      const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", headers: { Authorization: "Bearer x" } })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("https://blob.example.net/x")
    } finally {
      server.close()
    }
  })

  it("refuses a redirect to plain HTTP, and a redirect loop", async () => {
    const { fetch } = fakeFetch({
      "https://api.github.com/a": () => redirect("http://api.github.com/b"),
      "https://api.github.com/loop": () => redirect("/loop"),
    })
    const insecure = rest({ method: "GET", path: "/a" })
    await expect(callRest(insecure, restTarget(insecure, GITHUB_COM), deps(fetch))).rejects.toThrow(/^API_REDIRECT_INSECURE: /)
    const loop = rest({ method: "GET", path: "/loop" })
    await expect(callRest(loop, restTarget(loop, GITHUB_COM), deps(fetch))).rejects.toThrow(/^API_REDIRECT_LOOP: /)
  })

  it("sends a JSON body", async () => {
    const { fetch, seen } = fakeFetch({ "https://api.github.com/repos/o/r/pulls": () => json({ number: 7 }, { status: 201 }) })
    const input = rest({ method: "POST", path: "/repos/o/r/pulls", body: { title: "t", head: "a", base: "main" } })
    const output = await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))
    expect(output.data).toEqual({ number: 7 })
    expect(seen[0]).toMatchObject({ method: "POST", body: JSON.stringify({ title: "t", head: "a", base: "main" }), headers: { "content-type": "application/json" } })
  })

  it("follows Link pages on the API host, joins list objects, and caps items", async () => {
    const page = (n: number, next?: string) =>
      json({ total_count: 5, items: [n * 2 - 1, n * 2] }, { headers: next ? { link: `<${next}>; rel="next", <https://api.github.com/x?page=9>; rel="last"` } : {} })
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/search/issues?q=x": () => page(1, "https://api.github.com/search/issues?q=x&page=2"),
      "https://api.github.com/search/issues?q=x&page=2": () => page(2, "https://api.github.com/search/issues?q=x&page=3"),
      "https://api.github.com/search/issues?q=x&page=3": () => page(3),
    })
    const input = rest({ method: "GET", path: "/search/issues", query: { q: "x" }, paginate: true })
    const all = await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))
    expect(all.data).toEqual({ total_count: 5, items: [1, 2, 3, 4, 5, 6] })
    expect(all.pagination).toEqual({ pages: 3, items: 6, more: false })

    const capped = rest({ ...input, maxItems: 3 })
    expect(await callRest(capped, restTarget(capped, GITHUB_COM), deps(fetch))).toMatchObject({ data: { items: [1, 2, 3] }, pagination: { pages: 2, items: 3, more: true } })
    const onePage = rest({ ...input, maxPages: 1 })
    expect((await callRest(onePage, restTarget(onePage, GITHUB_COM), deps(fetch))).pagination).toEqual({ pages: 1, items: 2, more: true })
    expect(seen.every((request) => request.url.startsWith("https://api.github.com/"))).toBe(true)
  })

  it("stops paginating at a Link to another host", async () => {
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/user/repos": () => json([1, 2], { headers: { link: '<https://evil.example/user/repos?page=2>; rel="next"' } }),
    })
    const input = rest({ method: "GET", path: "/user/repos", paginate: true })
    expect(await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))).toMatchObject({ data: [1, 2], pagination: { pages: 1, items: 2, more: false } })
    expect(seen).toHaveLength(1)
  })

  // GITHUB-R15: on GitHub Enterprise Server the API shares its origin with the web, so a page must stay under the API base path.
  it("stops paginating at a Link outside the GitHub Enterprise Server API base path", async () => {
    const { fetch, seen } = fakeFetch({
      "https://ghe.example.com/api/v3/user/repos": () => json([1, 2], { headers: { link: '<https://ghe.example.com/admin/users?page=2>; rel="next"' } }),
      "https://ghe.example.com/api/v3/orgs": () => json([1], { headers: { link: '<https://ghe.example.com/api/v3x/orgs?page=2>; rel="next"' } }),
      "https://ghe.example.com/api/v3/teams": () => json([1], { headers: { link: '<https://ghe.example.com/api/v3/teams?page=2>; rel="next"' } }),
      "https://ghe.example.com/api/v3/teams?page=2": () => json([2]),
    })
    for (const path of ["/user/repos", "/orgs"]) {
      const input = rest({ method: "GET", path, paginate: true })
      expect((await callRest(input, restTarget(input, GHES), deps(fetch, GHES))).pagination).toMatchObject({ pages: 1, more: false })
    }
    const inside = rest({ method: "GET", path: "/teams", paginate: true })
    expect(await callRest(inside, restTarget(inside, GHES), deps(fetch, GHES))).toMatchObject({ data: [1, 2], pagination: { pages: 2 } })
    expect(seen.map((request) => request.url)).toEqual([
      "https://ghe.example.com/api/v3/user/repos",
      "https://ghe.example.com/api/v3/orgs",
      "https://ghe.example.com/api/v3/teams",
      "https://ghe.example.com/api/v3/teams?page=2",
    ])
  })

  it("cuts a large result to whole items, with a next step", async () => {
    const items = Array.from({ length: 2000 }, (_, index) => ({ id: index, body: "x".repeat(100) }))
    const { fetch } = fakeFetch({ "https://api.github.com/big": () => json(items) })
    const input = rest({ method: "GET", path: "/big" })
    const output = await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))
    expect(output.truncated).toBe(true)
    expect(output.nextStep).toMatch(/Narrow it with query parameters/)
    expect(Buffer.byteLength(JSON.stringify(output.data))).toBeLessThanOrEqual(MAX_INLINE_BYTES)
    expect((output.data as unknown[]).length).toBeGreaterThan(100)
  })

  it("returns diff text, and points binary responses to download", async () => {
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/repos/o/r/pulls/1": () => new Response("diff --git a/x b/x\n", { headers: { "content-type": "application/vnd.github.diff; charset=utf-8" } }),
      "https://api.github.com/repos/o/r/zipball": () => new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "content-type": "application/zip" } }),
    })
    const diff = rest({ method: "GET", path: "/repos/o/r/pulls/1", accept: "diff" })
    expect(await callRest(diff, restTarget(diff, GITHUB_COM), deps(fetch))).toMatchObject({ data: "diff --git a/x b/x\n" })
    expect(seen[0]!.headers.accept).toBe("application/vnd.github.diff")
    const zip = rest({ method: "GET", path: "/repos/o/r/zipball" })
    const output = await callRest(zip, restTarget(zip, GITHUB_COM), deps(fetch))
    expect(output.data).toBeUndefined()
    expect(output.nextStep).toBe("The response is 4 bytes of application/zip; pass download: { path } to save it.")
  })

  it("gives next steps for 401, a missing scope, an exhausted rate limit and a missing fine-grained permission", async () => {
    const { fetch } = fakeFetch({
      "https://api.github.com/a": () => json({ message: "Bad credentials" }, { status: 401 }),
      "https://api.github.com/b": () => json({ message: "Resource not accessible" }, { status: 403, headers: { "x-accepted-oauth-scopes": "workflow", "x-oauth-scopes": "repo, read:org" } }),
      "https://api.github.com/c": () => json({ message: "rate limit" }, { status: 403, headers: rateHeaders(0) }),
      "https://api.github.com/d": () =>
        json({ message: "Resource not accessible by personal access token" }, { status: 403, headers: { "x-accepted-github-permissions": "actions=read" } }),
      "https://api.github.com/e": () => json({ message: "Resource not accessible by personal access token" }, { status: 403 }),
    })
    const call = (path: string) => {
      const input = rest({ method: "GET", path })
      return callRest(input, restTarget(input, GITHUB_COM), deps(fetch))
    }
    expect(await call("/a")).toMatchObject({ ok: false, status: 401, data: { message: "Bad credentials" }, nextStep: expect.stringContaining("Run /connect and choose GitHub") })
    expect((await call("/b")).nextStep).toBe("The sign-in lacks the scope workflow. Add it to the plugin option scopes, then run /connect and choose GitHub to sign in again.")
    expect((await call("/c")).nextStep).toBe("The rate limit is used up. Try again after 2026-10-31T00:00:00.000Z.")
    expect((await call("/d")).nextStep).toBe(
      "The token lacks the fine-grained permission Actions (read). Add it to the token on GitHub (Settings, Developer settings, Personal access tokens).",
    )
    const withDevice = rest({ method: "GET", path: "/d" })
    expect((await callRest(withDevice, restTarget(withDevice, GITHUB_COM), { ...deps(fetch), deviceSignIn: true })).nextStep).toBe(
      "The token lacks the fine-grained permission Actions (read). Add it to the token on GitHub (Settings, Developer settings, Personal access tokens), or run /connect, choose GitHub and sign in with GitHub instead of a token.",
    )
    expect((await call("/e")).nextStep).toMatch(/^The token lacks a fine-grained permission this endpoint needs\./)
  })

  it("reports an unreachable host without the token", async () => {
    const input = rest({ method: "GET", path: "/nowhere" })
    const error = await callRest(input, restTarget(input, GITHUB_COM), deps(fakeFetch({}).fetch)).catch((cause: Error) => cause)
    expect((error as Error).message).toBe("API_UNREACHABLE: Could not reach api.github.com. Next step: Check your network, then try again.")
  })
})

describe("download and upload", () => {
  it("saves a download inside the project with its size and SHA-256, following the asset redirect without the token", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/repos/o/r/actions/artifacts/3/zip": () => redirect("https://blob.example.net/a.zip?sig=x"),
      "https://blob.example.net/a.zip?sig=x": () => new Response(bytes, { headers: { "content-type": "application/zip" } }),
    })
    const input = rest({ method: "GET", path: "/repos/o/r/actions/artifacts/3/zip", download: { path: "out/a.zip" } })
    const output = await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))
    expect(output.download).toEqual({ path: "out/a.zip", bytes: 5, sha256: createHash("sha256").update(bytes).digest("hex") })
    expect(readFileSync(join(root, "out", "a.zip"))).toEqual(Buffer.from(bytes))
    expect(seen[0]!.headers.accept).toBe("application/octet-stream")
    expect(seen[1]!.headers.authorization).toBeUndefined()
    await expect(callRest(input, restTarget(input, GITHUB_COM), deps(fetch))).rejects.toThrow(/^API_FILE_EXISTS: /)
    await callRest({ ...input, download: { path: "out/a.zip", overwrite: true } }, restTarget(input, GITHUB_COM), deps(fetch))
    expect(checked).toEqual([])
  })

  it("checks a download's redirect to another API path first, then follows the storage redirect without the token", async () => {
    const { fetch, seen } = fakeFetch({
      "https://api.github.com/repos/Old/Name/zipball": () => redirect("/repos/new/name/zipball", 301),
      "https://api.github.com/repos/new/name/zipball": () => redirect("https://codeload.example.net/z?sig=x"),
      "https://codeload.example.net/z?sig=x": () => new Response(new Uint8Array([1]), { headers: { "content-type": "application/zip" } }),
    })
    const input = rest({ method: "GET", path: "/repos/Old/Name/zipball", download: { path: "z.zip" } })
    expect((await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))).download?.bytes).toBe(1)
    expect(checked).toEqual(["GET /repos/new/name/zipball"])
    expect(seen.map((request) => Boolean(request.headers.authorization))).toEqual([true, true, false])
  })

  // QA GITHUB-2: a download has a size cap, by its Content-Length and while it streams.
  it("stops a download over the cap and leaves no file behind", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(3))
        },
      })
    // A fresh response per call: a cloned endless stream never finishes cancelling.
    const routes: Record<string, () => Response> = {
      "https://api.github.com/declared": () => new Response(new Uint8Array(5), { headers: { "content-type": "application/zip", "content-length": "5" } }),
      "https://api.github.com/endless": () => new Response(stream(), { headers: { "content-type": "application/zip" } }),
      "https://api.github.com/fits": () => new Response(new Uint8Array(4), { headers: { "content-type": "application/zip", "content-length": "4" } }),
    }
    const capped = { ...deps(async (url: string) => routes[url]!()), maxDownloadBytes: 4 }
    for (const path of ["/declared", "/endless"]) {
      const input = rest({ method: "GET", path, download: { path: `out${path}.zip` } })
      await expect(callRest(input, restTarget(input, GITHUB_COM), capped)).rejects.toThrow(
        "API_DOWNLOAD_TOO_LARGE: The download is over 4 bytes. Next step: Narrow the request, or download it outside OpenCode.",
      )
    }
    const fits = rest({ method: "GET", path: "/fits", download: { path: "out/fits.zip" } })
    expect((await callRest(fits, restTarget(fits, GITHUB_COM), capped)).download?.bytes).toBe(4)
    expect(readdirSync(join(root, "out"))).toEqual(["fits.zip"])
  })

  // QA GITHUB-7: without overwrite, a file that appears while the download runs is kept.
  it("never replaces a file that appeared during the download, unless overwrite is set", async () => {
    const target = join(root, "out", "a.zip")
    const { fetch } = fakeFetch({
      "https://api.github.com/a": () => {
        mkdirSync(join(root, "out"), { recursive: true })
        writeFileSync(target, "theirs")
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/zip" } })
      },
    })
    const input = rest({ method: "GET", path: "/a", download: { path: "out/a.zip" } })
    await expect(callRest(input, restTarget(input, GITHUB_COM), deps(fetch))).rejects.toThrow(/^API_FILE_EXISTS: The file out\/a\.zip already exists\./)
    expect(readFileSync(target, "utf8")).toBe("theirs")
    expect(readdirSync(join(root, "out"))).toEqual(["a.zip"])
    rmSync(target)
    const replace = rest({ method: "GET", path: "/a", download: { path: "out/a.zip", overwrite: true } })
    await callRest(replace, restTarget(replace, GITHUB_COM), deps(fetch))
    expect([...readFileSync(target)]).toEqual([1, 2, 3])
    expect(readdirSync(join(root, "out"))).toEqual(["a.zip"])
  })

  it("keeps files inside the project, also through a symbolic link", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "github-api-outside-")))
    try {
      symlinkSync(outside, join(root, "link"))
      for (const path of ["../x", "/etc/passwd", "link/x", "."]) {
        await expect(projectPath(root, path)).rejects.toThrow(/^API_FILE_OUTSIDE_PROJECT: /)
      }
      expect(await projectPath(root, "a/b/c.txt")).toEqual({ absolute: join(root, "a", "b", "c.txt"), relative: "a/b/c.txt" })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("uploads a project file to the uploads host with its content type", async () => {
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "a.zip"), "zip-bytes")
    const { fetch, seen } = fakeFetch({ "https://uploads.github.com/repos/o/r/releases/1/assets?name=a.zip": () => json({ id: 5, state: "uploaded" }, { status: 201 }) })
    const input = rest({ method: "POST", path: "/repos/o/r/releases/1/assets", query: { name: "a.zip" }, upload: { path: "dist/a.zip", contentType: "application/zip" } })
    const output = await callRest(input, restTarget(input, GITHUB_COM), deps(fetch))
    expect(output).toMatchObject({ ok: true, status: 201, data: { id: 5 } })
    expect(seen[0]).toMatchObject({ method: "POST", headers: { "content-type": "application/zip", authorization: `Bearer ${TOKEN}` } })
    expect(Buffer.from(seen[0]!.body as Uint8Array).toString()).toBe("zip-bytes")
  })
})

describe("callGraphql", () => {
  it("posts the document to the GraphQL endpoint, and is not ok when GitHub returns errors", async () => {
    const { fetch, seen } = fakeFetch({
      "https://ghe.example.com/api/graphql": () => json({ data: null, errors: [{ message: "Field 'x' doesn't exist" }] }),
    })
    const output = await callGraphql({ graphql: { query: "{ x }", variables: { a: 1 } } }, deps(fetch, GHES))
    expect(output).toMatchObject({ ok: false, status: 200, data: { errors: [{ message: "Field 'x' doesn't exist" }] } })
    expect(seen[0]).toMatchObject({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ query: "{ x }", variables: { a: 1 } }) })
  })
})

function rateHeaders(remaining: number) {
  return { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(Date.parse("2026-10-31T00:00:00Z") / 1000) }
}
