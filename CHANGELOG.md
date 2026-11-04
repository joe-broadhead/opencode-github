# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] - 2026-11-04

### Added

- A `jelly` section in `package.json`, which [Jelly](https://heyjelly.ai) reads without loading the plugin:
  - every known tool and `github_api`, with its permission, the effect the plugin's default rules give it and
    whether it only reads, so that Jelly's agents, which have no base allow rule for those rules to follow, still
    ask before a write. It includes `issue_artifact_read` (runs) and `issue_artifact_write` (asks);
  - the skill ids, and the name Jelly shows on the plugin's card;
  - two sign-ins, of which one connected is enough: the `github` server's, and the **GitHub Enterprise** one that
    the `host` option uses.

  [docs/jelly.md](https://github.com/joe-broadhead/opencode-github/blob/HEAD/docs/jelly.md) explains each part.

## [0.0.2] - 2026-11-04

### Fixed

- **Security:** `github_api` checked its permission rules against the path as written, but sent the request to the
  path after the URL parser removed percent-encoded dot segments such as `.%2e`, `%2e.` and `%2e`. A write could
  therefore reach another repository or endpoint than the one an allow or deny rule named, and the prompt showed the
  wrong path. It now refuses a `.` or `..` segment however it is encoded (double encoding too) and a percent-encoded
  character a path can hold as itself, such as `%6F` for `o`, with `API_PATH_INVALID`, before any prompt or request.
  The path that rules and the prompt see is exactly the path sent, on GitHub.com and with `host`, for uploads too.
- **Security:** `github_api` rules could be dodged by case and by redirects. GitHub reads owner and repository names
  (and organisation, user, team, environment, label, secret and variable names) without regard to case, so a deny on
  `/repos/owner/prod/*` did not stop `/repos/Owner/Prod/…`. The permission resource now has those names in lower
  case; write rules that way. The status lists rules with an upper-case owner or repo name, which never match, under
  "Rules that never match". And a redirect could take a call to a path no rule had checked: a change now never
  follows one (`API_REDIRECTED`, naming the new path), a read follows one within the API only after the permission
  check passes for the new path, and a read redirected outside the API fails with `API_REDIRECT_OFF_HOST`. Downloads
  still follow GitHub's storage redirects without the token. The tools RPC's `api` method does the same.
- Status listed agents whose own rules already ask for or deny GitHub's tools, such as agents that end with
  `* * ask`, as agents without default rules. It now lists an agent only when its rules would let a GitHub tool run
  without asking.
- Status said "Nothing to do." while it listed agents without default rules. The next step now names them and the
  fix.
- `github_api` downloads had no size limit. A download now stops at 2 GiB with `API_DOWNLOAD_TOO_LARGE`, checked
  against `Content-Length` and while it streams, and the partial file is removed.
- A `github_api` download without `overwrite` could replace a file created while it ran. It now keeps that file and
  fails with `API_FILE_EXISTS`.
- A download to a file that already exists asked for approval first and only then failed. It is now refused before
  the prompt.
- The scripting docs said `opencode api` runs in the directory you call it from. It runs in the OpenCode service's
  default location, your home directory; the docs now say how to target a project. They also say that `opencode api`
  exits with status 1 on an RPC error, and that a tool with no structured content returns its text as `output`.
- The README says to run `opencode reload` after install, how to update, and orders Uninstall as sign out, remove,
  data folders (none) and copied rules. Its sign-out step is `opencode auth logout GitHub <login>`: without the
  account's label the command needs an interactive terminal, and a token left behind after removing the plugin no
  longer shows in `opencode auth list`.
- `/github-status` and the dialog left out the Account and Agents without default rules rows when they were empty,
  and `/github-status` had no title line. Every row is now shown, with `none` where it is empty, under
  "GitHub status".

### Changed

- `POST /markdown` and `POST /markdown/raw` through `github_api` are reads: they only render Markdown, so they run
  without a prompt and also while read-only. Every other POST is still a write.
- Code Mode shows a description for the `github` namespace, and every `github_api` input field has one.
- `issue_artifact_read` (a read) and `issue_artifact_write` (a write), which github-mcp-server v2.1.0 adds to the
  `issues` toolset behind a feature flag the plugin does not turn on, are known tools.
- A script's `TOOL_UNAVAILABLE` next step names the toolsets that are off by default, and says to add the method's
  toolset to `toolsets` and run `opencode reload`.
- The tools RPC's shared module is updated: `describe` given any input but nothing or `{}` answers
  `describe takes no input`, an envelope that is not an object gets a plain message, a permission refusal names the
  action that was refused, and a server that reconnects during a call gives `CONNECTING` instead of
  `CONNECTION_FAILED`.
- OpenCode 2.2.5 is a tested release. The status calls 2.2.3, 2.2.4 and 2.2.5 tested, and a later 2.2 release
  "untested; supported range >=2.2.3 <2.3.0". `HOST_UNTESTED` and the `allowUntestedHost` warning now say "outside
  the supported range".
- The status RPC (`github.platform`) has the fields every plugin of this family shares
  ([Scripting](https://github.com/joe-broadhead/opencode-github/blob/HEAD/docs/scripting.md#status)):
  - new `version`, the plugin's version;
  - `host` is `{ version, range, tested }`; `host.warning` is now `hostWarning`;
  - `state` values: `needs_auth` is now `sign_in_required`, `pending` is now `connecting`, and `not_registered` is
    now `not_configured`.

## [0.0.1] - 2026-11-03

### Added

- The tools RPC, `github.platform.tools`: a script can call GitHub's known MCP reads, and `api` (`github_api` limited
  to REST GET and HEAD and single GraphQL queries), with no model, through `opencode api`, as a session and its agent.
  It gets exactly the access that agent's model has: a tool its rules hide is refused, OpenCode checks each MCP call
  against the agent's and the session's rules, and an ask is refused at once because no one is there to answer it.
  `describe` lists the methods with each tool's live input schema. GitHub's writes, `ui_get` and any tool GitHub adds
  later are never methods, and `api` refuses changes, downloads and uploads with `SCRIPT_READ_ONLY` before any
  request. With `host` (GitHub Enterprise Server) only `api` runs. `docs/scripting.md` explains it.

### Changed

- `check_dependency_vulnerabilities`, which GitHub's hosted server now lists in the `dependabot` toolset, is a known
  read: it looks up a list of packages in the GitHub Advisory Database and changes nothing, so it runs without a
  prompt, and `/github-status` no longer lists it as unknown.

## [0.0.0] - 2026-11-01

### Added

- GitHub's hosted MCP server, registered under the name `github`. GitHub's `X-MCP-Toolsets`, `X-MCP-Readonly` and
  `X-MCP-Lockdown` headers select the tools; read-only by default. The default toolsets are every read-only
  toolset that the default `repo read:org` scopes cover, including Actions logs and security alerts; `ui_get`, the
  MCP Apps data feed, is hidden.
- Sign-in on the `github` server's integration from `/connect`, `opencode auth login GitHub` and
  `opencode mcp auth github`: a fine-grained personal access token (`github-token`), with the token page prefilled
  for the default toolsets, and device sign-in (`github-device`) when `clientId` names an organisation's own OAuth
  App. A token that GitHub later rejects marks the account as needing sign-in.
- `github_api`, a tool for GitHub's REST and GraphQL API with the same sign-in, for what the MCP tools cannot do:
  auto-merge, releases and their assets, branch protection, rulesets, variables, artifacts and any GraphQL. Reads
  run; changes ask through `github_api` rules on `METHOD /path` and are refused while read-only. Requests stay on
  GitHub's API host, and redirects elsewhere are followed without the token.
- Option `host` for GitHub Enterprise Server: no MCP server there, `github_api` against the server's API, and sign-in
  on a **GitHub Enterprise** integration (token, or device flow with the server's own `clientId`).
- Default permission rules in every agent with a base allow rule: known GitHub reads run, and writes and unknown
  GitHub tools ask. User rules and saved approvals still win.
- Options `toolsets`, `readOnly`, `lockdown`, `unknownTools`, `clientId`, `scopes`, `allowUntestedHost` and `host`.
- One status, shown by `/github-status` and by the `/github` dialog in the TUI (palette **GitHub: Status**): state,
  account and access, tools and unknown tool names, agents without the default rules with the rules to add, the
  OpenCode check and the next step.
- A tested-host check: outside `>=2.2.3 <2.3.0` the plugin refuses to load with `HOST_UNTESTED`, unless
  `allowUntestedHost` is set.
- Error messages that start with their code (`OPTIONS_INVALID`, `HOST_UNTESTED`) and end with a next step.
- Skills `github-pr-review`, `github-issue-triage` and `github-code-research`.
