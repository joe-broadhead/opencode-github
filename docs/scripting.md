# Scripting

Unofficial plugin. Not affiliated with GitHub.

A script can call GitHub's tools with no model: a cron job, a shell script, or any program that can reach the OpenCode
server. It uses the tools RPC, `github.platform.tools`, through `opencode api` or an OpenCode client. The call is:

```sh
opencode api post /api/rpc/github.platform.tools/<method> -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"<id>","input":{…}}}'
```

| Method | Class | The tool |
| --- | --- | --- |
| One per known tool of GitHub's MCP server, named as the tool: `get_me`, `issue_read`, `pull_request_read`, `get_file_contents`, `search_code`, `issue_write`, `merge_pull_request` and the others in the [toolsets table](configuration.md#toolsets) | `read` or `write` | `github_<method>`, for example `github_issue_read` |
| `api` | `write` | `github_api`: REST or GraphQL, with the whole input |
| `describe` | none | none: lists every method with its class, its permission action, whether it can run now (`available`, and when not, the code in `reason` and for `TOOL_UNAVAILABLE` a `detail`), and each one's input as JSON Schema; given a session, it also gives each method's resolved `permission` |

Each MCP method runs GitHub's own tool with the same input, through OpenCode's own connection and sign-in. The plugin
never sees the GitHub token for these calls. The hidden `ui_get` and any tool GitHub adds later are not methods.

A method runs only while GitHub's server lists its tool. A toolset that is off in the plugin's `toolsets` option leaves
its methods unavailable: `describe` shows them with `available: false`, `reason: "TOOL_UNAVAILABLE"` and a `detail`
that names the method's toolset and what to add to `toolsets`, and a call fails with that code. By default that is the
tools of `copilot`, `copilot_issue_intents`, `copilot_spaces`, `gists`, `github_support_docs_search`, `governance`,
`notifications`, `projects` and `stargazers`; the [toolsets table](configuration.md#toolsets) names each method's
toolset. Add it to `toolsets` and run `opencode reload`. With the
[`host`](configuration.md#host-github-enterprise-server) option (GitHub Enterprise Server) there is no MCP server, so
only `api` runs.

## A script runs as a session

Every call names a session, and the session must name an agent. Create it for the script once, with the agent the script
runs as, and keep its id (`data.id` in the reply):

```sh
opencode api post /api/session -d '{"title":"release digest","agent":"build"}'
```

Never borrow a session found through history or a session list: the script would run as that session's agent, under its
rules. The script then runs as that agent, with exactly the access its model would have:

- The rule for the call's permission action, such as `github_pull_request_read` or `github_api`, is resolved **before**
  the tool runs, against the agent's rules and then the session's, in OpenCode's own order: the last matching rule wins.
- Only an `allow` runs. An `ask` is refused, because no one can answer a prompt for a script, and a `deny` is refused.
  Neither makes a tool call or leaves a prompt waiting. The plugin's default rules allow every known tool, so a script
  can read and change what the agent can; restrict it with the `access` option, or with a later rule.
- A saved "Always allow" from an earlier prompt does **not** authorize an ad-hoc script: it is not part of the agent's
  and the session's rules. A script's grant must be reviewable in config or in a job's approval.
- OpenCode then checks the call itself, as it does for the model: the agent's rules, the session's rules, then saved
  approvals.

Session rules come after the agent's, so a session can narrow what its script may do, and it can grant one action for
one script without touching the agent's rules. This one may only read pull requests, call `api` for reads, and comment
on one issue:

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

An agent defined only in your config has no default rules (`/github-status` names it); its own rules decide.

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other
key is allowed:

```sh
opencode api post /api/rpc/github.platform.tools/list_pull_requests -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"owner":"OWNER","repo":"REPO","state":"open","perPage":20}}}'
```

The tool's input is GitHub's: `describe` shows each tool's schema as OpenCode lists it now. Check it rather than guess a
field name:

```sh
opencode api post /api/rpc/github.platform.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{}}'
opencode api post /api/rpc/github.platform.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

`describe` with a session gives each method's resolved `permission` (`allow`, `ask` or `deny`), which is how a script
self-checks before it writes a call.

## The location

Run the command in the project whose agent you mean, and send the call to that location explicitly:

```sh
opencode api post /api/rpc/github.platform.tools/<method> -H "x-opencode-directory:$PWD" -d '{…}'
```

Without it the call goes to the service's default location and fails `rpc.unavailable` if the plugin is not loaded
there. The HTTP equivalents are the `location[directory]` query parameter and the same header. `describe` reports the
`location` that answered and a `locationHint`.

A location unloads after OpenCode's idle timeout. If a scheduled script gets `rpc.unavailable` from a location that was
loaded before, send the call again once: the request loads the location. Jobs keeps its own location loaded.

`opencode api` ignores `--param location[directory]=…`; use the header.

## Results

A result comes back as `{ output?, text }`: the tool's structured content when it has any, and its text parts joined by
newlines. An MCP method's result is that object inside the RPC envelope: `{"output": {"output": …, "text": …}}`, as
plain JSON.

GitHub content in it is untrusted data: other people wrote it.

## `api`

`api` is `github_api` with the same sign-in, the same hosts and the same output. Its input is one of:

- REST: `{ method, path, query?, body?, accept?, paginate?, maxPages?, maxItems?, download?, upload? }`, where `path`
  is relative, such as `/repos/OWNER/REPO/branches/main/protection`. `GET` and `HEAD` read; every other method changes
  GitHub.
- GraphQL: `{ graphql: { query, variables? } }`. A single query reads; any other document is a change.

```sh
opencode api post /api/rpc/github.platform.tools/api -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"graphql":{"query":"query { viewer { login } }"}}}}'
```

The result is `github_api`'s output: `{ ok, status, data, contentType?, truncated, rateLimit?, pagination?, trust }`.
A REST error status, such as 404, is a result with `ok: false`, not an RPC error, as for the model. A redirect within
the API is followed, as for the model; one outside the API is `API_REDIRECT_OFF_HOST`. For job logs, call the
`get_job_logs` method.

**A non-GET/HEAD `api` call resolves the same write permission the direct path asserts** — action `github_api`, resource
`METHOD /path`, with the names GitHub reads without regard to case in lower case — **from a prior explicit `allow`
only.** An ask is refused with `PERMISSION_DENIED` before dispatch, and a saved "Always allow" does not count, so a
change, a `download` (a file write inside the project) and an `upload` each need that rule in the agent's or the
session's rules. **An allow scoped to GETs cannot POST:** a rule whose resource is `GET …` does not match
`POST /repos/…`, so the change is refused and nothing is sent. An allow on resource `*` covers every method and path.
`readOnly: true` still refuses every change, whoever calls it.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and
`data: { code, next }`. `opencode api` prints the error as JSON, then the HTTP status (`HTTP 400 Bad Request` for
`failed`), and exits with status 1 for any RPC error, so a shell script can test `$?`.

| Code | When |
| --- | --- |
| `PERMISSION_DENIED` | The rules ask or deny. An `ask` is refused before dispatch: the message says the action would ask, and the next step says to add an allow rule. A `deny` names the denied action, such as `github_issue_write`, and its next step says to remove or narrow that deny rule, add a later allow rule to the session, or use a session whose agent allows it. For `api`, the denied resource is the call's own `METHOD /path`, so a rule for another method does not cover it. |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `TOOL_UNAVAILABLE` | The server is connected, but GitHub does not list the tool, for example because its toolset is off. `describe`'s `detail` for the method names its toolset, and says whether the `toolsets` option turns it on. |
| `SERVER_CONFLICT` | Your config or another plugin defines its own MCP server named github, which this plugin does not manage (`conflict` in `/github-status`). |
| `AUTH_REQUIRED`, `CONNECTING`, `CONNECTION_FAILED`, `DISABLED`, `NOT_REGISTERED` | The github server needs a sign-in, is still connecting, could not connect, is disabled, or is not registered, as with the `host` option. `/github-status` gives the details. `api` gives `AUTH_REQUIRED` when there is no GitHub sign-in. |
| `UPSTREAM_ERROR` | GitHub's MCP server answered with an error, such as a missing permission or an invalid input. The message holds the first line of GitHub's text, at most 300 characters, with tokens and URL query strings removed. |
| `CANCELLED` | The request was cancelled. |

`api` also reports `github_api`'s own errors: `API_INPUT_INVALID`, `API_PATH_INVALID`, `API_GRAPHQL_PATH`,
`API_FILE_OUTSIDE_PROJECT`, `API_FILE_EXISTS`, `API_UPLOAD_TOO_LARGE`, `API_DOWNLOAD_TOO_LARGE`, `API_UNREACHABLE`,
`API_REDIRECT_LOOP`, `API_REDIRECT_INSECURE`, `API_REDIRECTED` and `API_REDIRECT_OFF_HOST`, each with its own next
step, all listed in [Errors](configuration.md#errors). A change refused because `readOnly` is set is `READ_ONLY`, and a
missing sign-in is `AUTH_REQUIRED`.

OpenCode itself answers `rpc.invalid_input` for a body that is not the envelope above, `rpc.method_not_found` for a
method that does not exist, such as `ui_get`, and `rpc.unavailable` when the plugin is not loaded or the call reached
another location.

## Status

The status RPC, `github.platform`, returns what `/github-status` shows:

```sh
opencode api post /api/rpc/github.platform/status -H "x-opencode-directory:$PWD" -d '{"input":{}}'
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

- Run a change without a prior explicit `allow` for it in the agent's or the session's rules. A saved "Always allow" is
  not enough.
- Reach `github_api` with a rule scoped to another method: a change resolves its own `METHOD /path`.
- Call a tool GitHub adds later, or the hidden `ui_get`.
- Answer an approval prompt: an `ask` is refused.
- Use a token: the plugin returns none.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from
any plugin, do not run for them. GitHub records API calls in its audit logs, as it does for the model's calls.
