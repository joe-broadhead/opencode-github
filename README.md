# GitHub

GitHub's repositories, code, issues, pull requests, Actions and security alerts in OpenCode, through GitHub's hosted
MCP server and its REST and GraphQL API.

The plugin gives each account alias its own GitHub MCP server, so an agent can work in two GitHub accounts at once
without one alias's token reaching the other's tools. On top of the vendor's tools it adds `api` for what they lack,
an `events_list` activity source with a cursor, `probe` and `status`.

## Install

```sh
opencode plugin add github:we-the-rebel-alliance/github-plugin#v0.0.0
```

The first release is `v0.0.0`; a later release pins its own tag. The plugin needs OpenCode `>=2.4.1 <2.5.0`.

## Sign in

Each alias is one GitHub MCP server, named `github` for `default` and `github-<alias>` for any other alias. GitHub's
hosted MCP server has no dynamic client registration, so the plugin replaces its generic OAuth with GitHub's device flow
(an OAuth App or GitHub App client ID) and a fine-grained personal access token. Sign in per alias with `/connect`:

| Alias | MCP server | Sign-in |
|---|---|---|
| `default` | `github` | `/connect`, choose GitHub |
| `work` | `github-work` | `/connect`, choose GitHub (work) |
| `personal` | `github-personal` | `/connect`, choose GitHub (personal) |

Configure the aliases in `opencode.json`:

```json
{ "accounts": { "work": {}, "personal": {} } }
```

A profile's `host` selects a GitHub Enterprise Server instead of github.com. GitHub does not host an MCP server for an
Enterprise Server, so that alias gets an integration of its own under the same name with the same two sign-in methods,
and `api` is its tool:

```json
{ "accounts": { "work": {}, "enterprise": { "host": "github.example.com" } } }
```

Methods that take an account accept `account: "work"` or `account: "enterprise"`. With two aliases and no account, a
call is refused with `ACCOUNT_REQUIRED`; an alias the plugin does not serve is `ACCOUNT_UNKNOWN`.

## Access

`access` is `all` (the default), `ask-changes` or `read-only`. A `read` method runs under every level; any other class
asks under `ask-changes` and is off under `read-only`. The pass-through MCP tools are one rule per alias
(`github-work_*` vs `github-personal_*`), so one alias's rule can never reach another's tool.

`api` is one `admin` method: it can read and change GitHub, and the plugin cannot split one class into a read half and
a change half. It therefore runs under `all` and `ask-changes`, and is off under `read-only` — its reads included. Read
GitHub through the MCP tools when `read-only` is set.

## Capabilities

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

## Errors

<!-- generated:errors -->
| Code | Meaning |
|---|---|
| `NEEDS_SIGN_IN` | the account is not signed in |
| `SCOPE_MISSING` | the call needs a scope the person has not confirmed |
| `ACCOUNT_REQUIRED` | the plugin serves several accounts and the call names none |
| `ACCOUNT_UNKNOWN` | the call names an alias the plugin does not serve |
| `ACCOUNT_MISMATCH` | the item belongs to another account |
| `CURSOR_INVALID` | the cursor is malformed, or belongs to another source, account or scope |
| `CURSOR_EXPIRED` | the provider no longer keeps the history the cursor names |
| `RATE_LIMITED` | the provider asked the plugin to slow down |
| `BUDGET_EXCEEDED` | the read would cost more than the person allows |
| `SOURCE_DISABLED` | the person turned this source or action off |
| `TOO_LARGE` | the answer is larger than the source's maxBytes |
| `INPUT_INVALID` | the input does not match the method's schema |
| `SOURCE_UNKNOWN` | the plugin declares no such source |
| `SCHEMA_VIOLATION` | an answer does not keep the contract's shape |
| `PERMISSION_DENIED` | the person's grant does not cover the call |
| `PLAN_INVALID` | the plan is missing, or belongs to another method |
| `PLAN_USED` | the plan was already used by an earlier commit |
| `GRANT_INVALID` | the action grant did not verify, or was already spent |
| `HOST_UNTESTED` | OpenCode is outside the plugin's tested range |
| `OPTIONS_INVALID` | the plugin's options do not match their schema |
| `UNAVAILABLE` | the provider could not be reached |
<!-- /generated:errors -->

## Docs

- [Capabilities](docs/capabilities.md)
- [Configuration](docs/configuration.md)
- [Accounts](docs/accounts.md)
- [Automations](docs/automations.md)
- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
