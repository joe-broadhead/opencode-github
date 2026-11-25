# Security

## Reporting a vulnerability

Report a vulnerability through GitHub's private vulnerability reporting on this repository. Do not open a public issue
with a credential, a token or a person's data in it.

## What this plugin holds

Nothing. OpenCode holds each account's credential and owns sign-in; the plugin stores no token, writes none to disk and
logs none. It talks to GitHub's endpoints only, and sends a credential to GitHub's MCP server and its API host.

See [docs/security.md](docs/security.md) for the data flow, the scopes, redaction and the write path.
