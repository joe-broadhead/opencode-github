import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { parseEventsListInput, SourceError } from "@we-the-rebel-alliance/plugin-contract/events"
import { createProvider } from "../../src/provider/client.ts"
import { ACCOUNTS, createFakeGitHub, NOW } from "../support/github-fake.ts"

const work = ACCOUNTS["work"]!
const personal = ACCOUNTS["personal"]!

function setup() {
  const fake = createFakeGitHub()
  return { fake, provider: createProvider({ deviceSignIn: true, fetch: fake.fetch }) }
}

function request(input: Record<string, unknown>) {
  const parsed = parseEventsListInput(input)
  if (!parsed.ok) throw new Error(parsed.problems.join("; "))
  return parsed.value
}

test("a page lists the account's issues, pull request, commit and notification, oldest first", async () => {
  const { provider } = setup()
  const page = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since: "2026-11-01T00:00:00.000Z" }), now: NOW, service: "GitHub" } })
  assert.equal(page.account, "work")
  assert.deepEqual(page.owner, { id: "github:ana-work", label: "ana-work" })
  assert.deepEqual(page.events.map((event) => event.labels[0]), ["issue", "pr", "commit", "discussion"])
  assert.equal(page.more, false)
  assert.equal(page.trust, "untrusted")
  assert.ok(page.cursor.length <= 1024)
  assert.equal(page.events[0]?.source, "github")
})

test("the two aliases read their own accounts, and one's cursor is refused for the other", async () => {
  const { provider } = setup()
  const workPage = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since: "2026-11-01T00:00:00.000Z" }), now: NOW, service: "GitHub" } })
  const personalPage = await provider.page({ credential: personal, request: { alias: "personal", login: personal.login, request: request({ since: "2026-11-01T00:00:00.000Z" }), now: NOW, service: "GitHub" } })
  assert.ok(workPage.events.every((event) => event.account === "work"))
  assert.ok(personalPage.events.every((event) => event.account === "personal"))
  assert.notDeepEqual(workPage.events.map((event) => event.external_id), personalPage.events.map((event) => event.external_id))
  await assert.rejects(
    () => provider.page({ credential: personal, request: { alias: "personal", login: personal.login, request: request({ since: "2026-11-01T00:00:00.000Z", cursor: workPage.cursor }), now: NOW, service: "GitHub" } }),
    (error: unknown) => error instanceof SourceError && error.code === "CURSOR_INVALID",
  )
})

test("a page within the window continues from its cursor without repeating an item", async () => {
  const { provider } = setup()
  const first = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since: "2026-11-01T00:00:00.000Z", limit: 2 }), now: NOW, service: "GitHub" } })
  assert.equal(first.events.length, 2)
  assert.equal(first.more, true)
  const second = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ cursor: first.cursor, limit: 2 }), now: NOW, service: "GitHub" } })
  const ids = new Set([...first.events, ...second.events].map((event) => event.external_id))
  assert.equal(ids.size, first.events.length + second.events.length)
  assert.equal(second.more, false)
})

test("two events at the same timestamp across a page boundary are both listed, never skipped", async () => {
  // The twin shares issue #7's updated_at exactly; the cursor must resume after the pair, not after the timestamp.
  const twin = {
    id: 7002,
    number: 9,
    title: "Second queue note",
    body: "The same update time as the first note.",
    state: "open",
    updated_at: "2026-11-20T10:00:00Z",
    html_url: "https://github.com/example/work/issues/9",
    repository_url: "https://api.github.com/repos/example/work",
    user: { login: "ana-work" },
    labels: [],
    assignees: [],
  }
  const fake = createFakeGitHub({ extraWorkIssues: [twin] })
  const provider = createProvider({ deviceSignIn: true, fetch: fake.fetch })
  const first = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since: "2026-11-01T00:00:00.000Z", limit: 1 }), now: NOW, service: "GitHub" } })
  assert.equal(first.events.length, 1)
  assert.equal(first.more, true)
  const second = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ cursor: first.cursor, limit: 1 }), now: NOW, service: "GitHub" } })
  assert.equal(second.events.length, 1)
  const listed = [...first.events, ...second.events].map((event) => event.external_id)
  assert.equal(new Set(listed).size, 2)
  assert.ok(listed.some((id) => id.startsWith("example/work#7@")), listed.join(", "))
  assert.ok(listed.some((id) => id.startsWith("example/work#9@")), listed.join(", "))
})

test("since plus limit: 1, paged to the end with the cursor, returns each matching event exactly once", async () => {
  const { provider } = setup()
  const since = "2026-11-01T00:00:00.000Z"
  const full = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since, limit: 500 }), now: NOW, service: "GitHub" } })
  const expected = full.events.map((event) => event.external_id)
  async function pageThrough(withSince: boolean): Promise<string[]> {
    const ids: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      // The first page names the window; a later page may keep since or rely on the cursor carrying it.
      const held = request({ limit: 1, ...(page === 0 || withSince ? { since } : {}), ...(cursor === undefined ? {} : { cursor }) })
      const answer = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: held, now: NOW, service: "GitHub" } })
      ids.push(...answer.events.map((event) => event.external_id))
      if (!answer.more) return ids
      cursor = answer.cursor
    }
    throw new Error("the paged read did not end")
  }
  // The cursor carries the window: a consumer that drops since after the first page gets the same events once.
  const cursorOnly = await pageThrough(false)
  // Passing since with every page is the same read; it must not repeat an event either.
  const everyPage = await pageThrough(true)
  assert.deepEqual(cursorOnly, expected)
  assert.deepEqual(everyPage, expected)
  assert.equal(new Set(cursorOnly).size, cursorOnly.length)
  assert.equal(new Set(everyPage).size, everyPage.length)
})

test("a window with no item answers an empty page with a cursor", async () => {
  const { provider } = setup()
  const page = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since: "2026-11-24T00:00:00.000Z" }), now: NOW, service: "GitHub" } })
  assert.deepEqual(page.events, [])
  assert.equal(page.more, false)
  assert.ok(page.cursor.length > 0)
})

test("a cursor issued for another GitHub login under the same alias is refused", async () => {
  const { provider } = setup()
  const page = await provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since: "2026-11-01T00:00:00.000Z" }), now: NOW, service: "GitHub" } })
  await assert.rejects(
    () => provider.page({ credential: { ...work, login: "someone-else" }, request: { alias: "work", login: "someone-else", request: request({ cursor: page.cursor }), now: NOW, service: "GitHub" } }),
    (error: unknown) => error instanceof SourceError && error.code === "CURSOR_INVALID",
  )
})

test("a revoked token is NEEDS_SIGN_IN, for a page and for a probe", async () => {
  const { fake, provider } = setup()
  fake.revoke("ana-work")
  await assert.rejects(
    () => provider.page({ credential: work, request: { alias: "work", login: work.login, request: request({ since: "2026-11-01T00:00:00.000Z" }), now: NOW, service: "GitHub" } }),
    (error: unknown) => error instanceof SourceError && error.code === "NEEDS_SIGN_IN",
  )
  await assert.rejects(
    () => provider.probe({ credential: work, request: { alias: "work", login: work.login, service: "GitHub" } }),
    (error: unknown) => error instanceof SourceError && error.code === "NEEDS_SIGN_IN",
  )
})

test("a probe reads the owner, with one GET /user and no content", async () => {
  const { fake, provider } = setup()
  const answer = await provider.probe({ credential: work, request: { alias: "work", login: work.login, service: "GitHub" } })
  assert.deepEqual(answer, { source: "github", account: "work", owner: { id: "github:ana-work", label: "ana-work" }, trust: "untrusted" })
  assert.deepEqual(fake.calls, ["GET /user"])
})

test("an Enterprise credential names the owner with its host and reads the host's endpoints", async () => {
  const { fake, provider } = setup()
  const enterprise = { token: work.token, login: work.login, host: "github.example.com" }
  const answer = await provider.probe({ credential: enterprise, request: { alias: "work", login: work.login, host: "github.example.com", service: "GitHub Enterprise" } })
  assert.deepEqual(answer.owner, { id: "github:ana-work@github.example.com", label: "ana-work (github.example.com)" })
  assert.deepEqual(fake.calls, ["GET /user"])
})

test("api reads with GET and reports no change", async () => {
  const { provider } = setup()
  const answer = await provider.api({ credential: work, input: { method: "GET", path: "/repos/example/work/issues", query: { per_page: 1 } }, root: process.cwd() })
  assert.equal(answer.changed, false)
  assert.equal(answer.output.status, 200)
  assert.equal(answer.output.ok, true)
  assert.equal(answer.output.truncated, false)
  assert.equal(answer.output.trust, "untrusted")
  assert.ok(Array.isArray(answer.output.data))
})

test("api writes with POST and reports the change", async () => {
  const { provider } = setup()
  const answer = await provider.api({ credential: work, input: { method: "POST", path: "/repos/example/work/issues", body: { title: "A test issue" } }, root: process.cwd() })
  assert.equal(answer.changed, true)
  assert.equal(answer.output.status, 201)
  assert.deepEqual(answer.output.data, { number: 9, title: "Created by a test" })
})

test("a paginated read joins the pages and says whether more remain", async () => {
  const { provider } = setup()
  const answer = await provider.api({ credential: work, input: { method: "GET", path: "/repos/example/work/issues", query: { per_page: 1 }, paginate: true }, root: process.cwd() })
  assert.equal(answer.output.pagination?.pages, 2)
  assert.equal(answer.output.pagination?.items, 2)
  assert.equal(answer.output.pagination?.more, false)
})

test("a GraphQL query reads and a mutation changes", async () => {
  const { provider } = setup()
  const read = await provider.api({ credential: work, input: { graphql: { query: "query { viewer { login } }" } }, root: process.cwd() })
  assert.equal(read.changed, false)
  const write = await provider.api({ credential: work, input: { graphql: { query: "mutation { addStar(input: {}) { clientMutationId } }" } }, root: process.cwd() })
  assert.equal(write.changed, true)
})

test("a 4xx is a result with ok: false, and its next step says what GitHub means", async () => {
  const { provider } = setup()
  const answer = await provider.api({ credential: work, input: { method: "GET", path: "/repos/example/work/missing" }, root: process.cwd() })
  assert.equal(answer.output.ok, false)
  assert.equal(answer.output.status, 404)
  assert.match(answer.output.nextStep ?? "", /404/)
})

test("a path that could leave the API is INPUT_INVALID", async () => {
  const { provider } = setup()
  for (const path of ["https://elsewhere.example/x", "//elsewhere/x", "/repos/../x", "/repos/%2e%2e/x", "/graphql"]) {
    await assert.rejects(
      () => provider.api({ credential: work, input: { method: "GET", path }, root: process.cwd() }),
      (error: unknown) => error instanceof SourceError && error.code === "INPUT_INVALID",
      path,
    )
  }
})

test("a download writes a file inside the project, hashes it, and refuses to overwrite", async () => {
  const { provider } = setup()
  const root = await mkdtemp(join(tmpdir(), "github-download-"))
  try {
    const answer = await provider.api({ credential: work, input: { method: "GET", path: "/repos/example/work/releases/assets/1", download: { path: "assets/release.bin" } }, root })
    assert.equal(answer.output.download?.bytes, "fixture bytes".length)
    assert.equal(answer.output.download?.sha256, createHash("sha256").update("fixture bytes").digest("hex"))
    assert.equal(await readFile(join(root, "assets", "release.bin"), "utf8"), "fixture bytes")
    await assert.rejects(
      () => provider.api({ credential: work, input: { method: "GET", path: "/repos/example/work/releases/assets/1", download: { path: "assets/release.bin" } }, root }),
      (error: unknown) => error instanceof SourceError && error.code === "INPUT_INVALID",
    )
    const replaced = await provider.api({ credential: work, input: { method: "GET", path: "/repos/example/work/releases/assets/1", download: { path: "assets/release.bin", overwrite: true } }, root })
    assert.equal(replaced.output.download?.path, "assets/release.bin")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a download outside the project is refused before a request", async () => {
  const { fake, provider } = setup()
  const root = await mkdtemp(join(tmpdir(), "github-download-"))
  try {
    await assert.rejects(
      () => provider.api({ credential: work, input: { method: "GET", path: "/repos/example/work/releases/assets/1", download: { path: "../outside.bin" } }, root }),
      (error: unknown) => error instanceof SourceError && error.code === "INPUT_INVALID",
    )
    assert.deepEqual(fake.calls, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an upload sends a project file as the body and changes GitHub", async () => {
  const { provider } = setup()
  const root = await mkdtemp(join(tmpdir(), "github-upload-"))
  try {
    await writeFile(join(root, "asset.zip"), "zip bytes")
    const answer = await provider.api({ credential: work, input: { method: "POST", path: "/repos/example/work/issues", upload: { path: "asset.zip", contentType: "application/zip" } }, root })
    assert.equal(answer.changed, true)
    assert.equal(answer.output.status, 201)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
