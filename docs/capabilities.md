# Capabilities

Every method, source, action and bus event the manifest declares.

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `api` | admin | optional | `rest.read`, `rest.write`, `graphql.query`, `graphql.mutation`, `download`, `upload` |
| `events_list` | read | optional | `search.issues`, `search.commits`, `notifications.list` |
| `probe` | read | optional | `users.get` |
| `status` | read | none | — |
| `mcp:actions_get` | read | optional | `actions_get` |
| `mcp:actions_list` | read | optional | `actions_list` |
| `mcp:check_dependency_vulnerabilities` | read | optional | `check_dependency_vulnerabilities` |
| `mcp:custom_properties_read` | read | optional | `custom_properties_read` |
| `mcp:get_code_quality_finding` | read | optional | `get_code_quality_finding` |
| `mcp:get_code_scanning_alert` | read | optional | `get_code_scanning_alert` |
| `mcp:get_commit` | read | optional | `get_commit` |
| `mcp:get_copilot_space` | read | optional | `get_copilot_space` |
| `mcp:get_dependabot_alert` | read | optional | `get_dependabot_alert` |
| `mcp:get_discussion` | read | optional | `get_discussion` |
| `mcp:get_discussion_comments` | read | optional | `get_discussion_comments` |
| `mcp:get_file_contents` | read | optional | `get_file_contents` |
| `mcp:get_gist` | read | optional | `get_gist` |
| `mcp:get_global_security_advisory` | read | optional | `get_global_security_advisory` |
| `mcp:get_job_logs` | read | optional | `get_job_logs` |
| `mcp:get_label` | read | optional | `get_label` |
| `mcp:get_latest_release` | read | optional | `get_latest_release` |
| `mcp:get_me` | read | optional | `get_me` |
| `mcp:get_notification_details` | read | optional | `get_notification_details` |
| `mcp:get_release_by_tag` | read | optional | `get_release_by_tag` |
| `mcp:get_repository_tree` | read | optional | `get_repository_tree` |
| `mcp:get_secret_scanning_alert` | read | optional | `get_secret_scanning_alert` |
| `mcp:get_tag` | read | optional | `get_tag` |
| `mcp:get_team_members` | read | optional | `get_team_members` |
| `mcp:get_teams` | read | optional | `get_teams` |
| `mcp:github_support_docs_search` | read | optional | `github_support_docs_search` |
| `mcp:issue_artifact_read` | read | optional | `issue_artifact_read` |
| `mcp:issue_read` | read | optional | `issue_read` |
| `mcp:list_branches` | read | optional | `list_branches` |
| `mcp:list_code_scanning_alerts` | read | optional | `list_code_scanning_alerts` |
| `mcp:list_commits` | read | optional | `list_commits` |
| `mcp:list_copilot_spaces` | read | optional | `list_copilot_spaces` |
| `mcp:list_dependabot_alerts` | read | optional | `list_dependabot_alerts` |
| `mcp:list_discussion_categories` | read | optional | `list_discussion_categories` |
| `mcp:list_discussions` | read | optional | `list_discussions` |
| `mcp:list_gists` | read | optional | `list_gists` |
| `mcp:list_global_security_advisories` | read | optional | `list_global_security_advisories` |
| `mcp:list_issue_fields` | read | optional | `list_issue_fields` |
| `mcp:list_issue_types` | read | optional | `list_issue_types` |
| `mcp:list_issues` | read | optional | `list_issues` |
| `mcp:list_label` | read | optional | `list_label` |
| `mcp:list_notifications` | read | optional | `list_notifications` |
| `mcp:list_org_repository_security_advisories` | read | optional | `list_org_repository_security_advisories` |
| `mcp:list_pull_requests` | read | optional | `list_pull_requests` |
| `mcp:list_releases` | read | optional | `list_releases` |
| `mcp:list_repository_collaborators` | read | optional | `list_repository_collaborators` |
| `mcp:list_repository_security_advisories` | read | optional | `list_repository_security_advisories` |
| `mcp:list_secret_scanning_alerts` | read | optional | `list_secret_scanning_alerts` |
| `mcp:list_starred_repositories` | read | optional | `list_starred_repositories` |
| `mcp:list_tags` | read | optional | `list_tags` |
| `mcp:projects_get` | read | optional | `projects_get` |
| `mcp:projects_list` | read | optional | `projects_list` |
| `mcp:pull_request_read` | read | optional | `pull_request_read` |
| `mcp:repository_ruleset_read` | read | optional | `repository_ruleset_read` |
| `mcp:search_code` | read | optional | `search_code` |
| `mcp:search_commits` | read | optional | `search_commits` |
| `mcp:search_issues` | read | optional | `search_issues` |
| `mcp:search_orgs` | read | optional | `search_orgs` |
| `mcp:search_pull_requests` | read | optional | `search_pull_requests` |
| `mcp:search_repositories` | read | optional | `search_repositories` |
| `mcp:search_users` | read | optional | `search_users` |
| `mcp:actions_run_trigger` | write | optional | `actions_run_trigger` |
| `mcp:add_comment_to_pending_review` | write | optional | `add_comment_to_pending_review` |
| `mcp:add_issue_comment` | send | optional | `add_issue_comment` |
| `mcp:add_reply_to_pull_request_comment` | send | optional | `add_reply_to_pull_request_comment` |
| `mcp:assign_copilot_to_issue` | write | optional | `assign_copilot_to_issue` |
| `mcp:assign_copilot_to_issue_with_intent` | write | optional | `assign_copilot_to_issue_with_intent` |
| `mcp:create_branch` | write | optional | `create_branch` |
| `mcp:create_gist` | write | optional | `create_gist` |
| `mcp:create_or_update_file` | write | optional | `create_or_update_file` |
| `mcp:create_pull_request` | write | optional | `create_pull_request` |
| `mcp:create_pull_request_with_copilot` | write | optional | `create_pull_request_with_copilot` |
| `mcp:create_repository` | write | optional | `create_repository` |
| `mcp:create_repository_ruleset` | admin | optional | `create_repository_ruleset` |
| `mcp:custom_properties_write` | admin | optional | `custom_properties_write` |
| `mcp:delete_file` | delete | optional | `delete_file` |
| `mcp:delete_repository` | delete | optional | `delete_repository` |
| `mcp:discussion_comment_write` | send | optional | `discussion_comment_write` |
| `mcp:dismiss_notification` | write | optional | `dismiss_notification` |
| `mcp:fork_repository` | write | optional | `fork_repository` |
| `mcp:issue_artifact_write` | write | optional | `issue_artifact_write` |
| `mcp:issue_write` | write | optional | `issue_write` |
| `mcp:label_write` | write | optional | `label_write` |
| `mcp:manage_notification_subscription` | write | optional | `manage_notification_subscription` |
| `mcp:manage_repository_notification_subscription` | write | optional | `manage_repository_notification_subscription` |
| `mcp:mark_all_notifications_read` | write | optional | `mark_all_notifications_read` |
| `mcp:merge_pull_request` | write | optional | `merge_pull_request` |
| `mcp:projects_write` | write | optional | `projects_write` |
| `mcp:pull_request_review_write` | send | optional | `pull_request_review_write` |
| `mcp:push_files` | write | optional | `push_files` |
| `mcp:request_copilot_review` | write | optional | `request_copilot_review` |
| `mcp:star_repository` | write | optional | `star_repository` |
| `mcp:sub_issue_write` | write | optional | `sub_issue_write` |
| `mcp:unstar_repository` | write | optional | `unstar_repository` |
| `mcp:update_gist` | write | optional | `update_gist` |
| `mcp:update_issue_comment` | send | optional | `update_issue_comment` |
| `mcp:update_pull_request` | write | optional | `update_pull_request` |
| `mcp:update_pull_request_branch` | write | optional | `update_pull_request_branch` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|
| `github.activity` | events | `event` | `events_list` | free |

### Actions

None.

### Bus events

`rpc.github.changed`, `rpc.github.status`, `rpc.github.account`
<!-- /generated:capabilities -->

## Methods

`status` takes no account and reads no GitHub content. It reports the plugin's version, the OpenCode range, every alias
with its state and owner, the agents whose rules miss the generated ones, and one next step.

`probe` reads the signed-in owner for one alias, with one `GET /user` to confirm the token. It reads no content.

`events_list` is the activity source's read: issue and pull request changes the user is involved in, commits they
authored, and notifications the sign-in may read, merged oldest first with a cursor. The cursor is bound to the plugin,
source, alias and sign-in, so another alias's cursor is `CURSOR_INVALID`.

`api` is GitHub's REST and GraphQL API. It reads with GET and HEAD and the two Markdown renders, and every other request
changes GitHub. A successful change emits `changed`; a read does not. The method declares its whole reach as operations
(`rest.read`, `rest.write`, `graphql.query`, `graphql.mutation`, `download`, `upload`), and the permission gate asserts
them together: a rule for `github.api` covers all of them, and a rule that denies one denies the method. A download writes a file inside the project, at most 2 GB; an
upload sends a project file of at most 100 MB. A 4xx is a result with `ok: false`, not an exception.

## Pass-through MCP tools

The 98 `mcp:<tool>` entries are GitHub's hosted MCP server's own tools. The plugin declares them so the contract and the
access rules know each one's class, but it never registers or proxies them: the server owns the tool. OpenCode names
them `github_<tool>` for `default` and `github-<alias>_<tool>` for any other alias, and a rule for one alias cannot
match another's tool. The tool takes no `account` argument: its server's name is the alias. The manifest's
`accounts: "optional"` on those entries is the inventory's classification of the per-alias server, not a field the
vendor's tool accepts. On a GitHub Enterprise alias there are no MCP tools; `api` is the only method that reaches GitHub.

## Source

`github.activity` is an events source with kind `event`. Its labels say what each item was (`issue`, `pr`, `commit`,
the notification's type) and its state. It is private: it reads repositories the sign-in can see and the person's
notifications. GitHub's API is not billed, so its cost class is `free`; GitHub's rate limits still apply.

## Actions and bus events

The manifest declares no actions: no method here has a plan/commit pair, so there is nothing a person previews before a
commit. A change through `api` asks through the access rules in an agent session. An app with no session has no ask to
answer and no plan to commit, so this plugin offers it no change path: `api` writes are an agent-session operation here.

The plugin emits `changed` after its own write, `status` when its state changes, and `account` when an alias signs in or
needs sign-in.
