// R18: `unknownTools` decides only whether unknown tools are listed. It cannot make one ask — the `github_*` rule and
// `access` decide that — and the docs and the status say exactly that.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { describeTools } from "../../src/rpc.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

const tools = { visible: 27, unknown: ["github_new_a"], mode: "ask" } as const
const hidden = { ...tools, mode: "hide" } as const

describe("unknownTools", () => {
  it("says in the status what the block does with an unknown tool, per access value", () => {
    expect(describeTools({ tools, access: "all" })).toContain("allowed by github_*")
    expect(describeTools({ tools, access: "ask-changes" })).toContain("they ask first")
    expect(describeTools({ tools, access: "read-only" })).toContain("they are denied")
    expect(describeTools({ tools: hidden, access: "all" })).toContain("hidden")
  })

  it("documents that the ask value does not make a tool ask, in the README and the guide", () => {
    for (const file of ["README.md", "docs/configuration.md"] as const) {
      const text = read(file)
      expect({ file, says: /does not\s+make (?:a tool|an unknown tool) ask/.test(text), names: text.includes('`"hide"`') || text.includes('"hide"') }).toEqual({
        file,
        says: true,
        names: true,
      })
    }
  })
})
