# Configuration

Set options in the plugin's entry in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "github:joe-broadhead/opencode-github#v0.0.6",
      "options": {
        "toolsets": ["context", "repos", "issues", "pull_requests"],
        "access": "ask-changes",
        "lockdown": false,
        "unknownTools": "list"
      }
    }
  ]
}
```

Every option is optional. An unknown option or a wrong value
stops the plugin from loading with an error that names the option, for example:

```text
OPTIONS_INVALID: Invalid plugin option "toolset": this option does not exist. Next step: Fix the options for github:joe-broadhead/opencode-github#v0.0.6 in opencode.json.
```

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `toolsets` | every toolset marked "default" below | GitHub toolsets to load, sent as GitHub's `X-MCP-Toolsets` header. At least one, each once, from the [list below](#toolsets). |
| `access` | `"all"` | What the generated default rules allow: `"all"` (every tool runs), `"ask-changes"` (reads run, every change asks) or `"read-only"` (reads run, every change is denied, and GitHub's `X-MCP-Readonly` header turns its own write tools off). See [Permissions](#permissions). |
| `readOnly` | none | Deprecated: `true` means `access: "read-only"` and `false` means `access: "all"`, with a note in status. An explicit `access` wins. |
| `lockdown` | `false` | With `true`, sends GitHub's `X-MCP-Lockdown: true` header. See [`lockdown`](#lockdown). |
| `unknownTools` | `"ask"` | `"list"`, or `"ask"` (the same value), keeps GitHub tools the plugin does not know visible, so the default block's `github_*` rule decides them (allowed at the default `access`). `"hide"` removes them. See [`unknownTools`](#unknowntools). |
| `clientId` | none (token sign-in only) | A GitHub OAuth App or GitHub App for device sign-in; with it `/connect` also offers **Sign in with GitHub**. Letters, digits, `.`, `_` and `-`, up to 100 characters. See [`clientId` and `scopes`](#clientid-and-scopes). |
| `appSlug` | none | The GitHub App's URL name (`github.com/apps/<appSlug>`), for the link that installs it. Lower-case letters, digits and `-`. See [A GitHub App](#a-github-app). |
| `scopes` | `["repo", "read:org"]` | Scopes that device sign-in with an OAuth App asks for, each once; `[]` sends none. A GitHub App ignores them. Tokens are not affected. |
| `allowUntestedHost` | `false` | Load on an OpenCode release outside the supported range `>=2.2.3 <2.4.0`, with a warning in the status. See [`allowUntestedHost`](#allowuntestedhost). |
| `host` | none (github.com) | A GitHub Enterprise Server host name, such as `github.example.com`. See [`host`](#host-github-enterprise-server). |

The MCP server name (`github`) and URL (`https://api.githubcopilot.com/mcp/`) are fixed. Changing an option keeps
the name, so you stay signed in.

## Toolsets

These are the toolsets of GitHub's MCP server, with the tools the plugin knows in each. Read tools run without a
prompt; write tools appear unless `access` is `"read-only"`, and describe their class. Tool names in OpenCode carry the server
prefix, for example `github_get_me`.

The default toolsets are every read-only toolset that the default sign-in scopes (`repo` and `read:org`) cover: CI
runs and logs, code, issues, pull requests, labels, discussions, security alerts and advisories, users and
organisations. `projects`, `gists` and `notifications` need more scopes (`read:project`, `gist`, `notifications`),
so they are off until you add them to `toolsets` and, for device sign-in, to `scopes`.

The plugin hides `ui_get`, the data feed for GitHub's own MCP Apps interface: its lists repeat other tools, and two of
its methods fail on personal repositories. GitHub's server has no way to leave one tool out, so the plugin removes it
from the agents' tools, and the default rules have no allow rule for it.

| Toolset | Read tools | Write tools |
| --- | --- | --- |
| `context` (default) | `get_me`, `get_team_members`, `get_teams`, `ui_get` (hidden) | none |
| `actions` (default) | `actions_get`, `actions_list`, `get_job_logs` | `actions_run_trigger` |
| `code_quality` (default) | `get_code_quality_finding` | none |
| `code_security` (default) | `get_code_scanning_alert`, `list_code_scanning_alerts` | none |
| `copilot` | none | `assign_copilot_to_issue`, `create_pull_request_with_copilot`, `request_copilot_review` |
| `copilot_issue_intents` | none | `assign_copilot_to_issue_with_intent` |
| `copilot_spaces` | `get_copilot_space`, `list_copilot_spaces` | none |
| `dependabot` (default) | `check_dependency_vulnerabilities`, `get_dependabot_alert`, `list_dependabot_alerts` | none |
| `discussions` (default) | `get_discussion`, `get_discussion_comments`, `list_discussion_categories`, `list_discussions` | `discussion_comment_write` |
| `gists` | `get_gist`, `list_gists` | `create_gist`, `update_gist` |
| `git` (default) | `get_repository_tree` | none |
| `github_support_docs_search` | `github_support_docs_search` | none |
| `governance` | `custom_properties_read`, `repository_ruleset_read` | `create_repository_ruleset`, `custom_properties_write` |
| `issues` (default) | `get_label`, `issue_artifact_read`, `issue_read`, `list_issue_fields`, `list_issue_types`, `list_issues`, `search_issues` | `add_issue_comment`, `issue_artifact_write`, `issue_write`, `sub_issue_write`, `update_issue_comment` |
| `labels` (default) | `get_label`, `list_label` | `label_write` |
| `notifications` | `get_notification_details`, `list_notifications` | `dismiss_notification`, `manage_notification_subscription`, `manage_repository_notification_subscription`, `mark_all_notifications_read` |
| `orgs` (default) | `search_orgs` | none |
| `projects` | `projects_get`, `projects_list` | `projects_write` |
| `pull_requests` (default) | `list_pull_requests`, `pull_request_read`, `search_pull_requests` | `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`, `create_pull_request`, `merge_pull_request`, `pull_request_review_write`, `update_pull_request`, `update_pull_request_branch` |
| `repos` (default) | `get_commit`, `get_file_contents`, `get_latest_release`, `get_release_by_tag`, `get_tag`, `list_branches`, `list_commits`, `list_releases`, `list_repository_collaborators`, `list_tags`, `search_code`, `search_commits`, `search_repositories` | `create_branch`, `create_or_update_file`, `create_repository`, `delete_file`, `delete_repository`, `fork_repository`, `push_files` |
| `secret_protection` (default) | `get_secret_scanning_alert`, `list_secret_scanning_alerts` | none |
| `security_advisories` (default) | `get_global_security_advisory`, `list_global_security_advisories`, `list_org_repository_security_advisories`, `list_repository_security_advisories` | none |
| `stargazers` | `list_starred_repositories` | `star_repository`, `unstar_repository` |
| `users` (default) | `search_users` | none |

The catalog follows github-mcp-server v2.1.0. GitHub offers `issue_artifact_read` and `issue_artifact_write` only
behind a feature flag the plugin does not turn on, so they do not appear today. Some toolsets, such as `copilot`, `copilot_spaces` and
`github_support_docs_search`, exist only on GitHub's hosted server, as does `check_dependency_vulnerabilities`, which
looks up a list of packages in the GitHub Advisory Database.

GitHub's tools are available to agents through Code Mode, in the `github` namespace. None are pinned: the skills name
the tool to call, and Code Mode's `search` finds its parameters. None of them is a direct tool.

## Permissions

### The shipped model: default rules per agent

**Every tool is allowed by default.** For every agent whose rules contain OpenCode's base rule
`{ "action": "*", "resource": "*", "effect": "allow" }`, the plugin inserts the block for the `access` option directly
after it. The block is generated from `defaultRules(access)` in `src/permissions.ts`, and each value's block is printed
below in full. There is no permission hook.

`access: "all"` (the default) allows every tool the plugin registers, and any tool GitHub adds later:

```json
[
  {"action":"github_*","resource":"*","effect":"allow"},
  {"action":"github_actions_get","resource":"*","effect":"allow"},
  {"action":"github_actions_list","resource":"*","effect":"allow"},
  {"action":"github_check_dependency_vulnerabilities","resource":"*","effect":"allow"},
  {"action":"github_custom_properties_read","resource":"*","effect":"allow"},
  {"action":"github_get_code_quality_finding","resource":"*","effect":"allow"},
  {"action":"github_get_code_scanning_alert","resource":"*","effect":"allow"},
  {"action":"github_get_commit","resource":"*","effect":"allow"},
  {"action":"github_get_copilot_space","resource":"*","effect":"allow"},
  {"action":"github_get_dependabot_alert","resource":"*","effect":"allow"},
  {"action":"github_get_discussion","resource":"*","effect":"allow"},
  {"action":"github_get_discussion_comments","resource":"*","effect":"allow"},
  {"action":"github_get_file_contents","resource":"*","effect":"allow"},
  {"action":"github_get_gist","resource":"*","effect":"allow"},
  {"action":"github_get_global_security_advisory","resource":"*","effect":"allow"},
  {"action":"github_get_job_logs","resource":"*","effect":"allow"},
  {"action":"github_get_label","resource":"*","effect":"allow"},
  {"action":"github_get_latest_release","resource":"*","effect":"allow"},
  {"action":"github_get_me","resource":"*","effect":"allow"},
  {"action":"github_get_notification_details","resource":"*","effect":"allow"},
  {"action":"github_get_release_by_tag","resource":"*","effect":"allow"},
  {"action":"github_get_repository_tree","resource":"*","effect":"allow"},
  {"action":"github_get_secret_scanning_alert","resource":"*","effect":"allow"},
  {"action":"github_get_tag","resource":"*","effect":"allow"},
  {"action":"github_get_team_members","resource":"*","effect":"allow"},
  {"action":"github_get_teams","resource":"*","effect":"allow"},
  {"action":"github_github_support_docs_search","resource":"*","effect":"allow"},
  {"action":"github_issue_artifact_read","resource":"*","effect":"allow"},
  {"action":"github_issue_read","resource":"*","effect":"allow"},
  {"action":"github_list_branches","resource":"*","effect":"allow"},
  {"action":"github_list_code_scanning_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_commits","resource":"*","effect":"allow"},
  {"action":"github_list_copilot_spaces","resource":"*","effect":"allow"},
  {"action":"github_list_dependabot_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_discussion_categories","resource":"*","effect":"allow"},
  {"action":"github_list_discussions","resource":"*","effect":"allow"},
  {"action":"github_list_gists","resource":"*","effect":"allow"},
  {"action":"github_list_global_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_issue_fields","resource":"*","effect":"allow"},
  {"action":"github_list_issue_types","resource":"*","effect":"allow"},
  {"action":"github_list_issues","resource":"*","effect":"allow"},
  {"action":"github_list_label","resource":"*","effect":"allow"},
  {"action":"github_list_notifications","resource":"*","effect":"allow"},
  {"action":"github_list_org_repository_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_list_releases","resource":"*","effect":"allow"},
  {"action":"github_list_repository_collaborators","resource":"*","effect":"allow"},
  {"action":"github_list_repository_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_secret_scanning_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_starred_repositories","resource":"*","effect":"allow"},
  {"action":"github_list_tags","resource":"*","effect":"allow"},
  {"action":"github_projects_get","resource":"*","effect":"allow"},
  {"action":"github_projects_list","resource":"*","effect":"allow"},
  {"action":"github_pull_request_read","resource":"*","effect":"allow"},
  {"action":"github_repository_ruleset_read","resource":"*","effect":"allow"},
  {"action":"github_search_code","resource":"*","effect":"allow"},
  {"action":"github_search_commits","resource":"*","effect":"allow"},
  {"action":"github_search_issues","resource":"*","effect":"allow"},
  {"action":"github_search_orgs","resource":"*","effect":"allow"},
  {"action":"github_search_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_search_repositories","resource":"*","effect":"allow"},
  {"action":"github_search_users","resource":"*","effect":"allow"},
  {"action":"github_events_list","resource":"*","effect":"allow"},
  {"action":"github_probe","resource":"*","effect":"allow"},
  {"action":"github_api","resource":"GET *","effect":"allow"},
  {"action":"github_api","resource":"HEAD *","effect":"allow"},
  {"action":"github_api","resource":"POST /markdown","effect":"allow"},
  {"action":"github_api","resource":"POST /markdown/raw","effect":"allow"},
  {"action":"github_api","resource":"QUERY /graphql","effect":"allow"},
  {"action":"github_actions_run_trigger","resource":"*","effect":"allow"},
  {"action":"github_add_comment_to_pending_review","resource":"*","effect":"allow"},
  {"action":"github_add_issue_comment","resource":"*","effect":"allow"},
  {"action":"github_add_reply_to_pull_request_comment","resource":"*","effect":"allow"},
  {"action":"github_assign_copilot_to_issue","resource":"*","effect":"allow"},
  {"action":"github_assign_copilot_to_issue_with_intent","resource":"*","effect":"allow"},
  {"action":"github_create_branch","resource":"*","effect":"allow"},
  {"action":"github_create_gist","resource":"*","effect":"allow"},
  {"action":"github_create_or_update_file","resource":"*","effect":"allow"},
  {"action":"github_create_pull_request","resource":"*","effect":"allow"},
  {"action":"github_create_pull_request_with_copilot","resource":"*","effect":"allow"},
  {"action":"github_create_repository","resource":"*","effect":"allow"},
  {"action":"github_create_repository_ruleset","resource":"*","effect":"allow"},
  {"action":"github_custom_properties_write","resource":"*","effect":"allow"},
  {"action":"github_delete_file","resource":"*","effect":"allow"},
  {"action":"github_delete_repository","resource":"*","effect":"allow"},
  {"action":"github_discussion_comment_write","resource":"*","effect":"allow"},
  {"action":"github_dismiss_notification","resource":"*","effect":"allow"},
  {"action":"github_fork_repository","resource":"*","effect":"allow"},
  {"action":"github_issue_artifact_write","resource":"*","effect":"allow"},
  {"action":"github_issue_write","resource":"*","effect":"allow"},
  {"action":"github_label_write","resource":"*","effect":"allow"},
  {"action":"github_manage_notification_subscription","resource":"*","effect":"allow"},
  {"action":"github_manage_repository_notification_subscription","resource":"*","effect":"allow"},
  {"action":"github_mark_all_notifications_read","resource":"*","effect":"allow"},
  {"action":"github_merge_pull_request","resource":"*","effect":"allow"},
  {"action":"github_projects_write","resource":"*","effect":"allow"},
  {"action":"github_pull_request_review_write","resource":"*","effect":"allow"},
  {"action":"github_push_files","resource":"*","effect":"allow"},
  {"action":"github_request_copilot_review","resource":"*","effect":"allow"},
  {"action":"github_star_repository","resource":"*","effect":"allow"},
  {"action":"github_sub_issue_write","resource":"*","effect":"allow"},
  {"action":"github_unstar_repository","resource":"*","effect":"allow"},
  {"action":"github_update_gist","resource":"*","effect":"allow"},
  {"action":"github_update_issue_comment","resource":"*","effect":"allow"},
  {"action":"github_update_pull_request","resource":"*","effect":"allow"},
  {"action":"github_update_pull_request_branch","resource":"*","effect":"allow"}
]
```

`access: "ask-changes"` allows the reads and asks for every write, and for a tool GitHub adds later:

```json
[
  {"action":"github_*","resource":"*","effect":"ask"},
  {"action":"github_actions_get","resource":"*","effect":"allow"},
  {"action":"github_actions_list","resource":"*","effect":"allow"},
  {"action":"github_check_dependency_vulnerabilities","resource":"*","effect":"allow"},
  {"action":"github_custom_properties_read","resource":"*","effect":"allow"},
  {"action":"github_get_code_quality_finding","resource":"*","effect":"allow"},
  {"action":"github_get_code_scanning_alert","resource":"*","effect":"allow"},
  {"action":"github_get_commit","resource":"*","effect":"allow"},
  {"action":"github_get_copilot_space","resource":"*","effect":"allow"},
  {"action":"github_get_dependabot_alert","resource":"*","effect":"allow"},
  {"action":"github_get_discussion","resource":"*","effect":"allow"},
  {"action":"github_get_discussion_comments","resource":"*","effect":"allow"},
  {"action":"github_get_file_contents","resource":"*","effect":"allow"},
  {"action":"github_get_gist","resource":"*","effect":"allow"},
  {"action":"github_get_global_security_advisory","resource":"*","effect":"allow"},
  {"action":"github_get_job_logs","resource":"*","effect":"allow"},
  {"action":"github_get_label","resource":"*","effect":"allow"},
  {"action":"github_get_latest_release","resource":"*","effect":"allow"},
  {"action":"github_get_me","resource":"*","effect":"allow"},
  {"action":"github_get_notification_details","resource":"*","effect":"allow"},
  {"action":"github_get_release_by_tag","resource":"*","effect":"allow"},
  {"action":"github_get_repository_tree","resource":"*","effect":"allow"},
  {"action":"github_get_secret_scanning_alert","resource":"*","effect":"allow"},
  {"action":"github_get_tag","resource":"*","effect":"allow"},
  {"action":"github_get_team_members","resource":"*","effect":"allow"},
  {"action":"github_get_teams","resource":"*","effect":"allow"},
  {"action":"github_github_support_docs_search","resource":"*","effect":"allow"},
  {"action":"github_issue_artifact_read","resource":"*","effect":"allow"},
  {"action":"github_issue_read","resource":"*","effect":"allow"},
  {"action":"github_list_branches","resource":"*","effect":"allow"},
  {"action":"github_list_code_scanning_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_commits","resource":"*","effect":"allow"},
  {"action":"github_list_copilot_spaces","resource":"*","effect":"allow"},
  {"action":"github_list_dependabot_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_discussion_categories","resource":"*","effect":"allow"},
  {"action":"github_list_discussions","resource":"*","effect":"allow"},
  {"action":"github_list_gists","resource":"*","effect":"allow"},
  {"action":"github_list_global_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_issue_fields","resource":"*","effect":"allow"},
  {"action":"github_list_issue_types","resource":"*","effect":"allow"},
  {"action":"github_list_issues","resource":"*","effect":"allow"},
  {"action":"github_list_label","resource":"*","effect":"allow"},
  {"action":"github_list_notifications","resource":"*","effect":"allow"},
  {"action":"github_list_org_repository_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_list_releases","resource":"*","effect":"allow"},
  {"action":"github_list_repository_collaborators","resource":"*","effect":"allow"},
  {"action":"github_list_repository_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_secret_scanning_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_starred_repositories","resource":"*","effect":"allow"},
  {"action":"github_list_tags","resource":"*","effect":"allow"},
  {"action":"github_projects_get","resource":"*","effect":"allow"},
  {"action":"github_projects_list","resource":"*","effect":"allow"},
  {"action":"github_pull_request_read","resource":"*","effect":"allow"},
  {"action":"github_repository_ruleset_read","resource":"*","effect":"allow"},
  {"action":"github_search_code","resource":"*","effect":"allow"},
  {"action":"github_search_commits","resource":"*","effect":"allow"},
  {"action":"github_search_issues","resource":"*","effect":"allow"},
  {"action":"github_search_orgs","resource":"*","effect":"allow"},
  {"action":"github_search_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_search_repositories","resource":"*","effect":"allow"},
  {"action":"github_search_users","resource":"*","effect":"allow"},
  {"action":"github_events_list","resource":"*","effect":"allow"},
  {"action":"github_probe","resource":"*","effect":"allow"},
  {"action":"github_api","resource":"GET *","effect":"allow"},
  {"action":"github_api","resource":"HEAD *","effect":"allow"},
  {"action":"github_api","resource":"POST /markdown","effect":"allow"},
  {"action":"github_api","resource":"POST /markdown/raw","effect":"allow"},
  {"action":"github_api","resource":"QUERY /graphql","effect":"allow"},
  {"action":"github_actions_run_trigger","resource":"*","effect":"ask"},
  {"action":"github_add_comment_to_pending_review","resource":"*","effect":"ask"},
  {"action":"github_add_issue_comment","resource":"*","effect":"ask"},
  {"action":"github_add_reply_to_pull_request_comment","resource":"*","effect":"ask"},
  {"action":"github_assign_copilot_to_issue","resource":"*","effect":"ask"},
  {"action":"github_assign_copilot_to_issue_with_intent","resource":"*","effect":"ask"},
  {"action":"github_create_branch","resource":"*","effect":"ask"},
  {"action":"github_create_gist","resource":"*","effect":"ask"},
  {"action":"github_create_or_update_file","resource":"*","effect":"ask"},
  {"action":"github_create_pull_request","resource":"*","effect":"ask"},
  {"action":"github_create_pull_request_with_copilot","resource":"*","effect":"ask"},
  {"action":"github_create_repository","resource":"*","effect":"ask"},
  {"action":"github_create_repository_ruleset","resource":"*","effect":"ask"},
  {"action":"github_custom_properties_write","resource":"*","effect":"ask"},
  {"action":"github_delete_file","resource":"*","effect":"ask"},
  {"action":"github_delete_repository","resource":"*","effect":"ask"},
  {"action":"github_discussion_comment_write","resource":"*","effect":"ask"},
  {"action":"github_dismiss_notification","resource":"*","effect":"ask"},
  {"action":"github_fork_repository","resource":"*","effect":"ask"},
  {"action":"github_issue_artifact_write","resource":"*","effect":"ask"},
  {"action":"github_issue_write","resource":"*","effect":"ask"},
  {"action":"github_label_write","resource":"*","effect":"ask"},
  {"action":"github_manage_notification_subscription","resource":"*","effect":"ask"},
  {"action":"github_manage_repository_notification_subscription","resource":"*","effect":"ask"},
  {"action":"github_mark_all_notifications_read","resource":"*","effect":"ask"},
  {"action":"github_merge_pull_request","resource":"*","effect":"ask"},
  {"action":"github_projects_write","resource":"*","effect":"ask"},
  {"action":"github_pull_request_review_write","resource":"*","effect":"ask"},
  {"action":"github_push_files","resource":"*","effect":"ask"},
  {"action":"github_request_copilot_review","resource":"*","effect":"ask"},
  {"action":"github_star_repository","resource":"*","effect":"ask"},
  {"action":"github_sub_issue_write","resource":"*","effect":"ask"},
  {"action":"github_unstar_repository","resource":"*","effect":"ask"},
  {"action":"github_update_gist","resource":"*","effect":"ask"},
  {"action":"github_update_issue_comment","resource":"*","effect":"ask"},
  {"action":"github_update_pull_request","resource":"*","effect":"ask"},
  {"action":"github_update_pull_request_branch","resource":"*","effect":"ask"}
]
```

`access: "read-only"` allows the reads and denies every write, and a tool GitHub adds later. It also turns GitHub's own
read-only mode on, so its server lists no write tools:

```json
[
  {"action":"github_*","resource":"*","effect":"deny"},
  {"action":"github_actions_get","resource":"*","effect":"allow"},
  {"action":"github_actions_list","resource":"*","effect":"allow"},
  {"action":"github_check_dependency_vulnerabilities","resource":"*","effect":"allow"},
  {"action":"github_custom_properties_read","resource":"*","effect":"allow"},
  {"action":"github_get_code_quality_finding","resource":"*","effect":"allow"},
  {"action":"github_get_code_scanning_alert","resource":"*","effect":"allow"},
  {"action":"github_get_commit","resource":"*","effect":"allow"},
  {"action":"github_get_copilot_space","resource":"*","effect":"allow"},
  {"action":"github_get_dependabot_alert","resource":"*","effect":"allow"},
  {"action":"github_get_discussion","resource":"*","effect":"allow"},
  {"action":"github_get_discussion_comments","resource":"*","effect":"allow"},
  {"action":"github_get_file_contents","resource":"*","effect":"allow"},
  {"action":"github_get_gist","resource":"*","effect":"allow"},
  {"action":"github_get_global_security_advisory","resource":"*","effect":"allow"},
  {"action":"github_get_job_logs","resource":"*","effect":"allow"},
  {"action":"github_get_label","resource":"*","effect":"allow"},
  {"action":"github_get_latest_release","resource":"*","effect":"allow"},
  {"action":"github_get_me","resource":"*","effect":"allow"},
  {"action":"github_get_notification_details","resource":"*","effect":"allow"},
  {"action":"github_get_release_by_tag","resource":"*","effect":"allow"},
  {"action":"github_get_repository_tree","resource":"*","effect":"allow"},
  {"action":"github_get_secret_scanning_alert","resource":"*","effect":"allow"},
  {"action":"github_get_tag","resource":"*","effect":"allow"},
  {"action":"github_get_team_members","resource":"*","effect":"allow"},
  {"action":"github_get_teams","resource":"*","effect":"allow"},
  {"action":"github_github_support_docs_search","resource":"*","effect":"allow"},
  {"action":"github_issue_artifact_read","resource":"*","effect":"allow"},
  {"action":"github_issue_read","resource":"*","effect":"allow"},
  {"action":"github_list_branches","resource":"*","effect":"allow"},
  {"action":"github_list_code_scanning_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_commits","resource":"*","effect":"allow"},
  {"action":"github_list_copilot_spaces","resource":"*","effect":"allow"},
  {"action":"github_list_dependabot_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_discussion_categories","resource":"*","effect":"allow"},
  {"action":"github_list_discussions","resource":"*","effect":"allow"},
  {"action":"github_list_gists","resource":"*","effect":"allow"},
  {"action":"github_list_global_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_issue_fields","resource":"*","effect":"allow"},
  {"action":"github_list_issue_types","resource":"*","effect":"allow"},
  {"action":"github_list_issues","resource":"*","effect":"allow"},
  {"action":"github_list_label","resource":"*","effect":"allow"},
  {"action":"github_list_notifications","resource":"*","effect":"allow"},
  {"action":"github_list_org_repository_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_list_releases","resource":"*","effect":"allow"},
  {"action":"github_list_repository_collaborators","resource":"*","effect":"allow"},
  {"action":"github_list_repository_security_advisories","resource":"*","effect":"allow"},
  {"action":"github_list_secret_scanning_alerts","resource":"*","effect":"allow"},
  {"action":"github_list_starred_repositories","resource":"*","effect":"allow"},
  {"action":"github_list_tags","resource":"*","effect":"allow"},
  {"action":"github_projects_get","resource":"*","effect":"allow"},
  {"action":"github_projects_list","resource":"*","effect":"allow"},
  {"action":"github_pull_request_read","resource":"*","effect":"allow"},
  {"action":"github_repository_ruleset_read","resource":"*","effect":"allow"},
  {"action":"github_search_code","resource":"*","effect":"allow"},
  {"action":"github_search_commits","resource":"*","effect":"allow"},
  {"action":"github_search_issues","resource":"*","effect":"allow"},
  {"action":"github_search_orgs","resource":"*","effect":"allow"},
  {"action":"github_search_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_search_repositories","resource":"*","effect":"allow"},
  {"action":"github_search_users","resource":"*","effect":"allow"},
  {"action":"github_events_list","resource":"*","effect":"allow"},
  {"action":"github_probe","resource":"*","effect":"allow"},
  {"action":"github_api","resource":"GET *","effect":"allow"},
  {"action":"github_api","resource":"HEAD *","effect":"allow"},
  {"action":"github_api","resource":"POST /markdown","effect":"allow"},
  {"action":"github_api","resource":"POST /markdown/raw","effect":"allow"},
  {"action":"github_api","resource":"QUERY /graphql","effect":"allow"},
  {"action":"github_actions_run_trigger","resource":"*","effect":"deny"},
  {"action":"github_add_comment_to_pending_review","resource":"*","effect":"deny"},
  {"action":"github_add_issue_comment","resource":"*","effect":"deny"},
  {"action":"github_add_reply_to_pull_request_comment","resource":"*","effect":"deny"},
  {"action":"github_assign_copilot_to_issue","resource":"*","effect":"deny"},
  {"action":"github_assign_copilot_to_issue_with_intent","resource":"*","effect":"deny"},
  {"action":"github_create_branch","resource":"*","effect":"deny"},
  {"action":"github_create_gist","resource":"*","effect":"deny"},
  {"action":"github_create_or_update_file","resource":"*","effect":"deny"},
  {"action":"github_create_pull_request","resource":"*","effect":"deny"},
  {"action":"github_create_pull_request_with_copilot","resource":"*","effect":"deny"},
  {"action":"github_create_repository","resource":"*","effect":"deny"},
  {"action":"github_create_repository_ruleset","resource":"*","effect":"deny"},
  {"action":"github_custom_properties_write","resource":"*","effect":"deny"},
  {"action":"github_delete_file","resource":"*","effect":"deny"},
  {"action":"github_delete_repository","resource":"*","effect":"deny"},
  {"action":"github_discussion_comment_write","resource":"*","effect":"deny"},
  {"action":"github_dismiss_notification","resource":"*","effect":"deny"},
  {"action":"github_fork_repository","resource":"*","effect":"deny"},
  {"action":"github_issue_artifact_write","resource":"*","effect":"deny"},
  {"action":"github_issue_write","resource":"*","effect":"deny"},
  {"action":"github_label_write","resource":"*","effect":"deny"},
  {"action":"github_manage_notification_subscription","resource":"*","effect":"deny"},
  {"action":"github_manage_repository_notification_subscription","resource":"*","effect":"deny"},
  {"action":"github_mark_all_notifications_read","resource":"*","effect":"deny"},
  {"action":"github_merge_pull_request","resource":"*","effect":"deny"},
  {"action":"github_projects_write","resource":"*","effect":"deny"},
  {"action":"github_pull_request_review_write","resource":"*","effect":"deny"},
  {"action":"github_push_files","resource":"*","effect":"deny"},
  {"action":"github_request_copilot_review","resource":"*","effect":"deny"},
  {"action":"github_star_repository","resource":"*","effect":"deny"},
  {"action":"github_sub_issue_write","resource":"*","effect":"deny"},
  {"action":"github_unstar_repository","resource":"*","effect":"deny"},
  {"action":"github_update_gist","resource":"*","effect":"deny"},
  {"action":"github_update_issue_comment","resource":"*","effect":"deny"},
  {"action":"github_update_pull_request","resource":"*","effect":"deny"},
  {"action":"github_update_pull_request_branch","resource":"*","effect":"deny"}
]
```

- `readOnly: true` and `readOnly: false` are deprecated: they mean `"read-only"` and `"all"`, and `/github-status` says
  so. An explicit `access` wins over them.
- The reads are allowed at every access value, whichever toolsets are on; a method a toolset turns off is unavailable
  rather than denied.
- Agents without the base allow rule are unchanged. The block is added once, even after a reload. Such an agent does
  not get the `github_api` read allows either, so its `github_api` reads ask, and a script's reads are refused with
  `PERMISSION_DENIED`, unless its own rules allow them (`events_list` needs only an allow for `github_events_list`,
  which Jelly writes for its agents): add
  `{ "action": "github_api", "resource": "GET *", "effect": "allow" }`, and the same for `HEAD *`, `POST /markdown`,
  `POST /markdown/raw` and `QUERY /graphql` as you need them.
- OpenCode applies the last rule that matches. So the agent's own later rules still win (Plan keeps its rules, and
  Explore still denies GitHub tools), then your top-level `permissions` rules, then saved approvals.
- MCP tool permissions use the tool name as the action and `*` as the resource, so rules cannot target a repository.
  `github_api` is the exception: its rule carries `METHOD /path`.

The result:

- At `all`, every tool runs without a prompt, including in `opencode run`.
- At `ask-changes`, reads run and everything else asks. In `opencode run`, nobody is present to answer, so a write is
  denied.
- At `read-only`, a write is denied, which also hides it from the model.
- **Always allow** at a prompt is saved for the project and applies to every agent in it, including Plan. It is not
  part of an agent's rules, so it never authorizes a script. A folder that is not in a git repository with a commit
  belongs to OpenCode's shared `global` project.

### Recipes

Put these in the top-level `permissions` list of `opencode.json`. Every rule needs `"resource": "*"`; OpenCode 2.2.3
skips a rule without it and logs a warning.

Let one write run without a prompt:

```json
{ "permissions": [{ "action": "github_create_pull_request", "resource": "*", "effect": "allow" }] }
```

Never merge pull requests:

```json
{ "permissions": [{ "action": "github_merge_pull_request", "resource": "*", "effect": "deny" }] }
```

Ask before every GitHub MCP tool, reads included:

```json
{ "permissions": [{ "action": "github_*", "resource": "*", "effect": "ask" }] }
```

Under this rule `github_events_list` asks, and once approved its inner reads fail with `PERMISSION_DENIED`, because
they run unattended, assert `github_events_list` on each `GET /path`, and cannot ask; add
`{ "action": "github_events_list", "resource": "*", "effect": "allow" }` after it to avoid that.

`github_api` asserts every request on its own resource, reads included, and the block allows its reads (`GET *`,
`HEAD *`, `POST /markdown`, `POST /markdown/raw` and `QUERY /graphql`) at every access value. To stop a read, deny it
by resource, such as `{ "action": "github_api", "resource": "GET /notifications", "effect": "deny" }`; to stop them
all, deny `github_api` on `*`, which removes the tool.

Keep one agent away from GitHub: add `{ "action": "github_*", "resource": "*", "effect": "deny" }` at the end of that
agent's own `permissions` list.

For a hard stop, use `deny`. An `ask` can be approved, and an approval saved with **Always allow** applies to the
whole project.

### Agents defined only in your config

OpenCode creates agents that exist only in your config after plugins run, so they do not get the default rules.
Their own rules decide; with none, a GitHub tool runs. `/github-status` and the `/github` dialog list them under
"Agents without default rules", followed by the default block, and the next step reads: "Put the default rules shown by /github-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for GitHub tools." An agent whose own rules already ask for or deny
GitHub's tools, such as one that ends with `{ "action": "*", "resource": "*", "effect": "ask" }`, needs no fix and is
not listed.

To fix an agent, put the default block **first** in **that agent's own** `permissions` list, followed by your
top-level rules for `github_` tools, so they keep winning. The block `/github-status` prints for your `access` value
is the list of rules that goes first; the example below shows its pattern rule only, and the rule that follows it is
your own:

```json
{
  "permissions": [{ "action": "github_merge_pull_request", "resource": "*", "effect": "deny" }],
  "agents": {
    "reviewer": {
      "description": "Reviews changes",
      "mode": "subagent",
      "permissions": [
        { "action": "github_*", "resource": "*", "effect": "allow" },
        { "action": "github_merge_pull_request", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

The same applies to an agent defined in a Markdown file: add the rules to its `permissions`. Once the block is in
place, the status stops listing the agent.

Do not put the block in the top-level `permissions`. Top-level rules come after every agent's built-in rules, so the
block would weaken Explore and any other agent that denies by default: its denied GitHub reads and writes would
become allowed.

### The `github_*` wildcard

MCP tool names are `<server>_<tool>`. The default `github_*` rule also matches tools of any other MCP server whose
name starts with `github_`, such as a server named `github_enterprise`. Those tools follow the same access value. Name other
GitHub servers differently, for example `ghe`. A server named exactly `github` that you configured yourself also
gets these rules.

## `github_api`

`github_api` calls GitHub's REST or GraphQL API with the account the GitHub sign-in holds. Agents should prefer the
MCP tools and use it for what they cannot do: auto-merge, release create and asset upload, branch protection,
rulesets, Actions variables, artifact download and any GraphQL. Its input is one of:

- REST: `{ method, path, query?, body?, accept?, paginate?, maxPages?, maxItems?, download?, upload? }`.
  - `path` is relative to the API, such as `/repos/OWNER/REPO/releases`. These are refused with `API_PATH_INVALID`:
    a full URL, `//`, a `.` or `..` segment however it is percent-encoded (`%2e`, `.%2e`, `%252e` and so on), and a
    percent-encoded letter, digit or other character a path can hold as itself (`%6F` for `o`). `/graphql` is refused
    with `API_GRAPHQL_PATH`. The path that rules and the prompt see is exactly the path sent to GitHub.
  - `accept` is `json` (the default), `diff`, `patch`, `raw` or `octet-stream`.
  - `paginate` (GET only) follows GitHub's `Link` header and joins the pages, up to `maxPages` (default 10) and
    `maxItems` (default 1000).
  - `download: { path, overwrite? }` (GET only) saves the response to a file inside the project and returns its
    path, size and SHA-256. A file that exists is refused before the prompt, and one that appears during the download
    is kept, unless `overwrite` is `true`. Downloads stop at 2 GiB (2147483648 bytes) with `API_DOWNLOAD_TOO_LARGE`,
    and the partial file is removed.
  - `upload: { path, contentType }` (POST only) sends a file inside the project to the uploads host, for release
    assets, for example `{ "method": "POST", "path": "/repos/OWNER/REPO/releases/1/assets", "query": { "name": "app.zip" }, "upload": { "path": "dist/app.zip", "contentType": "application/zip" } }`.
- GraphQL: `{ graphql: { query, variables? } }`.

The output has `ok`, `status`, `data` (JSON, or text for diff, patch and raw), the rate limit, pagination facts,
`truncated` and a `nextStep` when there is one. Results over 100,000 bytes are cut, whole list items first. Responses
are untrusted GitHub content. A working GET that one of GitHub's tools covers, such as `/repos/OWNER/REPO/tags`
(`list_tags`), `/commits/{sha}` (`get_commit`) or `/pulls` (`list_pull_requests`), names that tool in `nextStep`, when
its toolset is on; the call still runs.

**Reads and writes.** GET and HEAD read, and so do `POST /markdown` and `POST /markdown/raw`, which only render
Markdown; every other POST writes. A GraphQL document reads only when it holds exactly one operation and that
operation is a query; the plugin scans the document itself, skipping strings and comments. Everything else is a
write.

**Every request asserts first.** Each request `github_api` sends, a read or a write, is asserted as `github_api` on its
own `METHOD /path` before it is sent, as the calling session; a single GraphQL query is `QUERY /graphql`, and any other
GraphQL document `POST /graphql`. The block allows the reads at every access value, so they run without a prompt; a
write follows `access`: `"all"` runs it, `"ask-changes"` asks for it, and `"read-only"` refuses it with `READ_ONLY`.
A rule of your own decides either: a deny for one read path refuses that read, with nothing sent. A script's request
resolves that same resource, so a rule for another method does not cover it. In that path, the names GitHub reads
without regard to case are in lower case (see Rules). A download is asserted the same way, as `download <file>`, and
is refused while read-only.

**Hosts and the token.** Requests go only to `https://api.github.com`, and uploads to `https://uploads.github.com`; with
[`host`](#host-github-enterprise-server), to the server's own API. The plugin handles redirects itself:

- A change (any method but GET and HEAD, GraphQL and uploads included) never follows one. It fails with
  `API_REDIRECTED`, which names the new path, so you can call again with that path and have it checked there.
- A GET or HEAD follows a redirect within the API base, such as a renamed repository's, after asserting the new path
  as its own request. A read redirected outside the API fails with `API_REDIRECT_OFF_HOST`.
- A download follows a redirect within the API too, and one to the storage that serves logs, artifacts and release
  assets, without the `Authorization` header. For job logs, GitHub's `get_job_logs` tool returns the text.
- Pagination follows a `Link` only under the API base path, and asserts a page at another path before it is sent.

The token never appears in output, errors or logs. A 401 marks the account in `/connect` as needing a new sign-in.

**Rules.** Rules for `github_api` match `METHOD /path`, and `*` matches any text, slashes included. GitHub reads
some names without regard to case, so the path a rule is checked against has them in lower case: owner, repository,
organisation, user, enterprise and team names (`/repos/{owner}/{repo}`, `/orgs/{org}`, `/users/{user}`,
`/orgs/{org}/teams/{team}`, members and collaborators), and environment, label, secret and variable names. **Write
those names in lower case.** A rule such as `DELETE /repos/Owner/prod/*` never matches, and the status lists it under
"Rules that never match". Branch names, file paths and everything else keep their case.

```json
{
  "permissions": [
    { "action": "github_api", "resource": "POST /repos/my-org/*", "effect": "allow" },
    { "action": "github_api", "resource": "PUT /repos/my-org/site/pulls/*/merge", "effect": "allow" },
    { "action": "github_api", "resource": "DELETE *", "effect": "deny" }
  ]
}
```

A deny on `{ "action": "github_api", "resource": "*" }` as the last matching rule removes the tool from that agent.

Scripts can call `github_api` for reads through the tools RPC's `api` method, never for writes, downloads or uploads;
see [Scripting](scripting.md#api).

## Events list

`github_events_list` (`tools.github.events_list` in Code Mode, and the tools RPC method `events_list`) is GitHub's
source under the shared source contract, `@we-the-rebel-alliance/source-contract` v0.2.0 (see [Sources](#sources)). It
lists what the signed-in user was involved in since a cursor, as normalised events, oldest first. It only reads, never
asks and calls no model, so Memory's collector can run it unattended.

```
events_list({ since?, cursor?, limit?, account?, source? })
  → { source: "github", account: "<login>", owner: { id: "github:<Login>", label: "<Login>" }, events, cursor, more,
      refused?, gap?, plugin, asOf, trust: "untrusted" }
```

| Input | Meaning |
| --- | --- |
| `since` | Where to start without a cursor: an ISO date (a UTC day) or date-time with `Z` or an offset. Default: 24 hours ago. |
| `cursor` | The previous result's cursor. It wins over `since`, and needs `account`. |
| `limit` | Most events, 1 to 500; 100 by default. A result also stops before 900,000 bytes of JSON. |
| `account` | The signed-in GitHub login, lowercase, as `probe` and every result name it. Required with a cursor. |
| `source` | `github`, the one source. |

**The account and the owner are the sign-in's.** `events_list` never asks GitHub who is signed in: the account is the
login GitHub's `GET /user` named when you signed in (the Account `/github-status` shows), lowercase, and the owner is
`github:` and that login (`github:<Login>@<host>` with the `host` option, so a GitHub Enterprise Server login never
shares an owner with a github.com one). A listing names the account it reads; one that names another login than the signed-in one is
refused with `ACCOUNT_MISMATCH`, and so is a cursor issued for another account, before any GitHub call. The cursor is
the source contract's bound cursor, tied to this plugin, the source and the account, with a digest of the owner
inside, so a cursor that was changed, issued before a sign-in to another account, or issued by 0.0.2 or earlier
(account `default`) is `CURSOR_INVALID`: start again with `since`.

It asserts `github_events_list`, then makes only GET requests, through `github_api`'s own spec with the plugin's
sign-in. Each GET asserts the tool's own permission, `github_events_list`, on its own `GET /path` first, not
`github_api`, unattended: it runs only under an allow rule for `github_events_list` (the block has one, and Jelly writes
one for its agents, which have no base allow), and a rule that asks or denies it refuses it with `PERMISSION_DENIED`
before the request is sent. It sends nothing but the three GETs below; another path, a redirect elsewhere or a change
is refused before it is sent:

- **issues and pull requests** the user is involved in: `/search/issues` twice, with `is:issue involves:<login>
  updated:>=<time>` and with `is:pull-request involves:<login> updated:>=<time>` (GitHub refuses a GitHub App token's
  search for both together), each sorted by update, oldest first, each its own stream in the cursor. One event each time one changes: kind `issue` or `pr`, the title, the body cut to
  4,096 characters, the author and assignees as `github:` actors, the state and labels, and its `html_url`;
- **commits** the user authored: `/search/commits` with `author:<login> committer-date:>=<time>`, sorted by committer
  date. Kind `commit`, the message, and its `html_url`;
- **notifications**, where the sign-in may read them: `/notifications` with `participating` and `since`. A 401, 403
  or 404 leaves them out, as for a fine-grained token, which cannot read notifications. Those about an issue or a pull
  request are left out too, because the first stream lists them. Kind `event`, the subject's title and type, and the
  repository's link.

The cursor holds a position in each stream. The result merges them by time, and lists only what no stream can still put
before it. An event is listed once it is 5 minutes old, because GitHub's search lags a little behind a change. **A read
holds one cut** (the time of its first page, less those 5 minutes) on every page until it ends (`more: false`): nothing
newer is listed by it, and the next read lists what came after.

GitHub's search returns at most 1,000 results for one query, and allows 30 search requests a minute: each search reads
at most 6 pages of 100 a call from its position, and the cursor moves past what was listed, so the next call's query
starts later. When every result a search read shares one second (a rebase-merge gives hundreds of commits one committer
date), that second is read whole by itself, up to GitHub's 1,000 results, and listed in the plugin's own order (by id),
so the position walks through it across calls and then moves past it; with two such seconds, the earlier is read
first. A call makes at most 30 search requests. Each result is listed once, even where GitHub orders a second's results
differently from one page to the next; but if it does, a result can be missed while that second is read (GitHub does
not say whether its order is stable). A search GitHub answers as incomplete (it timed out) lists nothing past that
stream's position, and the next call reads it again, so nothing it left out is skipped. An event whose title or text
holds a secret, such as a password in a URL, is never listed: it is in the page's `refused[]` with `reason: "secret"`,
and the cursor moves past it.

**Notifications** are read under the read's cut (`before`). Up to 500 are read whole. With more (a backlog), the call
counts them, asking GitHub for one notification alone at a time (it lists them newest first), and reads the oldest 500:
the backlog is walked oldest first, call after call, and nothing GitHub delivers meanwhile can push one out of it.
Where GitHub will not page that far, or past 64,000, the call reads the newest 500 instead and answers a gap.

**A notification GitHub delivers late.** Each read looks again at the 6 hours before the notifications' position, and
lists a notification stamped there that it has not listed yet; the cursor remembers the last 16 it listed in that time
(the lookback starts after older ones), so none is listed twice. One delivered more than 6 hours late is not listed.

**History GitHub no longer keeps.** GitHub keeps inbox notifications for three months, unless they are saved
([notification retention](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)).
A read whose notifications start before that (taken as 89 days, the shortest three months) may have lost some: it
answers `gap`, `{ reason: "expired", since }` from a cursor or `{ reason: "window-truncated", since }` from `since`,
where `since` is where the notifications started, and reads them from the window's start. Where a read restarts
counts from its cut, so it holds still while the read pages; whether GitHub may have deleted some is checked on
GitHub's clock, on every page, as GitHub deletes them while the read pages. So does a backlog the call
cannot walk (above), and a second with more search results than GitHub answers for one query (1,000):
`window-truncated`, and the search moves past that second. **A read answers one gap**, on the page where it restarts:
until the read ends, the cursor carries that it was answered and no later page answers another; reading again at the
same cursor answers the same gap. A loss a read finds after its gap is carried in the cursor, past the read's end, and
the next read's first page answers it (`{ reason: "expired", since }`), so no loss is silent. A complete read moves the notifications' position up to the cut, so an inbox read at least every
three months never answers a gap. A sign-in that may not read notifications has none to lose, and answers no gap. The
issue, pull request and commit searches read any time range. An item deleted on GitHub before a read finds it is never
listed; that is not a gap.

**`probe`** (the tools RPC method, action `github_probe`, allowed by the default rules at every `access`) answers who
is signed in, `{ source: "github", account, owner, trust }`, with the same account and owner as every page, and nothing
it reads. It makes one `GET /user`, asserted as `github_probe` on `GET /user`, to confirm the token still belongs to that
login, and refuses another account with `ACCOUNT_MISMATCH`.

## Sources

`package.json` declares the plugin's one source in its top-level `sources` key, under source-contract version 1, so a
consumer (Memory, jelly, Artifacts) reads it from the installed package:

| Key | Value |
| --- | --- |
| `id` | `github.activity` |
| `kind`, `reads` | `events`, `event` (its events are kinds `issue`, `pr`, `commit` and `event`) |
| `tool`, `input` | `events_list`, `{ "source": "github" }` |
| `accounts.named` | `false`: one sign-in |
| `permission.events` | `github_events_list` |
| `permission.rules` | `github_events_list` on `GET /search/issues`, `GET /search/commits` and `GET /notifications`: exactly the reads it makes |
| `private` | `true`: private repositories and your notifications |
| `cost` | `free`: GitHub's REST API is not billed; it is rate-limited (see the README's Known limits) |
| `maxBytes` | 900,000 |
| `urlHosts` | `github.com` |
| `sources.rpc`, `sources.probe.action` | `github.platform.tools`, `github_probe` |

The grants are stated verbatim (`rules`) rather than as `operations`, because each read is the tool's own action on a
`GET /path`, which an operation name cannot express. For the same reason the probe's `GET /user` cannot be declared as
a `permission.identity` operation: the probe asserts only `github_probe`, on `*` and on `GET /user`. Contract v0.2.0's
`permission.identityRules` can state that grant; the declaration adds it once the consumers (Memory, Jelly) read
v0.2.0, because a consumer on v0.1.x refuses the key. `npm run conformance` (and `npm run check`) runs the contract's
conformance kit over the source, on recorded answers with no GitHub call, and writes
`reports/conformance-report.json` for a release to attach. Every check that applies runs, the gap checks on a cursor
whose notifications GitHub no longer keeps and on a `since` before them. `failed-holds-cursor` cannot apply, with its
reason in the report: each GitHub request answers a whole page, and a request that fails fails the whole call, so no
single event can fail on its own.

## Repository scope

The plugin has no repository allowlist. MCP permissions cannot name a repository, so scope comes from the
credential: a fine-grained personal access token reaches only the repositories you select when you create it, and
GitHub enforces that. Device sign-in with the `repo` scope reaches every repository your account can reach.

## `lockdown`

`lockdown: true` turns on GitHub's lockdown mode, a best-effort content filter, not a security boundary. In public
repositories, GitHub then limits issue and pull request content to items from users with push access. It reduces
the untrusted text that reaches your agents; it does not stop a tool from running, and it does not change the
permission rules.

## `unknownTools`

GitHub adds, renames and removes tools over time. A GitHub tool that is not in the plugin's catalog is "unknown":

- With `"list"`, or `"ask"` (the same value, and the default), it stays visible, and the default block's `github_*` rule decides it: it runs like every
  other tool at the default `access`, asks at `"ask-changes"` and is denied at `"read-only"`. Known tools keep working.
  `"ask"` is the older name, from before the all-allow default: it does not make an unknown tool ask, and it cannot. To make
  one ask or stop, set `access`, or add a rule for it.
- With `"hide"`, the plugin removes it from the agents' tools.

The status names the unknown tools GitHub currently offers, and says which of the above applies (`allowed by
github_*`, `they ask first`, `they are denied` or `hidden`). Both modes apply only to the plugin's own `github`
server.

## Fine-grained token permissions

The full list is in the README's [Sign in](https://github.com/joe-broadhead/opencode-github/blob/HEAD/README.md#sign-in).
Which default toolset needs which read permission:

| Permission | Toolsets |
| --- | --- |
| Metadata, Contents, Issues, Pull requests, Commit statuses | `repos`, `issues`, `pull_requests`, `labels`, `git` |
| Actions | `actions` |
| Code quality | `code_quality` |
| Code scanning alerts | `code_security` |
| Dependabot alerts | `dependabot` |
| Secret scanning alerts | `secret_protection` |
| Repository security advisories | `security_advisories` |
| Discussions | `discussions` |
| Members, Issue Types, Issue Fields (organisation) | the team and issue-type tools |

A missing one fails with "Resource not accessible by personal access token", and `github_api` names the permission
in its next step. Device sign-in needs none of this.

## `clientId` and `scopes`

No OAuth App ships with the plugin, so by default only token sign-in is offered. To add device sign-in, set
`clientId` to an OAuth App's public client ID; no client secret is used or shipped.

To use your own OAuth App, register it under **GitHub Settings → Developer settings → OAuth Apps → New OAuth App**,
tick **Enable Device Flow**, do not generate a client secret, and set its client ID:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-github#v0.0.6", "options": { "clientId": "<your OAuth App client ID>" } }] }
```

`scopes` changes what device sign-in asks for, for example `["public_repo"]` for public repositories only. Scopes
are requested at sign-in; they are not part of the app.

An organisation can set `clientId` and `scopes` for everyone on a machine; see
[Organisation rollout](../README.md#organisation-rollout).

### A GitHub App

`clientId` can name a GitHub App instead (its client ID, not its app ID). GitHub Apps use the same device flow, so
the plugin cannot tell the two apart until GitHub returns the token: a GitHub App's user token starts with `ghu_` and
comes with an empty `scope`, an OAuth App's starts with `gho_`. The device code request still carries `scopes`; a
GitHub App ignores them (its only scope is `offline_access`), and `scopes: []` leaves the parameter out.

Register it under **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**, tick **Enable Device
Flow**, give it read-only repository permissions for what the toolsets read, and keep **Expire user authorization
tokens** on. Then:

- **Renewal.** The user token expires after 8 hours. OpenCode asks the plugin to renew it shortly before; the plugin
  sends the refresh token to `login/oauth/access_token` (no client secret: GitHub needs none for a token the device
  flow made) and stores the new token and the new refresh token, which replaces the old one. When GitHub refuses the
  refresh token (revoked, already used, or older than six months), the next call fails with `SIGN_IN_REJECTED` and
  `/connect` asks for a new sign-in.
- **Installations.** The token reaches only repositories where the App is installed. After sign-in the plugin asks
  GitHub how many installations it reaches; with none, `/github-status`'s next step says so, with the install link
  when `appSlug` is set, and asks GitHub again each time until the App is installed. The `/connect` label is the login
  alone, because OpenCode sets it only at sign-in.
- **Renewal limits.** The renewal is one request with its own 10-second limit, well inside the 30 seconds OpenCode
  allows, so a slow GitHub fails it cleanly (`REFRESH_UNREACHABLE`; the next call tries again) instead of being cut off.
- **Permissions.** A call the App has no permission for, or makes on an account it is not installed on, fails with
  "Resource not accessible by integration". `github_api`'s next step names the permission GitHub asked for and the
  account, and links the install page.

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-github#v0.0.6", "options": { "clientId": "<the GitHub App's client ID>", "appSlug": "<its URL name>" } }] }
```

## `host` (GitHub Enterprise Server)

GitHub's hosted MCP server does not support GitHub Enterprise Server. With `host` set:

- the plugin registers no MCP server, so the `github_` MCP tools are absent, and `github_api` is the tool;
- `github_api` calls `https://<host>/api/v3`, `https://<host>/api/graphql`, and `https://<host>/api/uploads` for
  release assets;
- sign-in moves to an integration of the plugin's own: run `/connect` and choose **GitHub Enterprise**. The token
  method opens `https://<host>/settings/personal-access-tokens/new`. Device sign-in appears only when `clientId` names
  an OAuth App that the server's administrator registered with Device Flow on; it uses
  `https://<host>/login/device/code`;
- the status names the server and says that only `github_api` works.

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-github#v0.0.6", "options": { "host": "github.example.com", "clientId": "<the server's OAuth App client ID>" } }] }
```

For GitHub's MCP tools on the server, run GitHub's `github-mcp-server` yourself as a local MCP server with
`GITHUB_HOST=https://<host>` and a token. Name it `github`: with `host` set the plugin registers no server of its
own, so the name is free, and the plugin's default rules then apply to its tools (known reads run, writes and
unknown tools ask).

GHE.com (data residency) is not supported yet; `host` refuses `*.ghe.com`.

## `allowUntestedHost`

The plugin supports OpenCode `>=2.2.3 <2.4.0` and is tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. A release inside the
range that is not in that list, such as 2.2.99, still loads, and the status marks it untested. On a later 2.2 or 2.3 release it
loads and works; the status shows `OpenCode: 2.2.99 (untested; supported range >=2.2.3 <2.4.0)`, and the status RPC
`host.tested: false`, and the state and next step stay those of the connection. Outside the range, including
prereleases and development builds, it refuses to load, so there is no `/github-status`, `/github` dialog or status
RPC, and no state `host_untested`:

```text
HOST_UNTESTED: OpenCode 2.4.0 is outside the supported range >=2.2.3 <2.4.0. Next step: Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.
```

With `allowUntestedHost: true`, it loads and the status shows this warning:

```text
OpenCode 2.4.0 is outside the supported range >=2.2.3 <2.4.0. It loaded because allowUntestedHost is set.
```

## Errors

The plugin's own errors read `CODE: what happened. Next step: what to do.` Errors from OpenCode and from GitHub are
passed through unchanged.

| Code | When | Next step |
| --- | --- | --- |
| `OPTIONS_INVALID` | An option is unknown or has a wrong value. The message names the option. | Fix the options for github:joe-broadhead/opencode-github#v0.0.6 in opencode.json. |
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.4.0` and `allowUntestedHost` is not set. | Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true. |
| `SKILLS_INVALID` | A skill file shipped with the plugin is missing or malformed. | Reinstall the plugin. |
| `STATUS_UNAVAILABLE` | OpenCode did not report the `github` server's state. | Try again in a few seconds; if it persists, restart OpenCode. |
| `SIGN_IN_EXPIRED` | The device code expired before it was entered. | Start the sign-in again. |
| `SIGN_IN_CANCELLED` | The sign-in was cancelled on GitHub. | Start the sign-in again. |
| `SIGN_IN_CODE_UNKNOWN` | GitHub did not recognise the device code. | Start the sign-in again. |
| `SIGN_IN_FAILED` | GitHub ended the device sign-in with another error, named in the message. | Start the sign-in again. |
| `SIGN_IN_UNREACHABLE` | github.com could not be reached. | Check your network, then start the sign-in again. |
| `SIGN_IN_REJECTED` | GitHub refused to renew a GitHub App sign-in: its refresh token was revoked, already used, or is older than six months. | Run /connect and choose GitHub to sign in again. |
| `SIGN_IN_UNAVAILABLE` | OpenCode could not load the saved sign-in for `github_api`. | Try again; if it keeps failing, run /connect and choose GitHub to sign in again. |
| `REFRESH_UNREACHABLE` | github.com could not be reached to renew a GitHub App sign-in. | Check your network, then try again. |
| `REFRESH_FAILED` | GitHub could not renew a GitHub App sign-in right now. | Try again later. |
| `SIGN_IN_UNEXPECTED_RESPONSE` | GitHub answered the device sign-in with something unexpected. | Start the sign-in again. |
| `DEVICE_FLOW_DISABLED` | The OAuth App has Device Flow turned off. | Enable Device Flow in the app settings, or use a fine-grained personal access token. |
| `CLIENT_ID_UNKNOWN` | GitHub does not know the `clientId`. | Check the plugin option clientId, or use a fine-grained personal access token. |
| `DEVICE_GRANT_REJECTED` | GitHub rejected the device sign-in request. | Update the plugin, or use a fine-grained personal access token. |
| `TOKEN_FORMAT` | The pasted text is not a GitHub personal access token. | Paste a token that starts with github_pat_ or ghp_. |
| `TOKEN_REJECTED` | GitHub rejected the token: invalid, expired or revoked. | Create a new token and try again. |
| `TOKEN_FORBIDDEN` | GitHub refused the token (HTTP 403). | Check that it is allowed for your account or organization, then try again. |
| `TOKEN_CHECK_TIMEOUT` | GitHub did not answer the token check within 10 seconds. | Try again. |
| `TOKEN_CHECK_UNREACHABLE` | api.github.com could not be reached. | Check your network, then try again. |
| `TOKEN_CHECK_FAILED` | GitHub could not check the token, or returned no account name. | Try again later. |
| `READ_ONLY` | A `github_api` call would change GitHub, and `access` is `"read-only"` (or the deprecated `readOnly: true`). | Tell the user that this needs the plugin option `access: "all"`, which they set in opencode.json; each change then runs without asking, unless they keep `ask-changes`. |
| `AUTH_REQUIRED` | `github_api`, `events_list` or `probe` has no GitHub sign-in to use. | Run /connect and choose GitHub (GitHub Enterprise with `host`). |
| `PERMISSION_DENIED` | A rule asks or denies a call, and the caller is a script or `events_list`: an `ask` cannot be answered and a `deny` refuses. For `github_api` the rule must name the request's own `METHOD /path`; for `events_list`'s reads it is `github_events_list` on the same resource. | Add or narrow the rule for the session or for its agent. |
| `API_INPUT_INVALID` | The `github_api` input does not fit, for example `download` with a method other than GET. | Fix the github_api input and call it again. |
| `API_PATH_INVALID` | The path is not a relative API path, has a `.` or `..` segment (also percent-encoded), or percent-encodes a character it can hold as itself. | Pass a relative API path such as /repos/OWNER/REPO/pulls. |
| `API_GRAPHQL_PATH` | `/graphql` was called through method and path. | Pass { graphql: { query, variables } } instead. |
| `API_FILE_OUTSIDE_PROJECT` | A download or upload file is outside the project. | Use a path inside the project folder. |
| `API_FILE_EXISTS` | The download file already exists. | Choose another path, or pass download.overwrite: true. |
| `API_UPLOAD_TOO_LARGE` | The upload file is over 100 MiB. | Upload files up to 104857600 bytes. |
| `API_DOWNLOAD_TOO_LARGE` | The download is over 2 GiB; the partial file is removed. | Narrow the request, or download it outside OpenCode. |
| `API_UNREACHABLE` | The API host could not be reached. | Check your network, then try again. |
| `API_REDIRECT_LOOP` | GitHub redirected more than 5 times. | Try again later. |
| `API_REDIRECT_INSECURE` | GitHub redirected to a non-HTTPS address. | Try again later. |
| `API_REDIRECTED` | GitHub redirected a change, which is never followed. The message names the new path. | Call github_api again with path <the new path>, so the change is checked for that path. |
| `API_REDIRECT_OFF_HOST` | GitHub redirected a read outside its API. | For job logs, call get_job_logs with return_content: true; for other files, pass download: { path }, which follows GitHub's storage redirects without the token. A script gets the get_job_logs method instead, and with `host` the step names only download. |
| `INPUT_INVALID` | The `events_list` or `probe` input breaks the source contract, or a listing with a cursor names no account. | Pass only since, cursor, limit (1 to 500), account and source, as the tool's schema describes; pass account with a cursor. |
| `SOURCE_UNKNOWN` | `events_list` or `probe` names a source the plugin does not have. | Leave source out, or pass github. |
| `CURSOR_INVALID` | The cursor was not issued by GitHub's `events_list` for this account and its signed-in user, or was changed. | Call events_list without a cursor, with since, to start again. |
| `ACCOUNT_MISMATCH` | `events_list` or `probe` names another account than the signed-in login, or a cursor issued for another account. | Pass the account the cursor was issued for, or sign in to GitHub as that account; probe names the signed-in login. |
| `TOO_LARGE` | One result of an `events_list` search, or one page of notifications, is over the 100,000 bytes `github_api` reads whole, so no page size reads it. | Read it with GitHub's own tools; a later call does not list it either. |
| `UNAVAILABLE` | A search, notifications or `GET /user` read for `events_list` or `probe` failed, or the sign-in names no login. | Call it again with the same cursor; if it keeps failing, run /github-status. |

A script's calls through the tools RPC, `github.platform.tools`, have more codes for sessions, permissions and the
server's state; see [Scripting](scripting.md#errors).

When the status cannot be read, the `/github` view shows "GitHub status unavailable. Run /github-status for
details."

On OpenCode 2.2.3 and 2.2.4, a device sign-in that fails before the code is shown, and a pasted token that fails its
check, appear only as `UnexpectedStatus: 500`; the coded message is in OpenCode's log. Failures while OpenCode waits
for you to enter the device code are shown as written.
