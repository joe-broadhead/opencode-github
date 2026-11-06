# Architecture

The plugin is a thin layer over GitHub's hosted MCP server. OpenCode owns the MCP transport, credential storage,
permission prompts and the TUI. The plugin uses only public `@opencode/plugin` 2.2.3 APIs and stores nothing.

## Parts

| Part | Entry | Id |
| --- | --- | --- |
| Server | `dist/index.js` (`src/index.ts`) | `github.platform` |
| Status RPC contract (internal; bundled into both entries) | `src/rpc.ts` | `github.platform` |
| Tools RPC for scripts (bundled into `dist/index.js`) | `src/host/tools-rpc.ts`, `src/api/script.ts` | `github.platform.tools` |
| TUI | `dist/tui.js` (`src/tui/index.tsx`) | `github.platform.tui` |

Setup runs these steps in order and undoes them in reverse on cleanup, or when a later step fails:

1. `loadOptions` (`src/config.ts`) validates the options. Errors are `OPTIONS_INVALID`.
2. `checkHost` (`src/host-version.ts`) compares `ctx.app.version` with `>=2.2.3 <2.3.0`. Errors are
   `HOST_UNTESTED`, unless `allowUntestedHost` turns them into a status warning. `TESTED_HOSTS` in the same file is
   the one list of tested releases: the status's `host.tested`, and the host, pack and stock tests, use it.
3. `registerPermissionDefaults` (`src/permissions.ts`) inserts the default rules into each agent.
4. `registerToolFilter` (`src/tools.ts`) watches the `github` server's tools.
5. `registerMcp` (`src/mcp.ts`) registers the MCP server. With `host`, `observeMcp` only records whether another
   server named github exists, for the tools RPC.
6. `registerAuth` (`src/auth.ts`) attaches the sign-in methods.
7. `registerSignInStatus` (`src/sign-in-status.ts`) reports a rejected sign-in to `/connect`.
8. `registerStatus` (`src/status.ts`) adds the `/github-status` command and the RPC handler.
9. `registerToolsRpc` (`src/host/tools-rpc.ts`) adds the tools RPC for scripts and its `evaluate` hook.
10. `registerSkills` (`src/skills.ts`) adds the three skills from `skills/*/SKILL.md`.

## MCP registration

`ctx.mcp.transform` sets a remote server named `github` at `https://api.githubcopilot.com/mcp/`, with GitHub's
headers `X-MCP-Toolsets`, `X-MCP-Readonly` and, with `lockdown`, `X-MCP-Lockdown`. GitHub filters the tools on its
side. The plugin sets no `oauth: false` and no `protocol`, and never sends `X-MCP-Tools`, which stops GitHub's
server when it names an unknown tool.

The user's config is applied first. If a server named `github` already exists, the plugin leaves it unchanged, adds
no sign-in to it, and the status reports `conflict`.

## Sign-in

OpenCode registers every remote MCP server that keeps OAuth on as an integration, and `ctx.mcp.list()` returns its
`integrationID`. The MCP transport sends the integration's newest oauth-type credential as a Bearer token, whichever
method created it, and reconnects when it changes.

`registerAuth` replaces the host's generic MCP OAuth method on that integration (GitHub has no dynamic client
registration, so it cannot succeed) with two methods through `ctx.integration.transform`:

- `github-device`, "Sign in with GitHub": GitHub's device flow (`src/device-flow.ts`) with the OAuth App's public
  client ID and no secret. It is offered only when a client ID is set.
- `github-token`, "Use a fine-grained personal access token": the pasted token is checked with
  `GET https://api.github.com/user` and stored as an oauth-type credential.

Both label the credential with the GitHub login. No refresh hook is registered: OAuth App tokens do not expire, and
OpenCode would treat `expires: 0` as expiring if a refresh hook existed.

The host creates the integration after plugin setup, and creates it again when the server's config changes. So the
plugin registers its transform once the integration exists, and again whenever the host's own method reappears. It
checks on every `integration.updated` event, and polls every 250 ms for the first 10 s after setup.

When GitHub refuses the saved token, OpenCode keeps the credential and marks the server `needs_auth`.
`registerSignInStatus` (`src/sign-in-status.ts`) follows `mcp.status.changed` and then reports `needs_auth` on the
active account with `ctx.integration.connection.status`, so `/connect` shows that the account needs a new sign-in. It
clears the report once the server connects again. `connection.active` returns the credential alone, so the plugin reads
the status it set back from `integration.get`, which projects it as `connections[].status`; the same read clears the
`github_api` mark after a call that works (`src/api/tool.ts`).

## Tool catalog

`KNOWN_TOOLS` in `src/tools.ts` lists the known tools of each toolset, marked read or write, from
github-mcp-server v2.1.0 and each tool's `readOnlyHint`; tools that only GitHub's hosted server has are classified by
what they do. `ctx.tool.transform` records the `github` server's tools that are not in the catalog, removes them when
`unknownTools` is `"hide"`, and pins the core reads (`PINNED`): `get_file_contents`, `search_code`, `list_commits`, `get_commit`, `list_issues`, `search_issues`, `list_label`, `issue_read`, `list_pull_requests`, `pull_request_read` and `get_job_logs`. In Code Mode,
`pinned` only puts a tool's signature in the `github` catalog's shown listings; it never makes a direct tool. Without
the pins the catalog showed only `github_api`'s signature, and agents used it where a GitHub tool does the job.

There are no wrapper tools. GitHub's own tools already have maintained schemas and descriptions, and they cover the
workflows. A wrapper would add a second schema to keep in step with GitHub and would hide new upstream tools.

## GitHub Enterprise Server

With `host`, `endpoints()` in `src/config.ts` points sign-in and `github_api` at the server. `src/index.ts` then
skips the MCP server, the tool filter and the MCP sign-in reporter, and `registerEnterpriseAuth`
(`src/enterprise.ts`) creates the `github-enterprise` integration ("GitHub Enterprise") with the same two methods
from `src/sign-in.ts`. The status reads the sign-in from that integration and names the server.

## `github_api`

`registerApiTool` (`src/api/tool.ts`) adds `github_api` (namespace `github`, name `api`, permission action
`github_api`, pinned in Code Mode). It also describes the `github` namespace: the core reads are shown and `search`
finds the rest, the three skills, whether the plugin is read-only now, and the tools RPC for scripts.
`src/api/classify.ts` decides read or write: REST by method, GraphQL by scanning
the document's operations with a small tokenizer that skips strings, block strings and comments. Reads run; writes
call `ctx.permission.assert` with `METHOD /path` as the resource and save pattern, and are refused while read-only.
The resource writes the names GitHub reads without regard to case in lower case (`src/api/names.ts`).
`src/api/hints.ts` maps a few GET paths to the GitHub tool that covers them; `run` names it in a working result's
`nextStep` when its toolset is on (not with `host`), and never refuses the call.
`src/api/request.ts` builds the URL on the configured API base (uploads on the uploads base), refuses anything that
could leave it, sends the integration's active token, and handles redirects by hand with `redirect: "manual"`: never
for a change, within the API base for a read (reads never assert, so neither do their redirects), and to storage
hosts only for a download, without `Authorization`. It joins `Link` pages under the API base path, caps the inline result, and streams downloads into the
project with a SHA-256. The tool filter leaves `github_api` alone even though it shares the `github_` prefix.

## Permission defaults

One `ctx.agent.transform` inserts a block of rules right after each agent's base `{ "*", "*", "allow" }` rule:
`github_*` ask, then an allow rule for each catalogued read. Agents without a base allow rule are unchanged, and the
insertion is idempotent.

OpenCode applies the last matching rule, and saved approvals come after configured rules. So the agent's own later
rules, the user's top-level `permissions` and saved "Always allow" approvals all override the defaults, and a stricter
agent is never weakened.

No permission hook decides the defaults. A hook would decide outside OpenCode's rules, so user rules and saved
approvals could not override it, and the same call could be judged differently by the plugin and the host. Plain
rules keep one source of truth that the user can read and change. The plugin's one hook belongs to the tools RPC: it
only turns an ask on one of the RPC's own script calls into a deny (see [Tools RPC](#tools-rpc)).

`computeStatus` also compares the plugin's skills with `ctx.skill.list()`: a listed skill with the same id at another
path, such as a user's, is the one OpenCode loads, so the status names it in `shadowedSkills` and a Skills row.

Agents defined only in the user's config are created after plugins run and get no rules. `unguardedAgents` in
`src/permissions.ts` finds agents without the default block whose own rules would let an unknown `github_` tool run
without asking (the last matching rule wins), and the status names them with the block to copy.

## Status, RPC and the TUI view

`computeStatus` reads `ctx.mcp.list()`, the integration's active connection and `ctx.agent.list()` on every call. It
has no locks, caches or limits, so concurrent calls do not block each other. One `Status` shape (`src/rpc.ts`) backs:

- the `/github-status` command, which posts `formatStatus` text with `ctx.session.synthetic` and does not resume the
  model;
- the RPC method `status` of `GithubRpc`, registered with `ctx.rpc.register`.

`statusRows` in `src/rpc.ts` turns the status into the shared rows (Connection, Account, Access, Toolsets, Host,
Tools, Agents without default rules, OpenCode, Next step), which both `formatStatus` and the dialog render.
`src/rpc.ts` imports only `@opencode/plugin/rpc`: the contract is plain JSON Schema with a hand-written `Status`
type, and `isStatus` checks values against the same rules, so the TUI imports it without zod. `scripts/build.mjs` bundles each
entry into one self-contained file with esbuild (no splitting, no chunks): `dist/index.js` and `dist/tui.js`, each
with the RPC contract inlined (zod only in `dist/index.js`, for the options and `github_api`), so the package has no runtime dependencies and an in-place update can never
mix a new entry with a stale sibling module. Only `@opencode/plugin`, OpenTUI, Solid and `node:` built-ins stay
external. The skills are read from `../skills` relative to `dist/index.js`, the package root. The root
`NOTICE` carries the licence of every bundled package and nothing else; the build fails when it drifts from the bundle.

The TUI part registers the `github.status` command (slash `/github`, palette "GitHub: Status") from setup, with a
`global` keymap layer. Its dialog calls `client.rpc(GithubRpc).status({})`, refreshes on `r` and, while it is open
(it subscribes when it opens and stops when it closes), on the `mcp.status.changed`, `integration.updated`,
`credential.updated`, `credential.switched`, `agent.updated` and `server.connected` events, and shows a fixed message
instead of raw errors. `scripts/build.mjs` compiles its JSX with Babel and `babel-preset-solid` and bundles it into `dist/tui.js`,
so no `.tsx` runs from `node_modules`. OpenTUI and Solid come from the host.

## Tools RPC

`github.platform.tools` lets a script call GitHub's reads with no model; [Scripting](scripting.md) is the user's view.
Its methods are `describe`, one per known read in `allReadTools()` (`src/tools.ts`, every toolset, without `ui_get`),
named after the upstream tool, and `api`. The MCP list is an allowlist: a write or a tool that GitHub adds later is
never a method.

A call is `{ sessionID, input }`. The shared module (`src/host/tools-rpc.ts`):

1. looks up the session with `ctx.session.get`, and its agent's rules with `ctx.agent.get` in the session's location
   (`SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED`);
2. refuses the tool when the last rule that matches its permission action (`github_<tool>`, or `github_api`) on `*`, in
   the agent's rules followed by the session's, is a deny: OpenCode hides such a tool from the model
   (`PERMISSION_DENIED`);
3. for an MCP method: refuses with `SERVER_CONFLICT` while the plugin does not own the `github` server (another server
   of that name, also with `host`); finds the tool's executor in `ctx.tool.list()`, or names the server's state
   (`AUTH_REQUIRED` and so on, `NOT_REGISTERED` with `host`) or `TOOL_UNAVAILABLE` (a toolset that is off; `describe`
   adds `unavailableDetail`'s `detail`, naming the toolset and the `toolsets` option); calls
   `execute(input, { sessionID, agent, messageID, id, signal, progress })` with a new call id, so OpenCode checks
   `github_<tool>` on `*` itself and sends its own credential; and returns `{ output?, text }`;
4. for `api`: runs `scriptApi` (`src/api/script.ts`), which checks the input with `github_api`'s schema, refuses with
   `SCRIPT_READ_ONLY` anything `describeCall` classifies as a write, `download` and `upload`, then runs `github_api`'s
   own `run` with the call's context. A read asserts nothing, exactly as on the model path.

While a call runs, its id is live. A `permission.hook("evaluate")` turns an `ask` whose source id is live into a deny,
so the script gets `PERMISSION_DENIED` at once and no prompt waits. It changes nothing else; the forbidden-API scan
allows exactly this one.

A `Tool.Error` with a cause is a permission refusal; one without a cause is GitHub's own error (`isError`), which
becomes `UPSTREAM_ERROR` with its first line, at most 300 characters, with tokens and URL queries removed. A
`GitHubPluginError` from `api` keeps its code and next step. Any other failure is OpenCode's own and passes through.

OpenCode decodes a plain JSON Schema input with Effect, which drops unknown keys of an object that has properties
instead of refusing them. So the envelope's schema carries a strict Standard Schema validator as a non-enumerable
`~standard` property, which OpenCode prefers. The contract still serialises as plain JSON Schema, and OpenCode
answers a bad envelope with `rpc.invalid_input`.

The executor does not run `execute.before` and `execute.after` hooks; GitHub has none, so results are unchanged.
`ctx.tool.list()` returning callable executors is not documented as an entry point: the embedded host test and the
stock test (`test/stock`, stock `opencode serve` 2.2.3, 2.2.4 and 2.2.5) check the whole path against the loopback fake.

## Drift check

GitHub changes its tools over time. `npm run drift` (`scripts/drift.mjs`) is a maintainer check that lists the live
tools of each catalogued toolset and warns about new tools, missing tools and read or write mismatches. It changes
nothing at runtime: unknown tools ask by default, whatever it reports.
