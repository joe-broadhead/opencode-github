// The pack smoke checks the release tarball when PACK_TARBALL names one, and otherwise the package it packs itself.
import { describe, expect, test } from "vitest"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { packSource } from "../../scripts/pack-source.mjs"

interface Call {
  command: string
  args: string[]
  cwd: string
}

/** A `run` that answers each command from `answers` and records every call. */
function fakeRun(answers: Record<string, string>) {
  const calls: Call[] = []
  const run = (command: string, args: string[], cwd: string) => {
    calls.push({ command, args, cwd })
    return answers[command] ?? ""
  }
  return { calls, run }
}

describe("the pack source", () => {
  test("PACK_TARBALL names the release tarball: it is checked as it is, and nothing is packed", () => {
    const dir = realpathSync(mkdtempSync(join("/tmp", "pack-source-")))
    try {
      const file = join(dir, "opencode-github-0.0.0.tgz")
      writeFileSync(file, "tarball")
      const { calls, run } = fakeRun({ tar: "package/package.json\npackage/dist/index.js\npackage/dist/\n" })
      const pack = packSource({ env: { PACK_TARBALL: file }, root: "/repo", scratch: dir, run })
      expect(pack).toEqual({
        path: resolve(file),
        filename: "opencode-github-0.0.0.tgz",
        files: [{ path: "package.json" }, { path: "dist/index.js" }],
        size: 7,
      })
      expect(calls).toEqual([{ command: "tar", args: ["-tzf", resolve(file)], cwd: "/repo" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("without PACK_TARBALL, this checkout is packed with npm pack into the scratch folder", () => {
    const packed = [{ filename: "opencode-github-0.0.0.tgz", files: [{ path: "package.json" }], size: 42 }]
    const { calls, run } = fakeRun({ npm: JSON.stringify(packed) })
    const pack = packSource({ env: {}, root: "/repo", scratch: "/scratch", run })
    expect(pack).toEqual(packed[0])
    expect(calls).toEqual([
      { command: "npm", args: ["pack", "--json", "--ignore-scripts", "--pack-destination", "/scratch"], cwd: "/repo" },
    ])
  })

  test("an empty PACK_TARBALL packs this checkout, as an unset one does", () => {
    const { calls, run } = fakeRun({ npm: JSON.stringify([{ filename: "opencode-github-0.0.0.tgz", files: [], size: 1 }]) })
    packSource({ env: { PACK_TARBALL: "" }, root: "/repo", scratch: "/scratch", run })
    expect(calls.map((call) => call.command)).toEqual(["npm"])
  })

  test("a PACK_TARBALL that names no file is refused before anything is read", () => {
    const { calls, run } = fakeRun({})
    expect(() => packSource({ env: { PACK_TARBALL: "/nonexistent/opencode-github.tgz" }, root: "/repo", scratch: "/scratch", run })).toThrow(
      "PACK_TARBALL names no file",
    )
    expect(calls).toEqual([])
  })
})
