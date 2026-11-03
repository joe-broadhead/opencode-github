# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-11-03

### Added

- The tools RPC, `github.platform.tools`: a script can call GitHub's known MCP reads, and `api` (`github_api` limited
  to REST GET and HEAD and single GraphQL queries), with no model, through `opencode api`, as a session and its agent.
  It gets exactly the access that agent's model has: a tool its rules hide is refused, OpenCode checks each MCP call
  against the agent's and the session's rules, and an ask is refused at once because no one is there to answer it.
  `describe` lists the methods with each tool's live input schema. GitHub's writes, `ui_get` and any tool GitHub adds
  later are never methods, and `api` refuses changes, downloads and uploads with `SCRIPT_READ_ONLY` before any
  request. With `host` (GitHub Enterprise Server) only `api` runs. `docs/scripting.md` explains it.

### Changed

- `check_dependency_vulnerabilities`, which GitHub's hosted server now lists in the `dependabot` toolset, is a known
  read: it looks up a list of packages in the GitHub Advisory Database and changes nothing, so it runs without a
  prompt, and `/github-status` no longer lists it as unknown.

## [0.0.0] - 2026-11-01

### Added

- GitHub's hosted MCP server, registered under the name `github`. GitHub's `X-MCP-Toolsets`, `X-MCP-Readonly` and
  `X-MCP-Lockdown` headers select the tools; read-only by default. The default toolsets are every read-only
  toolset that the default `repo read:org` scopes cover, including Actions logs and security alerts; `ui_get`, the
  MCP Apps data feed, is hidden.
- Sign-in on the `github` server's integration from `/connect`, `opencode auth login GitHub` and
  `opencode mcp auth github`: a fine-grained personal access token (`github-token`), with the token page prefilled
  for the default toolsets, and device sign-in (`github-device`) when `clientId` names an organisation's own OAuth
  App. A token that GitHub later rejects marks the account as needing sign-in.
- `github_api`, a tool for GitHub's REST and GraphQL API with the same sign-in, for what the MCP tools cannot do:
  auto-merge, releases and their assets, branch protection, rulesets, variables, artifacts and any GraphQL. Reads
  run; changes ask through `github_api` rules on `METHOD /path` and are refused while read-only. Requests stay on
  GitHub's API host, and redirects elsewhere are followed without the token.
- Option `host` for GitHub Enterprise Server: no MCP server there, `github_api` against the server's API, and sign-in
  on a **GitHub Enterprise** integration (token, or device flow with the server's own `clientId`).
- Default permission rules in every agent with a base allow rule: known GitHub reads run, and writes and unknown
  GitHub tools ask. User rules and saved approvals still win.
- Options `toolsets`, `readOnly`, `lockdown`, `unknownTools`, `clientId`, `scopes`, `allowUntestedHost` and `host`.
- One status, shown by `/github-status` and by the `/github` dialog in the TUI (palette **GitHub: Status**): state,
  account and access, tools and unknown tool names, agents without the default rules with the rules to add, the
  OpenCode check and the next step.
- A tested-host check: outside `>=2.2.3 <2.3.0` the plugin refuses to load with `HOST_UNTESTED`, unless
  `allowUntestedHost` is set.
- Error messages that start with their code (`OPTIONS_INVALID`, `HOST_UNTESTED`) and end with a next step.
- Skills `github-pr-review`, `github-issue-triage` and `github-code-research`.
