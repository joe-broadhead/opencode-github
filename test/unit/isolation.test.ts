// QA X1 and X7: the tested OpenCode releases are listed once, and isolated hosts never start below a folder that holds
// OpenCode config, which OpenCode's upward search would read.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { TESTED_HOSTS } from "../../src/host-version.js"
import { scratchDir } from "../host/scratch.js"

const REPO = realpathSync(fileURLToPath(new URL("../../", import.meta.url)))
const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("scratchDir", () => {
  it("makes folders under /tmp, whatever TMPDIR says", () => {
    const dir = scratchDir("github-isolation-")
    made.push(dir)
    expect(dir.startsWith(`${realpathSync("/tmp")}/github-isolation-`)).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it.each([".opencode", "opencode.json"])("refuses a folder with %s above it, and leaves nothing behind", (name) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "github-isolation-base-")))
    made.push(base)
    mkdirSync(join(base, "below"))
    if (name === ".opencode") mkdirSync(join(base, name))
    else writeFileSync(join(base, name), "{}")
    expect(() => scratchDir("x-", join(base, "below"))).toThrow(`${join(base, name)} is above the test folder`)
    expect(readdirSync(join(base, "below"))).toEqual([])
  })
})

describe("the tested releases", () => {
  it("are listed once, in src/host-version.ts, and named in the README", () => {
    const files = ["scripts", "test", ".github"].flatMap((dir) =>
      (readdirSync(join(REPO, dir), { recursive: true }) as string[]).map((file) => join(dir, file)).filter((file) => /\.(ts|mjs|yml)$/.test(file)),
    )
    const lists = files.filter((file) => /\[\s*"2\.2\.\d+"\s*,\s*"2\.2\.\d+"/.test(readFileSync(join(REPO, file), "utf8")))
    expect(lists).toEqual(["test/unit/host-version.test.ts"])
    const readme = readFileSync(join(REPO, "README.md"), "utf8")
    expect(readme).toContain(`tested on ${TESTED_HOSTS.slice(0, -1).join(", ")} and ${TESTED_HOSTS.at(-1)}`)
  })
})
