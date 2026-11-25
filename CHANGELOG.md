# Changelog

## 0.0.0 (2026-11-25)

- GitHub's connector on plugin-contract v0: the hosted MCP tools passed through per account alias, plus `api`,
  `events_list`, `probe` and `status`, one `register` call, and the provider behind `src/provider/`.
- Accounts: one GitHub MCP server per github.com alias (`github`, `github-work`, …), each with GitHub device sign-in or
  a personal access token; a profile `host` selects a GitHub Enterprise Server, which has no hosted MCP server and uses
  an integration of its own.
- `api` reads and changes GitHub's REST and GraphQL API, with pagination, downloads and release-asset uploads; a
  successful change emits `changed`.
- `events_list` reads the merged issue, pull request, commit and notification feed with a cursor bound to the alias;
  `status` reports every alias and the agents whose rules miss the generated ones.
- The plugin emits `changed`, `status` and `account`, declares the `github.activity` events source, and ships four
  skills and generated documentation.
- Tests: unit, host, a two-account conformance fixture and a packed-tarball check; `npm run check` also runs biome,
  `plugin-kit check` and `plugin-kit docs --check`.

### Removed since v0.0.11

- `/github-status` command and its TUI status dialog: the contract's `status` method (agent tool, Code Mode and RPC)
  answers the same state; a TUI dialog is outside the 4b scope.
- `github.notifications` snapshot source: the notifications are part of the `github.activity` events feed, so a second
  snapshot of the same inbox is redundant.
- `describe`, the tools-RPC diagnostics method: contract v0 has no tools-RPC; `status` and the installed manifest are
  the diagnostics.
- `unknownTools` option: the contract's `methods` and `access` own tool classification; the plugin no longer filters the
  vendor's tool list. The `host` option moved to the account profile's `host`; it is not removed.
