# Security

## Supported versions

Only the newest release is supported, on the OpenCode releases it is tested on (`>=2.2.3 <2.3.0`).

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue. Include the plugin version, the OpenCode version and the steps to
reproduce, and never include tokens or other secrets. Fixes go into the newest release.

## Data handling

### Network access

The plugin's own code connects only to these GitHub endpoints:

| Endpoint | Used for |
| --- | --- |
| `https://api.githubcopilot.com/mcp/` | GitHub's MCP server. OpenCode's MCP client makes these requests. |
| `https://github.com/login/device/code` and `https://github.com/login/oauth/access_token` | Device sign-in, only when `clientId` is set. |
| `https://api.github.com/user` | Checking a credential and reading its GitHub login. |
| `https://<host>/login/…`, `https://<host>/api/v3`, `/api/graphql` and `/api/uploads` | Only with the `host` option: sign-in and `github_api` on your GitHub Enterprise Server, instead of the github.com endpoints. |
| `https://api.github.com` and `https://uploads.github.com` | The `github_api` tool. It refuses any other host. A download follows GitHub's redirects to its file storage (logs, artifacts, release assets) without the token; other calls never leave the API. |

It sends no telemetry. Apart from following a download's redirects to GitHub's file storage, it contacts no other
service.

### Credentials

- OpenCode stores the credential, a GitHub OAuth token or a personal access token, and sends it to GitHub's MCP
  server as a Bearer token. The plugin keeps no copy and writes nothing to disk.
- The plugin never logs a token, a device code or a raw GitHub response, and its error messages contain none of
  them. `github_api` sends the token only to GitHub's API and uploads hosts, never on a redirect to another host.
- No client secret or OAuth App client ID ships. Device sign-in is offered only when `clientId` names an OAuth App,
  and needs only its public client ID.
- When you paste a token into `opencode auth login` on OpenCode 2.2.3, the terminal shows it as you type. Clear the
  screen afterwards if others can see it.
- To revoke access, sign out in OpenCode (`opencode auth logout GitHub <login>`, with your GitHub login), then revoke
  the app under **GitHub Settings → Applications → Authorized OAuth Apps**, or delete the token under **Developer
  settings → Personal access tokens**.

### Scopes and least privilege

- Device sign-in (with `clientId`) asks for `repo` and `read:org`. Classic OAuth scopes cannot be read-only: `repo` grants read and
  write access to every repository your account can reach.
- `access: "read-only"` limits which tools GitHub offers. It does not limit what the token can do.
- A fine-grained personal access token is the least-privilege choice. It reaches only the repositories you select,
  with only the permissions you grant, and GitHub enforces both. Use read-only permissions unless you need writes.
- The plugin has no repository allowlist of its own; repository scope comes from the token.

### Untrusted content

Everything that GitHub returns is untrusted input to the model: issue and pull request text, comments, commit
messages, file contents, release notes and search results. Anyone who can write to a repository you read, including
public issues, can place text that tries to steer your agent.

- Use `access: "read-only"` unless you need changes, and `"ask-changes"` while agents read untrusted repositories.
- Do not allow write tools broadly with rules or **Always allow** while agents read untrusted repositories.
- `lockdown: true` turns on GitHub's lockdown mode. In public repositories it limits issue and pull request content
  to items from users with push access. It is a best-effort content filter, not a security boundary.
- The skills tell the model to treat GitHub content as data and to change nothing unless you ask, but instructions
  in a skill are not a security control. The permission rules are.

## Permissions

- **Everything is allowed by default.** Every tool the plugin registers runs without a prompt, and so does a tool
  GitHub adds later, so an agent can read and change everything the signed-in token can reach: push, merge, delete a
  repository, run workflows, and make any `github_api` REST or GraphQL call. Nothing asks first. To restrict it, set
  the plugin option `"access": "ask-changes"` (reads run, every change asks) or `"access": "read-only"` (reads run,
  every change is denied and GitHub's own server lists no write tools), give the agent its own later rules, or add a
  rule per tool. The README's Permissions section has the three ways and the generated block.
- Values can still be refused by GitHub itself: a token without write scope cannot push, and GitHub Enterprise admins
  can restrict a token further.
- **Saved approvals are project-wide.** Choosing **Always allow** saves the approval for the whole project, for every
  agent in it, including Plan. A folder that is not in a git repository with a commit belongs to OpenCode's shared
  `global` project, so an approval saved there applies to every such folder.
- **Agents defined only in your config get no default rules.** Their own rules decide; with none, a GitHub tool runs.
  The status names these agents and shows the block to add to their own `permissions`.
- For a hard stop, use a `deny` rule. An `ask` can be approved. Write `github_api` rules with lower-case owner and
  repo names: the plugin checks those names in lower case, as GitHub reads them, so a rule in another case never
  matches. The status lists such rules.
- The default `github_*` rule also matches tools of any other MCP server whose name starts with `github_`.

See [docs/configuration.md](docs/configuration.md#permissions).

## Scripts

The tools RPC (`github.platform.tools`, see [docs/scripting.md](docs/scripting.md)) calls GitHub's tools for a script,
with no model. Every known tool is a method, with its class, but a method is not a grant:

- A script names a session that names an agent, and runs as them. Before any call, the plugin resolves that method's
  permission action against the agent's rules and then the session's rules, the host's own order. Only `allow` runs: a
  rule that resolves to `ask` is refused because no one can answer it, and a `deny` is refused. Neither makes a call.
  A script gets the same default as the model, so at `access: "all"` it can read and change what the token can; under
  `"ask-changes"` an ask is refused and under `"read-only"` a change is denied. `api` adds one more step: a change,
  a download and an upload resolve `github_api` on the call's own `METHOD /path`, from a prior explicit `allow` only,
  so an allow scoped to GETs cannot POST.
- A saved "Always allow" is **not** consulted: it lives outside the agent's and session's rules, so an old click does
  not authorize a new script. A grant is reviewable in config, or in a Jobs one-off's approval.
- After the resolve, an MCP call runs through OpenCode's own executor, which checks the action again, as for the
  model. `api` runs `github_api`'s own spec, so a write, a download or an upload asserts `github_api` itself with the
  call's own source, and `access: "read-only"` still refuses every change. The plugin's permission hook still changes only
  an `ask` on one of its own script calls in flight, only to a deny, and leaves every other call alone. The default
  rules themselves use no hook.
- `ui_get` is hidden from every agent's tools, and it and any tool GitHub adds later are not methods.
- `events_list` (`github_events_list`) asserts `github_events_list`, then makes only GET requests through `api`'s
  own handling, plus `get_me`: it returns the titles, bodies (cut to 4,096 characters), commit messages, logins and
  links of what the signed-in user was involved in, with that login as the owner. Memory's collector calls it to copy
  these events to your private memory space, after you turn GitHub on as a source; the plugin itself sends them
  nowhere and stores nothing.
- MCP calls go through OpenCode's own connection and sign-in, and `api` uses the same sign-in, hosts and redirect
  handling as `github_api`. No token is returned.
- GitHub's MCP error text reaches the script only as the first line, at most 300 characters, with tokens and URL query
  strings removed. Results are GitHub content, which is untrusted, as for the model.
- A session in another location is `SESSION_UNKNOWN`, and a call that names no location reaches the service's default
  location: send `x-opencode-directory` with each call.
- OpenCode's `execute.before` and `execute.after` tool hooks, from any plugin, do not run for a script's call, so
  another plugin's policy hook does not see it. A script's calls are not recorded in the session; GitHub records API
  calls in its audit logs.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The
  session is not a login: it scopes a script to what its agent may do.
