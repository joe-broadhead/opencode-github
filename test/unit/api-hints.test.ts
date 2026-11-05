import { describe, expect, it } from "vitest"
import { toolHint, toolFor } from "../../src/api/hints.js"
import { DEFAULT_TOOLSETS } from "../../src/config.js"
import { allReadTools, toolsetsOf } from "../../src/tools.js"

// it3: agents read /tags, /commits/{sha} and /pulls with github_api, although GitHub's tools cover them. A hint in the
// result names the tool at the moment of use.
describe("github_api's tool hints", () => {
  it("names the GitHub tool for the reads it covers", () => {
    const cases: Array<[string, string]> = [
      ["/repos/o/r/pulls", "list_pull_requests"],
      ["/repos/o/r/pulls/5", "pull_request_read"],
      ["/repos/o/r/tags", "list_tags"],
      ["/repos/o/r/commits", "list_commits"],
      ["/repos/o/r/commits/0123abc", "get_commit"],
      ["/repos/o/r/contents", "get_file_contents"],
      ["/repos/o/r/contents/src/index.ts", "get_file_contents"],
      ["/repos/o/r/issues", "list_issues"],
      ["/repos/o/r/issues/7", "issue_read"],
      ["/repos/o/r/actions/runs", "actions_list"],
      ["/repos/O-1/r.js/tags/", "list_tags"],
    ]
    for (const [path, tool] of cases) expect([path, toolFor("GET", path, DEFAULT_TOOLSETS)]).toEqual([path, tool])
  })

  it("names only known reads, each in a toolset that is on by default", () => {
    const tools = ["/repos/o/r/pulls", "/repos/o/r/pulls/5", "/repos/o/r/tags", "/repos/o/r/commits", "/repos/o/r/commits/x", "/repos/o/r/contents", "/repos/o/r/issues", "/repos/o/r/issues/7", "/repos/o/r/actions/runs"].map(
      (path) => toolFor("GET", path, DEFAULT_TOOLSETS)!,
    )
    for (const tool of tools) {
      expect(allReadTools()).toContain(tool)
      expect(toolsetsOf(tool).some((toolset) => DEFAULT_TOOLSETS.includes(toolset))).toBe(true)
    }
  })

  it("names nothing for what no tool covers, for other methods, or for a toolset that is off", () => {
    for (const path of [
      "/repos/o/r",
      "/repos/o/r/compare/v1...main",
      "/repos/o/r/branches/main/protection",
      "/repos/o/r/rulesets",
      "/repos/o/r/commits/abc/check-runs",
      "/repos/o/r/pulls/5/merge",
      "/repos/o/r/issues/7/timeline",
      "/repos/o/r/actions/runs/1",
      "/user",
      "/search/issues",
    ])
      expect([path, toolFor("GET", path, DEFAULT_TOOLSETS)]).toEqual([path, undefined])
    expect(toolFor("HEAD", "/repos/o/r/tags", DEFAULT_TOOLSETS)).toBeUndefined()
    expect(toolFor("POST", "/repos/o/r/issues", DEFAULT_TOOLSETS)).toBeUndefined()
    expect(toolFor("GET", "/repos/o/r/actions/runs", ["repos", "issues"])).toBeUndefined()
    expect(toolFor("GET", "/repos/o/r/tags", ["repos"])).toBe("list_tags")
  })

  it("words the hint for the model and for a script, with the method where a tool needs one", () => {
    expect(toolHint("list_tags", false)).toBe("GitHub's list_tags tool covers this read: call it instead of github_api.")
    expect(toolHint("list_tags", true)).toBe("The list_tags method covers this read: call it instead of api.")
    expect(toolHint("actions_list", false)).toBe(`GitHub's actions_list tool covers this read: call it with method "list_workflow_runs" instead of github_api.`)
    expect(toolHint("pull_request_read", true)).toBe(`The pull_request_read method covers this read: call it with method "get" instead of api.`)
  })
})
