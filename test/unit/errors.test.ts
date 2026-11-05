// The documented Errors table and the codes the plugin raises match in both directions (TRIAGE decision 6).
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")

function sources(dir: string): string[] {
  return readdirSync(new URL(`../../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** The codes in the ErrorCode union of src/errors.ts. */
const declared = [...(/type ErrorCode =([^]*?)\n\n/.exec(read("src/errors.ts"))?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]!).sort()

/** The codes in the Errors table of docs/configuration.md. */
const documented = [...read("docs/configuration.md").split(/^## Errors$/m)[1]!.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((match) => match[1]!).sort()

describe("the Errors table", () => {
  it("lists exactly the codes the plugin declares", () => {
    expect(declared.length).toBeGreaterThan(20)
    expect(documented).toEqual(declared)
  })

  it("lists no code the plugin never raises", () => {
    const raising = sources("src")
      .filter((path) => path !== join("src", "errors.ts"))
      .map((path) => read(path))
      .join("\n")
    expect(declared.filter((code) => !raising.includes(`"${code}"`))).toEqual([])
  })
})
