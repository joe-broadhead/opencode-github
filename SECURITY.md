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
| `https://api.github.com` and `https://uploads.github.com` | The `github_api` tool. It refuses any other host. Redirects to GitHub's file storage (logs, artifacts, release assets) are followed without the token. |

It sends no telemetry. Apart from following GitHub's redirects to its file storage, it contacts no other service.

### Credentials

- OpenCode stores the credential, a GitHub OAuth token or a personal access token, and sends it to GitHub's MCP
  server as a Bearer token. The plugin keeps no copy and writes nothing to disk.
- The plugin never logs a token, a device code or a raw GitHub response, and its error messages contain none of
  them. `github_api` sends the token only to GitHub's API and uploads hosts, never on a redirect to another host.
- No client secret or OAuth App client ID ships. Device sign-in is offered only when `clientId` names an OAuth App,
  and needs only its public client ID.
- When you paste a token into `opencode auth login` on OpenCode 2.2.3, the terminal shows it as you type. Clear the
  screen afterwards if others can see it.
- To revoke access, sign out in OpenCode (`opencode auth logout GitHub`), then revoke the app under **GitHub Settings →
  Applications → Authorized OAuth Apps**, or delete the token under **Developer settings → Personal access tokens**.

### Scopes and least privilege

- Device sign-in (with `clientId`) asks for `repo` and `read:org`. Classic OAuth scopes cannot be read-only: `repo` grants read and
  write access to every repository your account can reach.
- `readOnly: true`, the default, limits which tools GitHub offers. It does not limit what the token can do.
- A fine-grained personal access token is the least-privilege choice. It reaches only the repositories you select,
  with only the permissions you grant, and GitHub enforces both. Use read-only permissions unless you need writes.
- The plugin has no repository allowlist of its own; repository scope comes from the token.

### Untrusted content

Everything that GitHub returns is untrusted input to the model: issue and pull request text, comments, commit
messages, file contents, release notes and search results. Anyone who can write to a repository you read, including
public issues, can place text that tries to steer your agent.

- Keep `readOnly: true` unless you need writes, and keep writes on `ask`.
- Do not allow write tools broadly with rules or **Always allow** while agents read untrusted repositories.
- `lockdown: true` turns on GitHub's lockdown mode. In public repositories it limits issue and pull request content
  to items from users with push access. It is a best-effort content filter, not a security boundary.
- The skills tell the model to treat GitHub content as data and to change nothing unless you ask, but instructions
  in a skill are not a security control. The permission rules are.

## Permissions

- Known GitHub reads run without a prompt. Writes and unknown GitHub tools ask first, and in `opencode run` they are
  denied because nobody can answer.
- **Saved approvals are project-wide.** Choosing **Always allow** saves the approval for the whole project, for every
  agent in it, including Plan. A folder that is not in a git repository with a commit belongs to OpenCode's shared
  `global` project, so an approval saved there applies to every such folder.
- **Agents defined only in your config get no default rules.** They run GitHub tools, including writes, without
  asking, until you add the plugin's rules to their own `permissions`. The status names these agents.
- For a hard stop, use a `deny` rule. An `ask` can be approved.
- The default `github_*` ask rule also matches tools of any other MCP server whose name starts with `github_`.

See [docs/configuration.md](docs/configuration.md#permissions).

## Scripts

The tools RPC (`github.platform.tools`, see [docs/scripting.md](docs/scripting.md)) runs GitHub's read tools and
`github_api`'s reads for a script, with no model. It adds no authority:

- A script names a session that names an agent, and runs as them. A tool that the agent's or the session's rules hide
  from the model is refused. OpenCode's own executor then checks each MCP call against the agent's rules, the
  session's rules and saved approvals, as it does for the model. An `api` read asserts nothing, as for the model.
- An ask on a script's call is denied, not prompted: no one is there to answer it. The plugin's one permission hook
  changes only an ask on one of its own script calls in flight, only to a deny, and leaves every other call alone. The
  default rules themselves still use no hook.
- Only the known reads are methods. GitHub's write tools, `ui_get` and any tool that GitHub adds later are never
  methods, even with an allow rule. `api` refuses every call that could change GitHub, every GraphQL document that is
  not one query, `download` and `upload` with `SCRIPT_READ_ONLY` before any request, whatever `readOnly` and the rules
  say.
- MCP calls go through OpenCode's own connection and sign-in, and `api` uses the same sign-in, hosts and redirect
  handling as `github_api`. No token is returned.
- GitHub's MCP error text reaches the script only as the first line, at most 300 characters, with tokens and URL query
  strings removed. Results are GitHub content, which is untrusted, as for the model.
- OpenCode's `execute.before` and `execute.after` tool hooks, from any plugin, do not run for a script's call, so
  another plugin's policy hook does not see it. A script's calls are not recorded in the session; GitHub records API
  calls in its audit logs.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The
  session is not a login: it scopes a script to what its agent may do.
