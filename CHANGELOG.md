# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A `jelly` section in `package.json`: each tool with its permission, its default effect and whether it only reads, the skill ids. Jelly reads it without loading the plugin and applies the declared asks, because its agents have no base allow rule for this plugin's own default rules to follow. `docs/jelly.md` explains it.
- `title` and `signIns` in the `jelly` section: the name Jelly shows on the plugin's card, and what the plugin signs in to, so that one card can say whether each sign-in is connected and start, renew or end it. `docs/jelly.md` lists them.

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
