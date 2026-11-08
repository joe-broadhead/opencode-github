# Scripting

Unofficial plugin. Not affiliated with GitHub.

A script can call GitHub's tools with no model: a cron job, a shell script, or any program that can reach the OpenCode
server. It uses the tools RPC, `github.platform.tools`, through `opencode api` or an OpenCode client.

| Method | Class | The tool |
| --- | --- | --- |
| One per known tool of GitHub's MCP server, named as the tool: `get_me`, `issue_read`, `pull_request_read`, `get_file_contents`, `search_code`, `issue_write`, `merge_pull_request` and the others in the [toolsets table](configuration.md#toolsets) | `read` or `write` | `github_<method>`, for example `github_issue_read` |
| `api` | `write` | `github_api`: REST or GraphQL, with the whole input |
| `describe` | none | none: lists every method with its class, its permission action, whether it can run now (`available`, and when not, the code in `reason` and for `TOOL_UNAVAILABLE` a `detail`), and each one's input as JSON Schema; given a session, it also gives each method's resolved `permission` |

Each MCP method runs GitHub's own tool with the same input, through OpenCode's own connection and sign-in. The plugin
never sees the GitHub token for these calls. The hidden `ui_get` and any tool GitHub adds later are not methods.

A method runs only while GitHub's server lists its tool. A toolset that is off in the plugin's `toolsets` option leaves
its methods unavailable: `describe` shows them with `available: false`, `reason: "TOOL_UNAVAILABLE"` and a `detail`
that names the method's toolset and what to add to `toolsets`, and a call fails with that code. By default that is the tools of `copilot`, `copilot_issue_intents`, `copilot_spaces`, `gists`,
`github_support_docs_search`, `governance`, `notifications`, `projects` and `stargazers`; the [toolsets table](configuration.md#toolsets) names each
method's toolset. Add it to `toolsets` and run `opencode reload`. With the
[`host`](configuration.md#host-github-enterprise-server) option (GitHub Enterprise Server) there is no MCP server, so
only `api` runs.

## A rule must allow the call first

Every call resolves the method's permission action against the agent's rules and then the session's, the host's own
order; the last matching rule wins. Only `allow` runs:

- The plugin's default rules allow the 61 known reads and ask for every write, so a **read** needs nothing more.
- A **write**, such as `github_issue_write`, `github_create_pull_request`, `github_push_files` or `github_api`, needs a
  prior explicit `allow` in the session's or the agent's rules.
- An `ask` is refused with `PERMISSION_DENIED` before dispatch, because no one can answer a prompt, and no prompt is
  left waiting.
- A `deny` is refused too, and its next step names the rule to change.
- A saved "Always allow" from an earlier prompt does **not** authorize an ad-hoc script: it is not part of the agent's
  and session's rules, and a script's grant must be reviewable in config or in a job's approval. This is the one
  deliberate break from the earlier reads-only RPC.

An agent defined only in your config has no default rules (`/github-status` names it); its own rules decide.

Create a session for the script once, with the agent the script runs as, and keep its id (`data.id` in the reply). A
test of a script gets its own session too. Never borrow a session found through history or a session list: the script
would run as that session's agent, under its rules.

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build"}'
```

Session rules come after the agent's, so a session can narrow what its script may do, and it can grant one write for
one script without touching the agent's rules. This one may only read pull requests, call `api`, and comment on one
issue:

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build","permissions":[
  {"action":"github_*","resource":"*","effect":"deny"},
  {"action":"github_pull_request_read","resource":"*","effect":"allow"},
  {"action":"github_list_pull_requests","resource":"*","effect":"allow"},
  {"action":"github_api","resource":"*","effect":"allow"},
  {"action":"github_add_issue_comment","resource":"*","effect":"allow"}
]}'
```

A session rule also applies to that session's model turns. Create a session for the script alone. For a grant bound to
the exact script the user approved, use a Jobs one-off script job: its approval writes the run session's `allow` rules,
and the user sees the source, the methods and whom each write reaches before it exists.

The session must belong to the location you call. A session in another directory is `SESSION_UNKNOWN`.

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other
key is allowed:

```sh
opencode api post /api/rpc/github.platform.tools/list_pull_requests -H "x-opencode-directory:$PWD" -d '{"input":{
  "sessionID":"ses_…",
  "input":{"owner":"OWNER","repo":"REPO","state":"open","perPage":20}
}}'
```

Send the location explicitly with `-H "x-opencode-directory:$PWD"`. Without it, the call goes to the service's
default location, your home directory, which is not always the project you mean: there the session is unknown, or the
plugin is not loaded. The HTTP equivalents are the `location[directory]` query parameter and the same header.
`opencode api` ignores `--param location[directory]=…`.

The tool's input is GitHub's: `describe` shows each tool's schema as OpenCode lists it now.

```sh
opencode api post /api/rpc/github.platform.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{}}'
opencode api post /api/rpc/github.platform.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

`describe` with a session gives each method's resolved `permission` (`allow`, `ask` or `deny`), which is how a script
self-checks before it writes a call.

An MCP method's result is `{"output": {"output": <the tool's structured content, or its text when it has none>,
"text": <the tool's text>}}`, as plain JSON. GitHub content in it is untrusted data: other people wrote it.

## `api`

`api` is `github_api` with the same sign-in, the same hosts and the same output. Its input is one of:

- REST: `{ method, path, query?, body?, accept?, paginate?, maxPages?, maxItems?, download?, upload? }`, where `path`
  is relative, such as `/repos/OWNER/REPO/branches/main/protection`. `GET` and `HEAD` read; every other method changes
  GitHub and asserts `github_api` first.
- GraphQL: `{ graphql: { query, variables? } }`. A single query reads; any other document asserts `github_api` first.

```sh
opencode api post /api/rpc/github.platform.tools/api -H "x-opencode-directory:$PWD" -d '{"input":{
  "sessionID":"ses_…",
  "input":{"graphql":{"query":"query { viewer { login } }"}}
}}'
```

The result is `github_api`'s output: `{ ok, status, data, contentType?, truncated, rateLimit?, pagination?, trust }`.
A REST error status, such as 404, is a result with `ok: false`, not an RPC error, as for the model. A redirect within
the API is followed, as for the model; one outside the API is `API_REDIRECT_OFF_HOST`. For job logs, call the
`get_job_logs` method.

A change, a `download` (a file write inside the project) or an `upload` needs the same prior `allow` for
`github_api`; with it, it runs as the model's would, without a prompt. `readOnly: true` still refuses every change,
whoever calls it.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and
`data: { code, next }`. `opencode api` prints the error as JSON, then the HTTP status (`HTTP 400 Bad Request` for
`failed`), and exits with status 1 for any RPC error, so a shell script can test `$?`.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `PERMISSION_DENIED` | The rules resolve to `ask` (a script cannot answer) or to `deny`. The message names the action; the next step names the rule to add or remove. |
| `SERVER_CONFLICT` | Your config or another plugin defines its own MCP server named github, which this plugin does not manage (`conflict` in `/github-status`). |
| `AUTH_REQUIRED`, `CONNECTING`, `CONNECTION_FAILED`, `DISABLED`, `NOT_REGISTERED` | The github server needs a sign-in, is still connecting, could not connect, is disabled, or is not registered, as with the `host` option. `/github-status` gives the details. `api` gives `AUTH_REQUIRED` when there is no GitHub sign-in. |
| `TOOL_UNAVAILABLE` | The server is connected, but GitHub does not list the tool, for example because its toolset is off. `describe`'s `detail` for the method names its toolset, and says whether the `toolsets` option turns it on. |
| `UPSTREAM_ERROR` | GitHub's MCP server answered with an error, such as a missing permission or an invalid input. The message holds the first line of GitHub's text, at most 300 characters, with tokens and URL query strings removed. |
| `CANCELLED` | The request was cancelled. |
| `API_INPUT_INVALID`, `API_PATH_INVALID`, `API_GRAPHQL_PATH`, `API_FILE_OUTSIDE_PROJECT`, `API_FILE_EXISTS`, `API_UPLOAD_TOO_LARGE`, `API_DOWNLOAD_TOO_LARGE`, `API_UNREACHABLE`, `API_REDIRECT_LOOP`, `API_REDIRECT_INSECURE`, `API_REDIRECTED`, `API_REDIRECT_OFF_HOST` | `github_api`'s own errors, listed in [Errors](configuration.md#errors). `READ_ONLY` comes with the `readOnly` option. |

OpenCode itself answers `rpc.invalid_input` for a body that is not the envelope above, `rpc.method_not_found` for a
method that does not exist, such as `ui_get`, and `rpc.unavailable` when the plugin is not loaded.

## Status

The status RPC, `github.platform`, returns what `/github-status` shows:

```sh
opencode api post /api/rpc/github.platform/status -d '{"input":{}}'
```

These fields have the same names and meanings in every plugin of this family:

| Field | Value |
| --- | --- |
| `version` | The plugin's version. |
| `host` | `{ version, range, tested }`: the OpenCode release, the supported range `>=2.2.3 <2.3.0`, and whether this release is one the plugin is tested on (2.2.3, 2.2.4, 2.2.5 or 2.2.6). |
| `state` | `connected`, `sign_in_required`, `connecting`, `failed`, `disabled`, `not_configured` or `conflict`. |
| `unguardedAgents` | The agents without default rules, always present; `[]` when there are none. |
| `nextStep` | The Next step row; `Nothing to do.` when nothing is needed. |

GitHub's own fields sit beside them: `account`, `readOnly`, `toolsets`, `tools` (`visible`, `unknown`, `mode`),
`permissionsBlock` (the rules to copy, while agents are listed), `unmatchedRules` (`github_api` rule resources with an
upper-case owner or repo name, which never match), `shadowedSkills` (`{ id, path }` for each of the plugin's skills
that a same-id skill at another path replaces), `hostWarning` (outside the range, with
`allowUntestedHost`) and `enterprise` (with `host`).

## What scripts cannot do

- Run a write without a prior explicit `allow` in the agent's or the session's rules. A saved "Always allow" is not
  enough.
- Call a tool GitHub adds later, or the hidden `ui_get`.
- Answer an approval prompt: an `ask` is refused.
- Use a token: the plugin returns none.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from
any plugin, do not run for them. GitHub records API calls in its audit logs, as it does for the model's calls.
