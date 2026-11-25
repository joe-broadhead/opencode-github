# Configuration

The options and their defaults, generated from `capabilities.options`.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` | How much the plugin's methods may do: all, ask-changes or read-only. |
| `accounts` | object | — | One profile per account alias, keyed by alias. |
| `allowUntestedHost` | boolean | `false` | Start on an OpenCode release outside the tested range. |
| `toolsets` | array | `["context","repos","issues","pull_requests","users","actions","git","labels","code_quality","code_security","secret_protection","dependabot","security_advisories","discussions","orgs"]` | Which GitHub MCP toolsets every alias's server offers. |
| `lockdown` | boolean | `false` | Send GitHub's X-MCP-Lockdown header to restrict untrusted issue and pull request content. |
| `clientId` | string | — | An OAuth App or GitHub App client ID for device sign-in; without one only a fine-grained personal access token can be used. |
| `appSlug` | string | — | The GitHub App's URL name, for the install link when a sign-in reaches no installation. |
| `scopes` | array | `["repo","read:org"]` | OAuth scopes requested by device sign-in. |
<!-- /generated:configuration -->

## Examples

Two accounts, changes ask first:

```json
{ "access": "ask-changes", "accounts": { "work": {}, "personal": {} } }
```

A GitHub Enterprise alias beside github.com:

```json
{ "accounts": { "work": {}, "enterprise": { "host": "github.example.com" } } }
```

A device sign-in with fewer toolsets and untrusted-content lockdown:

```json
{ "clientId": "Iv1.0123456789abcdef", "scopes": ["repo", "read:org"], "toolsets": ["context", "repos", "issues", "pull_requests"], "lockdown": true }
```

## `access`

The plugin's ceiling. `all` runs every method; `ask-changes` asks before any method that is not a read; `read-only`
turns every non-read method off. It generates one rule per method, or one per alias for the pass-through MCP tools. A
person's own rule for one tool still wins, and an agent that lacks the generated rules is named in `status`, never
patched.

## `accounts`

A map of alias to profile. An alias is a lowercase word; `default` is the alias with no name. Each alias gets its own
MCP server (or, with a `host`, its own Enterprise integration) and its own sign-in. The profile's `host` is the only
field.

## `toolsets`

The GitHub MCP toolsets every alias's server offers, sent as the `X-MCP-Toolsets` header. `context` and `repos` are the
ones most work needs. The plugin's own `api` method needs no toolset.

## `lockdown`

Sends `X-MCP-Lockdown: true`. In public repositories GitHub then limits issue and pull request content to items from
people with push access. It is a content filter, not a security boundary, and it does not change any rule.

## `clientId`, `appSlug`, `scopes`

`clientId` enables GitHub device flow on an OAuth App or GitHub App; without it only a fine-grained personal access
token is offered. `appSlug` names the GitHub App's install page in a next step. `scopes` are the OAuth scopes device
sign-in requests; a pasted token carries the scopes it was created with. No client secret is used or stored.

## `allowUntestedHost`

The plugin refuses a host outside `>=2.4.1 <2.5.0` with `HOST_UNTESTED` and does not load. `allowUntestedHost: true`
starts it anyway. **Leave it false**: it exists only for a person who accepts the risk of an untested host, and the
plugin's tested range is what CI proves.
