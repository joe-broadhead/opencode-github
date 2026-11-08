// One typed code table, and the docs that must match it exactly. A code that is thrown or returned anywhere must be in
// the table, every code in the table must be raised, and the README's Troubleshooting table, the configuration guide's
// Errors table and the scripting doc's refusal table must not drift from it in either direction.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { PLUGIN_CODES, RPC_CODES } from "../../src/errors.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith(".ts")) out.push(path)
  }
  return out
}

const SOURCES = walk("src")
/** Every SCREAMING_SNAKE code literal in src, wherever it is raised or described, or one that starts a message as `CODE: what happened`. */
const raised = new Set(
  SOURCES.flatMap((file) => [
    ...[...read(file).matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)"/g)].map((match) => match[1]!),
    ...[...read(file).matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+): /g)].map((match) => match[1]!),
  ]),
)
/** The code literals outside the table's own file: a code in the table that nothing raises is dead. */
const raising = SOURCES.filter((file) => file !== "src/errors.ts")
  .map(read)
  .join("\n")

/** The codes in the first cell of a Markdown table row that starts with one, or a row that names several. */
function tableCodes(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1]?.trim() ?? "")
    .filter((cell) => cell.startsWith("`"))
    .flatMap((cell) => [...cell.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)`/g)].map((code) => code[1]!))
}

const TROUBLESHOOTING = /## Troubleshooting([\s\S]*?)## Uninstall/.exec(read("README.md"))?.[1] ?? ""
const CONFIGURATION_ERRORS = /## Errors([\s\S]*?)A script/.exec(read("docs/configuration.md"))?.[1] ?? ""
const SCRIPTING = read("docs/scripting.md")

describe("codes", () => {
  it("every code raised in src is in one of the two tables", () => {
    // ACCOUNT_UNKNOWN comes from the shared tools RPC and exists for per-account servers only; this plugin has none.
    const known = new Set<string>([...PLUGIN_CODES, ...RPC_CODES, "ACCOUNT_UNKNOWN"])
    // Not codes: HTTP methods, JSON Schema and platform names a description quotes, and Node's network errno codes.
    const plain = new Set([
      "GET", "HEAD", "PUT", "PATCH", "DELETE", "POST", "UTC", "JSON", "MCP", "UUID",
      "ENOENT", "EACCES", "EEXIST", "ENOTDIR", "EISDIR", "EPERM", "ENOSPC", "EMFILE",
      "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN",
    ])
    expect([...raised].filter((code) => !known.has(code) && !plain.has(code))).toEqual([])
  })

  it("every code in the plugin's table is raised somewhere", () => {
    expect(PLUGIN_CODES.filter((code) => !raising.includes(`"${code}"`))).toEqual([])
  })

  it("the README's Troubleshooting table lists exactly the plugin's codes", () => {
    expect(tableCodes(TROUBLESHOOTING).sort()).toEqual([...PLUGIN_CODES].sort())
  })

  it("the configuration guide's Errors table lists exactly the plugin's codes", () => {
    expect(tableCodes(CONFIGURATION_ERRORS).sort()).toEqual([...PLUGIN_CODES].sort())
  })

  it("docs/scripting.md lists exactly the tools RPC's codes", () => {
    expect(tableCodes(SCRIPTING).sort()).toEqual([...RPC_CODES].sort())
  })
})
