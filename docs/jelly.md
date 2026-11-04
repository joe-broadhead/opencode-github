# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **GitHub** (`jelly.title`), with the package name and version beneath.

## Tools and permissions

99 tools are declared (61 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: `github_actions_run_trigger`, `github_add_comment_to_pending_review`, `github_add_issue_comment`, `github_add_reply_to_pull_request_comment`, `github_assign_copilot_to_issue`, `github_assign_copilot_to_issue_with_intent`, `github_create_branch`, `github_create_gist`, `github_create_or_update_file`, `github_create_pull_request`, `github_create_pull_request_with_copilot`, `github_create_repository`, `github_create_repository_ruleset`, `github_custom_properties_write`, `github_delete_file`, `github_delete_repository`, `github_discussion_comment_write`, `github_dismiss_notification`, `github_fork_repository`, `github_issue_artifact_write`, `github_issue_write`, `github_label_write`, `github_manage_notification_subscription`, `github_manage_repository_notification_subscription`, `github_mark_all_notifications_read`, `github_merge_pull_request`, `github_projects_write`, `github_pull_request_review_write`, `github_push_files`, `github_request_copilot_review`, `github_star_repository`, `github_sub_issue_write`, `github_unstar_repository`, `github_update_gist`, `github_update_issue_comment`, `github_update_pull_request`, `github_update_pull_request_branch`, `github_api`.
- Off: none.
- Everything else runs, as the plugin's own rules let it.

Declared from `KNOWN_TOOLS` (writes too: they exist only with `readOnly: false`), without the
hidden `ui_get`. That includes `issue_artifact_read` and `issue_artifact_write`, which GitHub lists
only behind a feature flag the plugin does not turn on. `github_api` asks only for a call that
changes GitHub; a GET asserts nothing.

A tool the upstream server adds later is not declared, so in Jelly it is not asked about by
default. Keep `jelly.tools` in step with the known-tool list; `test/unit/jelly.test.ts` checks
each declared effect against the plugin's own default rules, and the list against `KNOWN_TOOLS`.

## Skills

Declared: `github-pr-review`, `github-issue-triage`, `github-code-research`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views and scripts

None: `jelly.views` and `jelly.rpc` are empty.

## Signing in

`jelly.signIns` declares two sign-ins in one group, `github`, so either one connected is enough:

- `github`, for GitHub's remote MCP server `github`. Its integration carries this plugin's methods: the fine-grained
  token (checked with GitHub before it is saved) and, when the `clientId` option is set, the device flow.
- `github-enterprise`, the plugin's own integration for GitHub Enterprise Server. With the `host` option set, the
  plugin registers no MCP server, and this integration carries the same two methods against that server.

Token sign-in is always offered. Device sign-in appears only when you or your organisation set `clientId`; then
Jelly offers it first: it shows the code with Copy code and connects once the person approves, which works from a
web tab too, because nothing returns to a loopback port. With the token, Jelly opens the pre-filled token page, and
the person pastes the token.

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

## Versions

Jelly's curated catalogue pins an exact version. Each release is published under a new version, so a review in
Jelly can tell the two apart.
