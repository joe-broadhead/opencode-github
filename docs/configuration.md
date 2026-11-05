# Configuration

Set options in the plugin's entry in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "@joe-broadhead/opencode-github",
      "options": {
        "toolsets": ["context", "repos", "issues", "pull_requests"],
        "readOnly": true,
        "lockdown": false,
        "unknownTools": "ask"
      }
    }
  ]
}
```

Every option is optional. An unknown option or a wrong value
stops the plugin from loading with an error that names the option, for example:

```text
OPTIONS_INVALID: Invalid plugin option "toolset": this option does not exist. Next step: Fix the options for @joe-broadhead/opencode-github in opencode.json.
```

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `toolsets` | every toolset marked "default" below | GitHub toolsets to load, sent as GitHub's `X-MCP-Toolsets` header. At least one, each once, from the [list below](#toolsets). |
| `readOnly` | `true` | Sent as GitHub's `X-MCP-Readonly` header. With `false`, GitHub also offers write tools, and they ask first. |
| `lockdown` | `false` | With `true`, sends GitHub's `X-MCP-Lockdown: true` header. See [`lockdown`](#lockdown). |
| `unknownTools` | `"ask"` | `"ask"` keeps GitHub tools the plugin does not know visible, and they ask first. `"hide"` removes them. See [`unknownTools`](#unknowntools). |
| `clientId` | none (token sign-in only) | A GitHub OAuth App for device sign-in; with it `/connect` also offers **Sign in with GitHub**. Letters, digits, `.`, `_` and `-`, up to 100 characters. See [`clientId` and `scopes`](#clientid-and-scopes). |
| `scopes` | `["repo", "read:org"]` | Scopes that device sign-in asks for, each once. Tokens are not affected. |
| `allowUntestedHost` | `false` | Load on an OpenCode release outside the supported range `>=2.2.3 <2.3.0`, with a warning in the status. See [`allowUntestedHost`](#allowuntestedhost). |
| `host` | none (github.com) | A GitHub Enterprise Server host name, such as `github.example.com`. See [`host`](#host-github-enterprise-server). |

The MCP server name (`github`) and URL (`https://api.githubcopilot.com/mcp/`) are fixed. Changing an option keeps
the name, so you stay signed in.

## Toolsets

These are the toolsets of GitHub's MCP server, with the tools the plugin knows in each. Read tools run without a
prompt; write tools appear only with `readOnly: false`, and ask first. Tool names in OpenCode carry the server
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

GitHub's tools are available to agents through Code Mode, in the `github` namespace. The plugin keeps three entry
tools in the model's direct tool list: `github_get_me`, `github_issue_read` and `github_pull_request_read`.

## Permissions

### The shipped model: default rules per agent

The plugin adds default rules to each agent; there is no allow-list option and no permission hook. For every agent
whose rules contain OpenCode's base rule `{ "action": "*", "resource": "*", "effect": "allow" }`, it inserts this
block directly after it:

```json
[
  { "action": "github_*", "resource": "*", "effect": "ask" },
  { "action": "github_actions_get", "resource": "*", "effect": "allow" },
  { "action": "github_actions_list", "resource": "*", "effect": "allow" },
  …one allow rule for each read tool in the table above, sorted by name…
  { "action": "github_search_users", "resource": "*", "effect": "allow" }
]
```

`/github-status` prints the complete block when an agent needs it.

- The block is the same for every option. It allows every catalogued read, whichever toolsets are on.
- Agents without the base allow rule are unchanged. The block is added once, even after a reload.
- OpenCode applies the last rule that matches. So the agent's own later rules still win (Plan keeps its rules, and
  Explore still denies GitHub tools), then your top-level `permissions` rules, then saved approvals.
- MCP tool permissions use the tool name as the action and `*` as the resource, so rules cannot target a repository.

The result:

- Known reads run without a prompt, including in `opencode run`.
- Writes and tools the plugin does not know ask first. In `opencode run`, nobody is present to answer, so they are
  denied.
- **Always allow** at a prompt is saved for the project and applies to every agent in it, including Plan. A folder
  that is not in a git repository with a commit belongs to OpenCode's shared `global` project.

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

Ask before every GitHub tool, reads included:

```json
{ "permissions": [{ "action": "github_*", "resource": "*", "effect": "ask" }] }
```

Keep one agent away from GitHub: add `{ "action": "github_*", "resource": "*", "effect": "deny" }` at the end of that
agent's own `permissions` list.

For a hard stop, use `deny`. An `ask` can be approved, and an approval saved with **Always allow** applies to the
whole project.

### Agents defined only in your config

OpenCode creates agents that exist only in your config after plugins run, so they do not get the default rules.
They run GitHub tools, including writes, without asking. `/github-status` and the `/github` dialog list them under
"Agents without default rules", and the next step names them. An agent whose own rules already ask for or deny
GitHub's tools, such as one that ends with `{ "action": "*", "resource": "*", "effect": "ask" }`, needs no fix and is
not listed.

To fix an agent, put the default block **first** in **that agent's own** `permissions` list, followed by your
top-level rules for `github_` tools, so they keep winning:

```json
{
  "permissions": [{ "action": "github_merge_pull_request", "resource": "*", "effect": "deny" }],
  "agents": {
    "reviewer": {
      "description": "Reviews changes",
      "mode": "subagent",
      "permissions": [
        { "action": "github_*", "resource": "*", "effect": "ask" },
        …the rest of the block from /github-status…
        { "action": "github_merge_pull_request", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

The same applies to an agent defined in a Markdown file: add the rules to its `permissions`. Once the block is in
place, the status stops listing the agent.

Do not put the block in the top-level `permissions`. Top-level rules come after every agent's built-in rules, so the
block would weaken Explore and any other agent that denies by default: its denied GitHub reads would become allowed,
and its denied GitHub writes would ask.

### The `github_*` wildcard

MCP tool names are `<server>_<tool>`. The default `github_*` ask rule also matches tools of any other MCP server
whose name starts with `github_`, such as a server named `github_enterprise`. Those tools ask first. Name other
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
are untrusted GitHub content.

**Reads and writes.** GET and HEAD read, and so do `POST /markdown` and `POST /markdown/raw`, which only render
Markdown; every other POST writes. A GraphQL document reads only when it holds exactly one operation and that
operation is a query; the plugin scans the document itself, skipping strings and comments. Everything else is a
write: it asks first, as `github_api` on `METHOD /path` (`POST /graphql` for GraphQL), and with `readOnly: true` it is
refused with `READ_ONLY`. In that path, the names GitHub reads without regard to case are in lower case (see Rules). Saving a download asks as `download <file>`, also while read-only. Reads never ask.

**Hosts and the token.** Requests go only to `https://api.github.com`, and uploads to `https://uploads.github.com`; with
[`host`](#host-github-enterprise-server), to the server's own API. The plugin handles redirects itself:

- A change (any method but GET and HEAD, GraphQL and uploads included) never follows one. It fails with
  `API_REDIRECTED`, which names the new path, so you can call again with that path and have it checked there.
- A GET or HEAD follows a redirect within the API base, such as a renamed repository's, without asking, as reads
  never ask. A read redirected outside the API fails with `API_REDIRECT_OFF_HOST`.
- A download follows a redirect within the API too, and one to the storage that serves logs, artifacts and release
  assets, without the `Authorization` header. For job logs, GitHub's `get_job_logs` tool returns the text.
- Pagination follows a `Link` only under the API base path.

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

- With `"ask"` (the default), it stays visible and asks before it runs. Known tools keep working.
- With `"hide"`, the plugin removes it from the agents' tools.

The status names the unknown tools GitHub currently offers. Both modes apply only to the plugin's own `github`
server.

## Fine-grained token permissions

With a fine-grained personal access token, each default toolset needs a read permission on the token: Metadata,
Contents, Issues, Pull requests and Commit statuses (`repos`, `issues`, `pull_requests`, `labels`, `git`), Actions
(`actions`), Code quality (`code_quality`), Code scanning alerts (`code_security`), Dependabot alerts
(`dependabot`), Secret scanning alerts (`secret_protection`), Repository security advisories
(`security_advisories`) and Discussions (`discussions`); for an organisation, also Members (the team tools) and
Issue Types and Issue Fields. The token page that `/connect` opens fills in the repository permissions. A missing
one fails with "Resource not accessible by personal access token", and `github_api` names the permission in its
next step. Device sign-in needs none of this.

## `clientId` and `scopes`

No OAuth App ships with the plugin, so by default only token sign-in is offered. To add device sign-in, set
`clientId` to an OAuth App's public client ID; no client secret is used or shipped.

To use your own OAuth App, register it under **GitHub Settings → Developer settings → OAuth Apps → New OAuth App**,
tick **Enable Device Flow**, do not generate a client secret, and set its client ID:

```json
{ "plugins": [{ "package": "@joe-broadhead/opencode-github", "options": { "clientId": "<your OAuth App client ID>" } }] }
```

`scopes` changes what device sign-in asks for, for example `["public_repo"]` for public repositories only. Scopes
are requested at sign-in; they are not part of the app.

An organisation can set `clientId` and `scopes` for everyone on a machine; see
[Organisation rollout](../README.md#organisation-rollout).

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
{ "plugins": [{ "package": "@joe-broadhead/opencode-github", "options": { "host": "github.example.com", "clientId": "<the server's OAuth App client ID>" } }] }
```

For GitHub's MCP tools on the server, run GitHub's `github-mcp-server` yourself as a local MCP server with
`GITHUB_HOST=https://<host>` and a token. Name it `github`: with `host` set the plugin registers no server of its
own, so the name is free, and the plugin's default rules then apply to its tools (known reads run, writes and
unknown tools ask).

GHE.com (data residency) is not supported yet; `host` refuses `*.ghe.com`.

## `allowUntestedHost`

The plugin supports OpenCode `>=2.2.3 <2.3.0` and is tested on 2.2.3, 2.2.4 and 2.2.5. On a later 2.2 release it
loads and works; the status shows `OpenCode: 2.2.6 (untested; supported range >=2.2.3 <2.3.0)`, and the status RPC
`host.tested: false`. GitHub does not use the `host_untested` state: its state stays the connection's. Outside the
range, including prereleases and development builds, it refuses to load:

```text
HOST_UNTESTED: OpenCode 2.3.0 is outside the supported range >=2.2.3 <2.3.0. Next step: Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.
```

With `allowUntestedHost: true`, it loads and the status shows this warning:

```text
OpenCode 2.3.0 is outside the supported range >=2.2.3 <2.3.0. It loaded because allowUntestedHost is set.
```

## Errors

The plugin's own errors read `CODE: what happened. Next step: what to do.` Errors from OpenCode and from GitHub are
passed through unchanged.

| Code | When | Next step |
| --- | --- | --- |
| `OPTIONS_INVALID` | An option is unknown or has a wrong value. The message names the option. | Fix the options for @joe-broadhead/opencode-github in opencode.json. |
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.3.0` and `allowUntestedHost` is not set. | Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true. |
| `SKILLS_INVALID` | A skill file shipped with the plugin is missing or malformed. | Reinstall the plugin. |
| `STATUS_UNAVAILABLE` | OpenCode did not report the `github` server's state. | Run /github-status again. |
| `SIGN_IN_EXPIRED` | The device code expired before it was entered. | Start the sign-in again. |
| `SIGN_IN_CANCELLED` | The sign-in was cancelled on GitHub. | Start the sign-in again. |
| `SIGN_IN_CODE_UNKNOWN` | GitHub did not recognise the device code. | Start the sign-in again. |
| `SIGN_IN_FAILED` | GitHub ended the device sign-in with another error, named in the message. | Start the sign-in again. |
| `SIGN_IN_UNREACHABLE` | github.com could not be reached. | Check your network, then start the sign-in again. |
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
| `READ_ONLY` | A `github_api` call would change GitHub, and `readOnly` is `true`. | Set the plugin option readOnly: false to allow changes; each one asks first. |
| `AUTH_REQUIRED` | `github_api` has no GitHub sign-in to use. | Run /connect and choose GitHub (GitHub Enterprise with `host`). |
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
| `API_REDIRECT_OFF_HOST` | GitHub redirected a read outside its API. | Pass download: { path } to save the response; a download follows GitHub's storage redirects, without the token. |
| `SCRIPT_READ_ONLY` | A script's `api` call could change GitHub, or would download or upload a file. | Call api with GET, HEAD or a single GraphQL query; make changes from an OpenCode session, where they ask first. |

A script's calls through the tools RPC, `github.platform.tools`, have more codes for sessions, permissions and the
server's state; see [Scripting](scripting.md#errors).

When the status cannot be read, the `/github` view shows "GitHub status unavailable. Run /github-status for
details."

On OpenCode 2.2.3 and 2.2.4, a device sign-in that fails before the code is shown, and a pasted token that fails its
check, appear only as `UnexpectedStatus: 500`; the coded message is in OpenCode's log. Failures while OpenCode waits
for you to enter the device code are shown as written.
