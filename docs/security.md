# Security

## What leaves the machine

The plugin talks only to the host's GitHub endpoints: `github.com` (or the Enterprise host a profile names) for sign-in,
`api.github.com` for REST and GraphQL, `uploads.github.com` for release asset uploads, and
`api.githubcopilot.com/mcp/` for GitHub's hosted MCP tools. Nothing else is contacted, and no telemetry is sent.

## Credentials

OpenCode owns sign-in and stores the credential. The plugin stores no token, writes none to disk, and logs none. The
MCP transport sends the alias's credential to GitHub's MCP server; `api`, `events_list` and `probe` send it as a Bearer
token to the API host only. A redirect to a storage host (a release asset or an artifact) is followed without the
Authorization header.

A pasted token must look like a GitHub token (`github_pat_…` or `ghp_…`); the plugin never echoes it. Device flow uses
a client ID, never a client secret.

## Scopes

Device sign-in requests `repo` and `read:org` by default; `scopes` changes that. A pasted fine-grained token carries the
permissions it was created with; the token page the plugin links pre-fills read-only Metadata, Contents, Issues, Pull
requests, Commit statuses, Actions, Code quality, Code scanning, Dependabot, Secret scanning, Repository advisories and
Discussions. A GitHub App uses its own permissions and installations.

Least privilege is per alias: a fine-grained token for one repository reaches only that repository, and one alias's
credential never reaches another alias's MCP tools or cursor.

## Redaction

Status and next steps carry no credential, URL query string or token. A failure reason is cut to one line of 160
characters and redacted by the contract's `redactReason`: query values, `Bearer`/`Basic` credentials, JWTs and
token-shaped words are replaced.

## Untrusted content

Every page, probe and `api` answer carries `trust: "untrusted"`. GitHub's issue, pull request, commit and notification
text is data, never an instruction: the plugin never follows it, never puts it in status, and never uses it to choose a
tool or a recipient. An event that holds a credential is refused by the contract's screen and listed in `refused[]`.

## Writes

`api` is the plugin's one write path. It is class `admin`, so under `ask-changes` OpenCode asks before every call and
under `read-only` it is off. A person's rule for a narrower resource still applies. A write emits `changed` only after
GitHub accepted it.

The plugin declares no actions and no plan/commit pair: it has nothing to preview, and it wires no action-grant
verifier. A change through `api` is therefore an agent-session operation, where OpenCode can ask; an app with no
session has no confirmation path for a write.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting on this repository. Do not open a public issue with a token,
a credential or a person's data in it.
