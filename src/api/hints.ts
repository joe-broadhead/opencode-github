// The GitHub tool that covers a github_api read, named in the result's nextStep so the model learns it at the moment
// of use. The call still runs: the hint teaches, it never refuses. A small map of the reads agents sent to github_api
// in the evals, each to a known read in a toolset that is on by default.
import type { Toolset } from "../config.js"
import { toolsetsOf } from "../tools.js"

const REPO = "/repos/[^/]+/[^/]+"

const HINTS: ReadonlyArray<{ readonly path: RegExp; readonly tool: string; readonly method?: string }> = [
  { path: new RegExp(`^${REPO}/pulls$`), tool: "list_pull_requests" },
  { path: new RegExp(`^${REPO}/pulls/\\d+$`), tool: "pull_request_read", method: "get" },
  { path: new RegExp(`^${REPO}/tags$`), tool: "list_tags" },
  { path: new RegExp(`^${REPO}/commits$`), tool: "list_commits" },
  { path: new RegExp(`^${REPO}/commits/[^/]+$`), tool: "get_commit" },
  { path: new RegExp(`^${REPO}/contents(/.*)?$`), tool: "get_file_contents" },
  { path: new RegExp(`^${REPO}/issues$`), tool: "list_issues" },
  { path: new RegExp(`^${REPO}/issues/\\d+$`), tool: "issue_read", method: "get" },
  { path: new RegExp(`^${REPO}/actions/runs$`), tool: "actions_list", method: "list_workflow_runs" },
]

/** The GitHub tool that covers a GET of this path, when its toolset is on; undefined otherwise. */
export function toolFor(method: string, path: string, toolsets: readonly Toolset[]): string | undefined {
  if (method !== "GET") return undefined
  const bare = path.length > 1 ? path.replace(/\/$/, "") : path
  const hint = HINTS.find((entry) => entry.path.test(bare))
  return hint && toolsetsOf(hint.tool).some((toolset) => toolsets.includes(toolset)) ? hint.tool : undefined
}

/** The hint for a working read, naming GitHub's own tool instead of `github_api`. */
export function toolHint(tool: string): string {
  const method = HINTS.find((entry) => entry.tool === tool)?.method
  return `GitHub's ${tool} tool covers this read: call it${method ? ` with method "${method}"` : ""} instead of github_api.`
}
