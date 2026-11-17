# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **GitHub** (`jelly.title`), with the package name and version beneath. Under
that name it shows the one line in `jelly.summary`, and beside it the mark in `jelly.icon`
(`assets/icon.svg`, shipped in the package): Jelly reads that file once, when it records the
plugin, and keeps it only if it is a clean SVG of drawing elements, with no script, style, link
or outside reference. A Jelly whose declaration schema lacks `summary` or `icon` refuses this
declaration, because that schema accepts no unknown keys.

## Tools and permissions

100 tools are declared (62 read-only). Jelly's agents have no base "allow everything" rule, so the
plugin's own default rules, which it puts after that rule, never reach them. Every tool is declared
`allow`, which changes nothing in Jelly: each tool follows the access choice and its `readOnly`, by
Jelly's shared rules below, and a read-only helper is denied every tool not marked `readOnly`.

- Ask: none declared. At Ask before changes, every tool not marked `readOnly` asks first.
- Off: none declared. At Read only, every tool not marked `readOnly` is off. A choice the person makes for one tool wins
  over both.
- `github_events_list`, the plugin's own read for Memory's collector, which runs it unattended, is marked `readOnly`, so
  it runs at every access choice and never asks. Its inner GETs assert `github_events_list` itself on each `GET /path`,
  not `github_api`, so that one tool is all the collection needs. The source contract's `probe`, a tools RPC method with action `github_probe`,
  is allowed by the plugin's own rules at every `access` too.

A function that changes GitHub still needs a token that may: GitHub itself refuses a write the
token cannot make, and `github_api` asserts `github_api` on the call's own `METHOD /path` before
it sends anything.

Declared from `KNOWN_TOOLS` (writes too: they exist only with the default `access: "all"`), without
the hidden `ui_get`. That includes `issue_artifact_read` and `issue_artifact_write`, which GitHub
lists only behind a feature flag the plugin does not turn on.

A tool the upstream server adds later is not declared, so Jelly sees it only once the plugin
declares it. Keep `jelly.tools` in step with the known-tool list; `test/unit/jelly.test.ts` checks
each declared effect against the plugin's own default rules, and the list against `KNOWN_TOOLS`.

Jelly's shared rules for every plugin of the family, word for word:

<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->

## Skills

Declared: `github-pr-review`, `github-issue-triage`, `github-code-research`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views and scripts

None: `jelly.views` and `jelly.rpc` are empty.

## Signing in

`jelly.signIns` declares two sign-ins in one group, `github`, so either one connected is enough:

- `github`, for GitHub's remote MCP server `github`. Its integration carries this plugin's methods: the fine-grained
  token (checked with GitHub before it is saved) and, when the `clientId` option is set, the device flow.
- `github-enterprise`, the plugin's own integration for GitHub Enterprise Server. With the `host` option set, the
  plugin registers no MCP server, and this integration carries the same two methods against that server.

The `github` sign-in declares `"hostClient": { "id": "github", "option": "clientId" }`: a Jelly host that holds an
OAuth App by the name `github` (a deployment's own) writes its client ID into `clientId` in each agent's engine
document, never over one the agent's own options set. A Jelly before 0.3.2 refuses this declaration's new key.

`clientId` may name a GitHub App: its user tokens expire after 8 hours and the plugin renews them with their refresh
token, and the `appSlug` option gives the link that installs the App (see
[A GitHub App](configuration.md#a-github-app)).

An agent's copy of a GitHub App sign-in carries `refresh: "jelly-host-owns-refresh"`: the person's engine renews it
and Jelly puts the next copy in. The plugin never sends that value to GitHub. If OpenCode asks it to renew such a copy,
which happens only when the next copy did not arrive, it answers "Run /connect and choose GitHub to sign in again"
(GitHub Enterprise for the Enterprise sign-in) at once, with no request.

Token sign-in is always offered. Device sign-in appears only when you or your organisation set `clientId`; then
Jelly offers it first: it shows the code with Copy code and connects once the person approves, which works from a
web tab too, because nothing returns to a loopback port. With the token, Jelly opens the pre-filled token page, and
the person pastes the token.

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

## Settings

`jelly.contributes.settings` declares three of the plugin's options. Jelly draws each as a form field and writes the
value into the option of the same name:

- `access`, a choice of three: **Allowed** (`all`, the default), **Ask before changes** (`ask-changes`) and **Read
  only** (`read-only`), with Jelly's own line for each.
- `unknownTools`, a choice of two: **List them** (`ask`, the default) and **Hide them** (`hide`). The options parser
  also takes `list`, the same value as `ask`; the declaration keeps `ask`, so a value Jelly saved before still matches.
- `lockdown`, a switch, off by default.

Every value of the two declared closed sets is one the options parser takes (for `unknownTools` the parser also
takes `list`, which the declaration leaves out), so Jelly never saves a value the plugin refuses. A Jelly that does
not know declared choices (before app#1301) refuses the whole declaration. `clientId`, `appSlug` and `host` are free
text with a pattern, and `toolsets` and `scopes` are lists, so they are not declared. `test/unit/jelly.test.ts` checks
the settings against Jelly's setting rules, restated in `test/support/jelly-settings.ts`, and each declared value
against the options parser.

## Versions

Jelly's curated catalogue pins an exact version. Each release is published under a new version, so a review in
Jelly can tell the two apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`, which checks the declaration and this page against Jelly's plugin authors' standard. `scripts/check-copies.mjs` holds the kit, Jelly's setting rules (`test/support/jelly-settings.ts`), equal to the copies every plugin carries. The tools RPC and the events_list contract are not copies: they are the source contract's, pinned in `package-lock.json`.
