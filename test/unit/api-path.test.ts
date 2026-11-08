// QA GITHUB-1: the resource github_api checks must be the path it sends. Random paths, built from
// the pieces that encoding tricks use, go through the registered tool; each call is either refused
// before any permission check or request, or asks for and sends exactly the same path.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { permissionPath } from "../../src/api/names.js"
import { describeCall, registerApiTool } from "../../src/api/tool.js"
import { DEFAULT_TOOLSETS, type Endpoints, GITHUB_COM } from "../../src/config.js"

type Ctx = Parameters<typeof registerApiTool>[0]
const GHES: Endpoints = {
  web: "https://ghe.example.com",
  api: "https://ghe.example.com/api/v3",
  graphql: "https://ghe.example.com/api/graphql",
  uploads: "https://ghe.example.com/api/uploads",
}
const CALL = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }
const PIECES = [
  "repos", "OWNER", "REPO", "pulls", "1", "merge", "user", "x", "", ".", "..", "...", ".github",
  "%2e", "%2E", "%2e%2e", ".%2e", "%2e.", "%2E.", "%252e", "%25252e", "%2f", "%2F", "%5c", "%25", "%41", "%6f", "%2b",
  "é", "%c3%a9", "%C3%A9", "{", "}", "^", "|", "[", "]", "\"", "`", "'", "@", ":", ";", "+", "~", "!",
]

/** A seeded generator, so a failure always reproduces. */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomPath(next: () => number): string {
  const segments = Array.from({ length: 1 + Math.floor(next() * 7) }, () =>
    Array.from({ length: 1 + Math.floor(next() * 3) }, () => PIECES[Math.floor(next() * PIECES.length)]!).join(""),
  )
  // A third start as /repos/<owner>/<repo>, whose names GitHub reads without regard to case.
  if (next() < 0.33) segments.unshift("repos", ["Owner", "OWNER", "owner", "Ow%2Bner"][Math.floor(next() * 4)]!, ["Prod", "prod", "PROD"][Math.floor(next() * 3)]!)
  return `/${segments.join("/")}`
}

let root: string
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "github-api-path-")))
  writeFileSync(join(root, "a.zip"), "zip")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function setUp(endpoints: Endpoints) {
  const asserted: string[] = []
  const sent: string[] = []
  let tool: { execute: (input: unknown, context: unknown) => Promise<unknown> } | undefined
  const ctx = {
    tool: { transform: async (callback: (editor: unknown) => void) => (callback({ add: (value: typeof tool) => (tool = value), namespace: () => {} }), { dispose: async () => {} }) },
    permission: { assert: async (request: { resources: string[] }) => void asserted.push(...request.resources) },
    integration: {
      connection: {
        active: async () => ({ type: "credential", id: "cred_1", label: "octocat", method: "oauth" }),
        resolve: async () => ({ type: "oauth", methodID: "github-token", access: "gho_x", refresh: "", expires: 0 }),
        status: async () => {},
      },
    },
  } as unknown as Ctx
  await registerApiTool(ctx, {
    access: "all",
    readOnly: false,
    endpoints,
    service: "GitHub",
    toolsets: DEFAULT_TOOLSETS,
    root,
    integrationID: () => "mcp_1",
    fetch: async (url) => {
      sent.push(url)
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    },
  })
  return { asserted, sent, execute: (input: unknown) => tool!.execute(input, { ...CALL, signal: AbortSignal.timeout(5000) }) }
}

describe("github_api checks the path it sends", () => {
  for (const [name, endpoints] of [["github.com", GITHUB_COM], ["host", GHES]] as const) {
    it(`for random REST writes and uploads on ${name}`, async () => {
      const next = random(name === "host" ? 2 : 1)
      let refused = 0
      let checked = 0
      let cased = 0
      for (let round = 0; round < 3000; round++) {
        const api = await setUp(endpoints)
        const path = randomPath(next)
        const upload = next() < 0.25
        const method = upload ? "POST" : (["PUT", "POST", "PATCH", "DELETE"] as const)[Math.floor(next() * 4)]!
        const input = { method, path, ...(upload ? { upload: { path: "a.zip", contentType: "application/zip" } } : {}) }
        const result = await api.execute(input).then(() => undefined, (error: Error) => error)
        if (result) {
          expect(result.message, path).toMatch(/^API_(PATH_INVALID|GRAPHQL_PATH|INPUT_INVALID): /)
          expect(api.asserted, path).toEqual([])
          expect(api.sent, path).toEqual([])
          refused++
          continue
        }
        const url = new URL(api.sent[0]!)
        const base = new URL(upload ? endpoints.uploads : endpoints.api)
        expect(url.origin, path).toBe(base.origin)
        const sent = url.pathname.slice(base.pathname.replace(/\/$/, "").length)
        expect(api.asserted, path).toEqual([`${method} ${permissionPath(sent)}`])
        // Only case differs between the resource and the path sent, and owner and repo are always in lower case.
        expect(api.asserted[0]!.toLowerCase(), path).toBe(`${method} ${sent}`.toLowerCase())
        if (sent.startsWith("/repos/")) {
          const [, , owner, repo] = api.asserted[0]!.slice(method.length + 1).split("/")
          expect([owner, repo].map((name) => name?.replace(/%[0-9A-F]{2}/g, "")), path).toEqual([owner, repo].map((name) => name?.replace(/%[0-9A-F]{2}/g, "").toLowerCase()))
          cased++
        }
        // No dot segment reaches GitHub, at any depth of encoding.
        let decoded = url.pathname
        for (let depth = 0; depth < 4; depth++) decoded = decoded.replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        expect(decoded.split(/[/\\]/), path).not.toContain("..")
        expect(decoded.split(/[/\\]/), path).not.toContain(".")
        checked++
      }
      // Both outcomes happen often enough for the property to mean something.
      expect(refused).toBeGreaterThan(300)
      expect(checked).toBeGreaterThan(300)
      expect(cased).toBeGreaterThan(100)
    })
  }

  it("checks a download's path the same way, before its file prompt", async () => {
    const next = random(3)
    for (let round = 0; round < 500; round++) {
      const api = await setUp(GHES)
      const path = randomPath(next)
      const input = { method: "GET", path, download: { path: `out/${round}.bin` } }
      const result = await api.execute(input).then(() => undefined, (error: Error) => error)
      if (result) {
        expect(api.asserted, path).toEqual([])
        expect(api.sent, path).toEqual([])
        continue
      }
      expect(api.asserted).toEqual([`download out/${round}.bin`])
      const described = describeCall(input as never, GHES)
      expect(`GET /api/v3${described.target!.path}`).toBe(`GET ${new URL(api.sent[0]!).pathname}`)
    }
  })

  it("asks for GraphQL as POST /graphql and sends it only to the GraphQL endpoint, on github.com and a host", async () => {
    for (const endpoints of [GITHUB_COM, GHES]) {
      const api = await setUp(endpoints)
      await api.execute({ graphql: { query: "mutation { addStar(input: {}) { clientMutationId } }" } })
      expect(api.asserted).toEqual(["POST /graphql"])
      expect(api.sent).toEqual([endpoints.graphql])
    }
  })
})
