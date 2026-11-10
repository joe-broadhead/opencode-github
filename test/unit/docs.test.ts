// The docs print what the code does: the generated default block, in full, for every access value, and the tested
// OpenCode releases in every sentence that says something is tested. A change to either cannot leave a doc behind.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { TESTED_HOSTS } from "../../src/host-version.js"
import { defaultRules } from "../../src/permissions.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** The first ```json block that follows the markdown matched by `after`, or `[]` when there is none. */
function blockAfter(text: string, after: string | RegExp): unknown {
  const index = typeof after === "string" ? text.indexOf(after) : (after.exec(text)?.index ?? -1)
  const start = index === -1 ? -1 : text.indexOf("```json", index)
  if (start === -1) return []
  const end = text.indexOf("```", start + 7)
  return end === -1 ? [] : JSON.parse(text.slice(start + 7, end))
}

// R7: an administrator copies these blocks into managed config, so each must be the plugin's real block, in full.
describe("the default rules block", () => {
  const README = read("README.md")
  const CONFIGURATION = read("docs/configuration.md")

  it("the README prints defaultRules(\"all\") in full, and does not elide it", () => {
    const printed = blockAfter(README, 'generated from\n`defaultRules("all")`')
    expect(printed).toEqual(defaultRules("all"))
    const section = /## Permissions([\s\S]*?)### If you have `gh` installed/.exec(README)?.[1] ?? ""
    expect(section).not.toMatch(/\bthe rest of the block\b/)
  })

  it.each(["all", "ask-changes", "read-only"] as const)("the configuration guide prints the %s block in full", (access) => {
    const printed = blockAfter(CONFIGURATION, new RegExp(`^\`access: "${access}"\``, "m"))
    expect(printed).toEqual(defaultRules(access))
  })

  it("every access value's block differs from the others", () => {
    expect(JSON.stringify(defaultRules("all"))).not.toBe(JSON.stringify(defaultRules("ask-changes")))
    expect(JSON.stringify(defaultRules("ask-changes"))).not.toBe(JSON.stringify(defaultRules("read-only")))
  })
})

// R8: a release added to the list cannot leave a stale "tested on …" sentence behind.
describe("tested hosts", () => {
  // The newest release's section: the pending notes until a release, and the latest one after it.
  const NEWEST = /## \[[^\]]+\][^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(read("CHANGELOG.md"))?.[1] ?? ""
  const SOURCES: [string, string][] = [
    ["README.md", read("README.md")],
    ["AGENTS.md", read("AGENTS.md")],
    ["SECURITY.md", read("SECURITY.md")],
    ["docs/configuration.md", read("docs/configuration.md")],
    ["CHANGELOG.md (newest release)", NEWEST],
  ]

  it.each(SOURCES)("%s names exactly TESTED_HOSTS wherever it says what is tested", (file, text) => {
    const mentions = text
      .split("\n")
      .flatMap((line) => line.split(/\.\s+/))
      .filter((sentence) => /\btested\b/i.test(sentence))
      // The supported range is not a tested release: drop a backticked `>=a.b.c <d.e.f` span before reading versions.
      .map((sentence) => sentence.replace(/`[^`]*>=[^`]*`/g, ""))
      .map((sentence) => [...sentence.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((version) => version[0]!))
      .filter((versions) => versions.length > 0)
    for (const versions of mentions) expect({ file, versions: [...new Set(versions)].sort() }).toEqual({ file, versions: [...TESTED_HOSTS].sort() })
  })

  it("the README's Requirements line names every tested release", () => {
    const requirements = /## Requirements([\s\S]*?)## /i.exec(read("README.md"))?.[1] ?? ""
    const named = [...requirements.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((match) => match[0]).filter((version) => version !== "2.3.0")
    expect([...new Set(named)].sort()).toEqual([...TESTED_HOSTS].sort())
  })

  // A release inside the range that ships later is the untested example, so it must be one that never ships.
  it("the untested example is 2.2.99, and no doc names a future release as tested", () => {
    const all = SOURCES.map(([, text]) => text).join("\n")
    expect(all).toContain("2.2.99")
    expect(all).not.toMatch(/\b2\.2\.(?:7|8|9[0-8])\b(?!\d)/)
  })
})
