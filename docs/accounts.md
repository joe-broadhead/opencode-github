# Accounts

Several GitHub aliases at once, held by the MCP mechanism: GitHub's hosted MCP server keeps each github.com alias's
OAuth credential, and OpenCode keys it per server. A GitHub Enterprise alias has no hosted server and keeps the same
credential on an integration of its own.

<!-- generated:accounts -->
Accounts are held by the **mcp** mechanism: the vendor's MCP server holds them.

| Field | Type | Required |
|---|---|---|
| `host` | string | no |
<!-- /generated:accounts -->

## Sign in per alias

| Alias | MCP server | Sign-in |
|---|---|---|
| `default` | `github` | `/connect`, choose GitHub |
| `work` | `github-work` | `/connect`, choose GitHub (work) |
| `personal` | `github-personal` | `/connect`, choose GitHub (personal) |

GitHub's hosted MCP server has no dynamic client registration. The plugin replaces its generic OAuth method with
GitHub device flow (when `clientId` is set) and a fine-grained personal access token, on the server's own integration.
The MCP transport sends that credential as the Bearer token, and the plugin reads the same credential for `api`,
`events_list` and `probe`.

A GitHub App with expiring user tokens is renewed by the sign-in method's refresh hook. A rejected renewal, and a
`probe` or `api` call GitHub answers 401, marks the connection as needing sign-in: the next call is `NEEDS_SIGN_IN` and
`status` says which alias. A working `probe` or `api` call clears the mark.

## GitHub Enterprise Server

A profile with `host` names an Enterprise Server. GitHub does not host an MCP server for it, so the alias gets an
integration of its own, named the same way (`github` or `github-<alias>`), with the same two sign-in methods. No
pass-through MCP tools exist for that alias; `api` is its tool.

## Picking an account

Pass `account: "<alias>"` on a method that takes one. With two aliases and none named, the call is refused with
`ACCOUNT_REQUIRED`; an alias the plugin does not serve is `ACCOUNT_UNKNOWN`. A cursor issued for one alias is refused
for another with `CURSOR_INVALID`, and a cursor is also refused when the alias was signed in to a different GitHub login
since it was issued.

`probe` reports the alias's owner as `github:<login>` on github.com, or `github:<login>@<host>` on an Enterprise host.
`status` lists every alias with its state and, once probed, its owner.

## Per-alias tools

The pass-through MCP tools are permitted per alias: `github-work_*` for `work`, `github-personal_*` for `personal` and
`github_*` for `default`. The derivation is the contract's `serverOf` and `toolAction`, so a rule or grant for one alias
cannot reach another alias's tool.
