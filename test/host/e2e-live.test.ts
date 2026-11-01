// npm run e2e without the network. scripts/e2e-live.mjs runs unchanged under Bun, with
// route-preload.mjs sending GitHub's URLs to a fake that offers every catalogued tool of the
// default toolsets. The live run against GitHub is the maintainer's: it needs a real token.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_TOOLSETS } from "../../src/config.js"
import { HIDDEN, KNOWN_TOOLS } from "../../src/tools.js"
import { CONTENT_MARKER, type FakeGitHub, FIXTURE_PAT, startFakeGitHub } from "./fake-github.js"

// The script starts an OpenCode host, which takes several seconds on a busy machine.
setDefaultTimeout(180_000)

const REPO = fileURLToPath(new URL("../../", import.meta.url))
const PRELOAD = fileURLToPath(new URL("./route-preload.mjs", import.meta.url))
const unique = (names: readonly string[]) => [...new Set(names)]
const reads = unique(DEFAULT_TOOLSETS.flatMap((toolset) => KNOWN_TOOLS[toolset].read)).filter((name) => !(HIDDEN as readonly string[]).includes(name))
const writes = unique(DEFAULT_TOOLSETS.flatMap((toolset) => KNOWN_TOOLS[toolset].write))

type Cases = { values: Record<string, unknown>; cases: { tool: string; args: Record<string, unknown> }[] }
const file = JSON.parse(readFileSync(new URL("../e2e/cases.json", import.meta.url), "utf8")) as Cases
/** Values a case uses that the committed file leaves for the maintainer to set. */
const unset = (args: unknown) =>
  unique([...JSON.stringify(args).matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]!).filter((name) => file.values[name] === undefined || file.values[name] === ""))

async function e2e(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--preload", PRELOAD, "scripts/e2e-live.mjs"], {
    cwd: REPO,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr }
}

describe("npm run e2e", () => {
  test("cases.json has one case per catalogued read of the default toolsets, except hidden tools", () => {
    expect(file.cases.map((item) => item.tool).sort()).toEqual([...reads].sort())
  })

  test("exits 2 without a token", async () => {
    expect(await e2e({})).toMatchObject({ code: 2, stdout: "", stderr: expect.stringContaining("GITHUB_E2E_TOKEN is not set.") })
  })

  describe("against the fake GitHub", () => {
    let fake: FakeGitHub
    let run: Awaited<ReturnType<typeof e2e>>
    beforeAll(async () => {
      fake = startFakeGitHub([...reads.map((name) => ({ name, readOnly: true })), ...writes.map((name) => ({ name, readOnly: false }))])
      run = await e2e({ GITHUB_E2E_TOKEN: FIXTURE_PAT, GITHUB_FAKE_ORIGIN: fake.origin })
    })
    afterAll(() => fake?.close())

    test("signs in with the token, runs every configured case once and never a write", () => {
      expect(run.stderr).not.toContain("EXTERNAL_FETCH_BLOCKED")
      expect(fake.requests.some((request) => request.path === "/user" && request.authorized)).toBe(true)
      const configured = file.cases.filter((item) => unset(item.args).length === 0).map((item) => item.tool)
      expect(fake.calls().sort()).toEqual(configured.sort())
      expect(fake.calls().some((name) => writes.includes(name))).toBe(false)
    })

    test("prints one row per case, with no response content or token", () => {
      const rows = run.stdout.trim().split("\n")
      expect(rows[0]).toStartWith("GitHub end-to-end on OpenCode ")
      for (const item of file.cases) {
        const missing = unset(item.args)
        const row = rows.find((line) => line.split(/\s+/)[1] === item.tool)
        if (missing.length === 0) expect(row).toMatch(/^PASS {2}\S+ +\d+ ms$/)
        else expect(row).toEndWith(`set ${missing.map((name) => `values.${name}`).join(", ")} in test/e2e/cases.json`)
      }
      const failed = file.cases.filter((item) => unset(item.args).length > 0).length
      expect(rows.at(-1)).toBe(`${file.cases.length - failed} of ${file.cases.length} passed.`)
      expect(run.code).toBe(failed > 0 ? 1 : 0)
      expect(`${run.stdout}${run.stderr}`).not.toContain(FIXTURE_PAT)
      expect(run.stdout).not.toContain(CONTENT_MARKER)
    })
  })
})
