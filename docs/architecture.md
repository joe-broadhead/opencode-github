# Architecture

The plugin is one `Plugin.define` entry, one `register` call, and one provider directory that names GitHub.

## Layers

| Layer | File | Does |
|---|---|---|
| Entry | `src/index.ts` | `Plugin.define`, `assertHost`, the options, the account wiring, one `register` call, cleanup |
| Manifest | `src/manifest.ts` | reads `package.json` `capabilities`, checks it with the contract's manifest module |
| Accounts | `src/accounts.ts` | the `mcp` mechanism per alias, the Enterprise integration, the sign-in methods, credential resolution, status states |
| Handlers | `src/handlers/` | one file per method: `status`, `probe`, `events_list`, `api` |
| Provider | `src/provider/` | GitHub's REST and GraphQL client, the activity feed algorithm, device flow, endpoints |

`register` wires doors 1–3: one agent tool per method in the `github` namespace, the same tools in Code Mode, one RPC
id `github`, the bus events, and the access rules from `capabilities.methods` and `options.access`. No handler touches
`ctx.tool`, `ctx.rpc` or `ctx.permission` itself.

## Accounts

`registerAccounts` from the contract registers one GitHub MCP server per github.com alias. The plugin then attaches its
sign-in methods to each server integration: the host creates the integration after setup, so the plugin polls for it
and re-applies the methods whenever the host re-creates its generic OAuth method. An Enterprise alias has no server; its
integration is created directly under the same name.

The account record resolves the alias's credential from the integration's active connection. Status reads the same
record, so a call and status can never disagree about which alias is signed in. Nothing is cached: the credential is
resolved on each call and OpenCode renews it.

## The provider

`src/provider/api.ts` sends one REST or GraphQL call. It refuses a path it would not send as written, follows a read's
redirects only within the API, never follows a change's redirect, and follows a download's storage redirects without
the Authorization header. Results over 100,000 bytes are cut to whole items with `truncated: true`; a download streams
to a temporary file beside its target and publishes it atomically.

`src/provider/events.ts` merges GitHub's three searches (issues, pull requests, commits) and the notifications inbox.
Each stream has its own position in the cursor; a read pins a cut, lists the oldest item first, and answers a gap once
when GitHub's retention or a result over the read's byte limit loses history.

`src/provider/device-flow.ts` implements RFC 8628 device flow, the GitHub App token refresh, the token identity check
and the installation count. No client secret is used.

## What is stored

Nothing by the plugin. OpenCode holds the credentials, the cursors live with the consumer (an automation's state), and
the plugin keeps only the sign-in attach bookkeeping it needs during one process. A restart re-attaches the methods and
resolves the same credentials.

## OpenCode APIs used

`@opencode/plugin` 2.4.1 only: `ctx.app.version`, `ctx.options`, `ctx.location.directory`, `ctx.integration`
(`transform`, `get`, `connection.active`, `connection.resolve`), `ctx.mcp.list`, `ctx.event.subscribe`, and the
domains `register` uses for the doors and the access rules.
