// The known GitHub MCP tools, per toolset, marked read or write. Seeded from the tool
// list in the README of github/github-mcp-server v2.0.3
// (b98d115bbb080e9555466a96656ec4df605aea21), with each tool's readOnlyHint from its
// tool snapshot at that commit. The remote-only tools in copilot, copilot_spaces and
// github_support_docs_search have no snapshot there and are classified by what they do, as is
// check_dependency_vulnerabilities, which the hosted server added to dependabot later (it looks
// up packages in the GitHub Advisory Database and changes nothing).
// `npm run drift` compares this list with the live server and warns about changes.
import type { Plugin } from "@opencode/plugin"
import type { Toolset } from "./config.js"
import { SERVER_NAME } from "./rpc.js"

export const KNOWN_TOOLS = {
  context: { read: ["get_me", "get_team_members", "get_teams", "ui_get"], write: [] },
  actions: { read: ["actions_get", "actions_list", "get_job_logs"], write: ["actions_run_trigger"] },
  code_quality: { read: ["get_code_quality_finding"], write: [] },
  code_security: { read: ["get_code_scanning_alert", "list_code_scanning_alerts"], write: [] },
  copilot: { read: [], write: ["assign_copilot_to_issue", "create_pull_request_with_copilot", "request_copilot_review"] },
  copilot_issue_intents: { read: [], write: ["assign_copilot_to_issue_with_intent"] },
  copilot_spaces: { read: ["get_copilot_space", "list_copilot_spaces"], write: [] },
  dependabot: { read: ["check_dependency_vulnerabilities", "get_dependabot_alert", "list_dependabot_alerts"], write: [] },
  discussions: {
    read: ["get_discussion", "get_discussion_comments", "list_discussion_categories", "list_discussions"],
    write: ["discussion_comment_write"],
  },
  gists: { read: ["get_gist", "list_gists"], write: ["create_gist", "update_gist"] },
  git: { read: ["get_repository_tree"], write: [] },
  github_support_docs_search: { read: ["github_support_docs_search"], write: [] },
  governance: {
    read: ["custom_properties_read", "repository_ruleset_read"],
    write: ["create_repository_ruleset", "custom_properties_write"],
  },
  issues: {
    read: ["get_label", "issue_read", "list_issue_fields", "list_issue_types", "list_issues", "search_issues"],
    write: ["add_issue_comment", "issue_write", "sub_issue_write", "update_issue_comment"],
  },
  labels: { read: ["get_label", "list_label"], write: ["label_write"] },
  notifications: {
    read: ["get_notification_details", "list_notifications"],
    write: [
      "dismiss_notification",
      "manage_notification_subscription",
      "manage_repository_notification_subscription",
      "mark_all_notifications_read",
    ],
  },
  orgs: { read: ["search_orgs"], write: [] },
  projects: { read: ["projects_get", "projects_list"], write: ["projects_write"] },
  pull_requests: {
    read: ["list_pull_requests", "pull_request_read", "search_pull_requests"],
    write: [
      "add_comment_to_pending_review",
      "add_reply_to_pull_request_comment",
      "create_pull_request",
      "merge_pull_request",
      "pull_request_review_write",
      "update_pull_request",
      "update_pull_request_branch",
    ],
  },
  repos: {
    read: [
      "get_commit",
      "get_file_contents",
      "get_latest_release",
      "get_release_by_tag",
      "get_tag",
      "list_branches",
      "list_commits",
      "list_releases",
      "list_repository_collaborators",
      "list_tags",
      "search_code",
      "search_commits",
      "search_repositories",
    ],
    write: [
      "create_branch",
      "create_or_update_file",
      "create_repository",
      "delete_file",
      "delete_repository",
      "fork_repository",
      "push_files",
    ],
  },
  secret_protection: { read: ["get_secret_scanning_alert", "list_secret_scanning_alerts"], write: [] },
  security_advisories: {
    read: [
      "get_global_security_advisory",
      "list_global_security_advisories",
      "list_org_repository_security_advisories",
      "list_repository_security_advisories",
    ],
    write: [],
  },
  stargazers: { read: ["list_starred_repositories"], write: ["star_repository", "unstar_repository"] },
  users: { read: ["search_users"], write: [] },
} as const satisfies Record<Toolset, { readonly read: readonly string[]; readonly write: readonly string[] }>

/**
 * Tools the plugin removes from the agents' tools. ui_get is the MCP Apps data feed for
 * GitHub's own UI: its lists repeat other tools, and two of its methods fail on personal
 * repositories. GitHub's remote server has no header that excludes a tool, so the tool
 * filter removes it.
 */
export const HIDDEN = ["ui_get"] as const

/** MCP tool names are `<server>_<tool>`; this is the prefix for the github server. */
export const TOOL_PREFIX = `${SERVER_NAME}_`
/** The plugin's own github_api tool, which shares the prefix and the Code Mode namespace. */
export const API_TOOL_NAME = "api"
const API_TOOL = `${TOOL_PREFIX}${API_TOOL_NAME}`
/** Entry tools kept in the model's direct tool list when Code Mode is on. */
export const PINNED = ["get_me", "issue_read", "pull_request_read"] as const

const reads = new Set<string>(Object.values(KNOWN_TOOLS).flatMap((toolset) => toolset.read))
const writes = new Set<string>(Object.values(KNOWN_TOOLS).flatMap((toolset) => toolset.write))

const hidden = new Set<string>(HIDDEN)

/** Every catalogued read tool across all toolsets that agents can use, sorted, without the server prefix. */
export function allReadTools(): string[] {
  return [...reads].filter((name) => !hidden.has(name)).sort()
}

/** Whether a GitHub MCP tool name (without the prefix) is a known read or write. */
export function toolKind(name: string): "read" | "write" | undefined {
  if (reads.has(name)) return "read"
  if (writes.has(name)) return "write"
  return undefined
}

type ToolContext = { readonly tool: Pick<Plugin.Context["tool"], "transform"> }

/** The github server's tools that agents can use, and the ones the catalog does not know. */
type ServerTools = { readonly visible: number; readonly unknown: readonly string[] }

/**
 * Watches the github server's MCP tools: removes the hidden ones, counts the rest, records
 * the ones not in the catalog, removes those when `unknownTools` is "hide", and pins the
 * entry tools. A server named github
 * that the user configured is left as it is (`owned()` is false).
 */
export async function registerToolFilter(
  ctx: ToolContext,
  options: { readonly unknownTools: "ask" | "hide"; readonly owned: () => boolean },
): Promise<{ dispose(): Promise<void>; tools(): ServerTools }> {
  let tools: ServerTools = { visible: 0, unknown: [] }
  const registration = await ctx.tool.transform((editor) => {
    const unknown: string[] = []
    let visible = 0
    const owned = options.owned()
    for (const tool of editor.list()) {
      if (!isServerTool(tool)) continue
      const name = tool.id.slice(TOOL_PREFIX.length)
      if (owned && hidden.has(name)) {
        editor.remove(tool.id)
        continue
      }
      visible++
      if (toolKind(name) === undefined) {
        unknown.push(tool.id)
        if (owned && options.unknownTools === "hide") {
          editor.remove(tool.id)
          visible--
        }
      } else if (owned && (PINNED as readonly string[]).includes(name) && tool.options?.codemode !== false) {
        editor.update(tool.id, (item) => {
          item.options = { ...item.options, codemode: true, pinned: true }
        })
      }
    }
    tools = { visible, unknown: unknown.sort() }
  })
  return { dispose: registration.dispose, tools: () => tools }
}

function isServerTool(tool: { readonly id: string; readonly options?: { readonly namespace?: string } }): boolean {
  // The host gives each MCP tool its server name as the Code Mode namespace.
  return tool.id.startsWith(TOOL_PREFIX) && tool.id !== API_TOOL && tool.options?.namespace === SERVER_NAME
}
