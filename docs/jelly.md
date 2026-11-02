# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

## Tools and permissions

96 tools are declared (59 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: `github_actions_run_trigger`, `github_add_comment_to_pending_review`, `github_add_issue_comment`, `github_add_reply_to_pull_request_comment`, `github_assign_copilot_to_issue`, `github_assign_copilot_to_issue_with_intent`, `github_create_branch`, `github_create_gist`, `github_create_or_update_file`, `github_create_pull_request`, `github_create_pull_request_with_copilot`, `github_create_repository`, `github_create_repository_ruleset`, `github_custom_properties_write`, `github_delete_file`, `github_delete_repository`, `github_discussion_comment_write`, `github_dismiss_notification`, `github_fork_repository`, `github_issue_write`, `github_label_write`, `github_manage_notification_subscription`, `github_manage_repository_notification_subscription`, `github_mark_all_notifications_read`, `github_merge_pull_request`, `github_projects_write`, `github_pull_request_review_write`, `github_push_files`, `github_request_copilot_review`, `github_star_repository`, `github_sub_issue_write`, `github_unstar_repository`, `github_update_gist`, `github_update_issue_comment`, `github_update_pull_request`, `github_update_pull_request_branch`, `github_api`.
- Off: none.
- Everything else runs, as the plugin's own rules let it.

Declared from `KNOWN_TOOLS` (writes too: they exist only with `readOnly: false`). `github_api` asks only for a call that changes GitHub; a GET asserts nothing.

A tool the upstream server adds later is not declared, so in Jelly it is not asked about by
default. Keep `jelly.tools` in step with the known-tool list; `test/**/jelly.test.ts` checks
each declared effect against the plugin's own default rules.

## Skills

Declared: `github-pr-review`, `github-issue-triage`, `github-code-research`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views

None yet.

## Signing in

OpenCode's integration `GitHub` (a fine-grained token, checked with GitHub before it is saved), feeding GitHub's remote MCP server `github`. Jelly shows the server's card `mcp:github`.

<!-- AUTH-PLACEHOLDER (Jelly rd152): settings and secrets for signing in from Jelly are being
designed by Jelly's auth lane. Until that lands this package declares no `contributes.settings`;
add the auth declarations here and in package.json when that design is agreed. -->
**Not yet declared for Jelly.** How this plugin's sign-in appears in Jelly (desktop and web,
expiry, reconnect and sign-out) is still being designed; this section and
`jelly.contributes.settings` will say it once it is.

## Versions

Jelly's curated catalogue pins an exact version. `latest` is `0.0.0`; publish each release
under a new version so a review in Jelly can tell the two apart.
