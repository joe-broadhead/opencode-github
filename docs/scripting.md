# Scripting

Unofficial plugin. Not affiliated with GitHub.

A script can call GitHub's read tools and `github_api`'s reads with no model: a cron job, a shell script, or any
program that can reach the OpenCode server. It uses the tools RPC, `github.platform.tools`, through `opencode api` or
an OpenCode client.

| Method | The tool | Default rule |
| --- | --- | --- |
| One per known read of GitHub's MCP server, named as the tool: `get_me`, `issue_read`, `pull_request_read`, `get_file_contents`, `search_code`, `list_dependabot_alerts` and the others in the [toolsets table](configuration.md#toolsets) | `github_<method>`, for example `github_issue_read` | allow |
| `api` | `github_api`, for reads only: REST `GET` or `HEAD`, or one GraphQL query | runs: reads assert nothing |
| `describe` | none: lists the methods, their permission actions, whether each can run now (`available`, and when not, the code in `reason` and for `TOOL_UNAVAILABLE` a `detail`), and each one's input as JSON Schema | |

Each MCP method runs GitHub's own tool with the same input, through OpenCode's own connection and sign-in. The plugin
never sees the GitHub token for these calls. Only the known reads are methods: GitHub's writes (such as
`issue_write`, `create_pull_request` and `merge_pull_request`), the hidden `ui_get`, and any tool GitHub adds later are
never methods, even with an allow rule.

A method runs only while GitHub's server lists its tool. A toolset that is off in the plugin's `toolsets` option leaves
its methods unavailable: `describe` shows them with `available: false`, `reason: "TOOL_UNAVAILABLE"` and a `detail`
that names the method's toolset and what to add to `toolsets`, and a call fails with that code. By default that is the reads of `copilot_spaces`, `gists`, `github_support_docs_search`,
`governance`, `notifications`, `projects` and `stargazers`; the [toolsets table](configuration.md#toolsets) names each
method's toolset. Add it to `toolsets` and run `opencode reload`. With the
[`host`](configuration.md#host-github-enterprise-server) option (GitHub Enterprise Server) there is no MCP server, so
only `api` runs.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent, with exactly the
access its model would have:

- A tool that the agent's rules or the session's rules hide from the model is refused. OpenCode hides a tool when the
  last rule that matches its permission name, such as `github_issue_read` or `github_api`, on resource `*` is a
  `deny`.
- OpenCode then checks an MCP call itself, as it does for the model: the agent's rules, the session's rules, then
  saved approvals. `api` reads ask nothing, as for the model.
- No one answers a prompt for a script, so an `ask` is refused with `PERMISSION_DENIED` at once, and no prompt is left
  waiting. The plugin's default rules allow the known reads, so an agent with the default rules needs nothing more.
  An agent defined only in your config has no default rules (`/github-status` names it); its own rules decide.

Create the session once, with the agent the script runs as, and keep its id:

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build"}'
```

Session rules come after the agent's, so a session can narrow what its script may do. This one may only read pull
requests and call `api`:

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build","permissions":[
  {"action":"github_*","resource":"*","effect":"deny"},
  {"action":"github_pull_request_read","resource":"*","effect":"allow"},
  {"action":"github_list_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_api","resource":"*","effect":"allow"}
]}'
```

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other
key is allowed:

```sh
opencode api post /api/rpc/github.platform.tools/list_pull_requests -d '{"input":{
  "sessionID":"ses_…",
  "input":{"owner":"OWNER","repo":"REPO","state":"open","perPage":20}
}}'
```

The tool's input is GitHub's: `describe` shows each tool's schema as OpenCode lists it now.

```sh
opencode api post /api/rpc/github.platform.tools/describe -d '{"input":{}}'
```

An MCP method's result is `{"output": {"output": <the tool's structured content, or its text when it has none>,
"text": <the tool's text>}}`, as plain JSON. GitHub content in it is untrusted data: other people wrote it.

`opencode api` calls run in the OpenCode service's default location, your home directory, whatever directory you run
them from, with that location's GitHub connection. To target a project, call the HTTP API with
`?location[directory]=<dir>`, or create the session with `"location":{"directory":"<dir>"}`. `opencode api` ignores
`--param location[directory]=…`.

## `api`

`api` is `github_api` for reads, with the same sign-in, the same hosts and the same output. Its input is one of:

- REST: `{ method, path, query?, accept?, paginate?, maxPages?, maxItems? }`, where `method` is `GET` or `HEAD` and
  `path` is relative, such as `/repos/OWNER/REPO/branches/main/protection`.
- GraphQL: `{ graphql: { query, variables? } }`, with exactly one operation, a query.

```sh
opencode api post /api/rpc/github.platform.tools/api -d '{"input":{
  "sessionID":"ses_…",
  "input":{"graphql":{"query":"query { viewer { login } }"}}
}}'
```

The result is `github_api`'s output: `{ ok, status, data, contentType?, truncated, rateLimit?, pagination?, trust }`.
A REST error status, such as 404, is a result with `ok: false`, not an RPC error, as for the model. A redirect within
the API is followed only after `github_api`'s permission check passes for the new path, as for the model; no one can
answer an ask, so with the default rules it is refused with `PERMISSION_DENIED`. A redirect outside the API is
`API_REDIRECT_OFF_HOST`.

Anything else is refused with `SCRIPT_READ_ONLY` before any request: every other method (also `POST /markdown`, which
the model may call as a read), a GraphQL document that is not one query, `download` (a file write) and `upload`. This
holds with `readOnly: false` and with an allow rule for `github_api`, because a script cannot answer the prompt a
change asks for. Make changes from an OpenCode session.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and
`data: { code, next }`. `opencode api` prints the error as JSON, then the HTTP status (`HTTP 400 Bad Request` for
`failed`), and exits with status 1 for any RPC error, so a shell script can test `$?`.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `PERMISSION_DENIED` | The agent's or the session's rules deny the tool, or ask for an approval. |
| `SERVER_CONFLICT` | Your config or another plugin defines its own MCP server named github, which this plugin does not manage (`conflict` in `/github-status`). |
| `AUTH_REQUIRED`, `CONNECTING`, `CONNECTION_FAILED`, `DISABLED`, `NOT_REGISTERED` | The github server needs a sign-in, is still connecting, could not connect, is disabled, or is not registered, as with the `host` option. `/github-status` gives the details. `api` gives `AUTH_REQUIRED` when there is no GitHub sign-in. |
| `TOOL_UNAVAILABLE` | The server is connected, but GitHub does not list the tool, for example because its toolset is off. `describe`'s `detail` for the method names its toolset, and says whether the `toolsets` option turns it on. |
| `UPSTREAM_ERROR` | GitHub's MCP server answered with an error, such as a missing permission or an invalid input. The message holds the first line of GitHub's text, at most 300 characters, with tokens and URL query strings removed. |
| `CANCELLED` | The request was cancelled. |
| `SCRIPT_READ_ONLY` | An `api` call could change GitHub, or would download or upload a file. |
| `API_INPUT_INVALID`, `API_PATH_INVALID`, `API_GRAPHQL_PATH`, `API_UNREACHABLE`, `API_REDIRECT_LOOP`, `API_REDIRECT_INSECURE`, `API_REDIRECT_OFF_HOST` | `github_api`'s own errors, listed in [Errors](configuration.md#errors). |

OpenCode itself answers `rpc.invalid_input` for a body that is not the envelope above, `rpc.method_not_found` for a
method that does not exist, such as `issue_write`, and `rpc.unavailable` when the plugin is not loaded.

## Status

The status RPC, `github.platform`, returns what `/github-status` shows:

```sh
opencode api post /api/rpc/github.platform/status -d '{"input":{}}'
```

These fields have the same names and meanings in every plugin of this family:

| Field | Value |
| --- | --- |
| `version` | The plugin's version. |
| `host` | `{ version, range, tested }`: the OpenCode release, the supported range `>=2.2.3 <2.3.0`, and whether this release is one the plugin is tested on (2.2.3, 2.2.4 or 2.2.5). |
| `state` | `connected`, `sign_in_required`, `connecting`, `failed`, `disabled`, `not_configured` or `conflict`. |
| `unguardedAgents` | The agents without default rules, always present; `[]` when there are none. |
| `nextStep` | The Next step row; `Nothing to do.` when nothing is needed. |

GitHub's own fields sit beside them: `account`, `readOnly`, `toolsets`, `tools` (`visible`, `unknown`, `mode`),
`permissionsBlock` (the rules to copy, while agents are listed), `unmatchedRules` (`github_api` rule resources with an
upper-case owner or repo name, which never match), `hostWarning` (outside the range, with
`allowUntestedHost`) and `enterprise` (with `host`).

## What scripts cannot do

- Change anything on GitHub: GitHub's write tools are never methods, and `api` refuses writes.
- Download or upload files with `api`.
- Call a tool that GitHub adds later, even with an allow rule.
- Answer an approval prompt, or use a tool that asks.
- Use a token: the plugin returns none.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from
any plugin, do not run for them. GitHub records API calls in its audit logs, as it does for the model's calls.
