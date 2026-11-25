# Changelog

## 0.0.0 (unreleased)

- Rebuilt on plugin-contract v0: one `register` call, the `github` plugin id, namespace and RPC id, one handler per
  method, the provider in `src/provider/`, and generated docs.
- Accounts are held by the `mcp` mechanism: one GitHub MCP server per alias (`github`, `github-work`, …), each with its
  own sign-in; a profile's `host` selects a GitHub Enterprise Server, which has no hosted MCP server and uses an
  integration of its own.
- Every callable is declared in `capabilities.methods`: GitHub's 98 pass-through MCP tools with their classes, `api`
  (admin), `events_list`, `probe` and `status`.
- `api` keeps its REST and GraphQL reach, its download and upload, and its read/change distinction; it emits `changed`
  after a write.
- `events_list` reads the merged issue, pull request, commit and notification feed with a cursor bound to the alias.
- The plugin emits `changed`, `status` and `account`.
- The copied release and drift scripts are replaced by `plugin-kit`; the copied contract is replaced by the
  `@we-the-rebel-alliance/plugin-contract` devDependency; `docs/`, `AGENTS.md` and the skills are written fresh.
