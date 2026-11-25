/**
 * The provider's one endpoint table: github.com, or a GitHub Enterprise host, and the hosted MCP server's URL.
 *
 * Nothing outside this directory names a GitHub address. An alias's profile selects the host; every request the plugin
 * makes is built from the set below.
 */

/** Where the plugin's own requests go: sign-in, the token check, the api method and the events source. */
export interface Endpoints {
  /** The web host, for sign-in pages and device flow. */
  readonly web: string
  /** The REST API base. */
  readonly api: string
  readonly graphql: string
  /** The base for release asset uploads. */
  readonly uploads: string
}

/** github.com. */
export const GITHUB_COM: Endpoints = {
  web: "https://github.com",
  api: "https://api.github.com",
  graphql: "https://api.github.com/graphql",
  uploads: "https://uploads.github.com",
}

/** github.com, or the GitHub Enterprise Server at `host`. */
export function endpointsFor(host: string | undefined): Endpoints {
  if (host === undefined) return GITHUB_COM
  const web = `https://${host}`
  return { web, api: `${web}/api/v3`, graphql: `${web}/api/graphql`, uploads: `${web}/api/uploads` }
}

/** GitHub's hosted MCP server. It serves github.com only; an Enterprise alias uses an integration of its own. */
export const MCP_URL = "https://api.githubcopilot.com/mcp/"

/**
 * The URL of one alias's MCP server. GitHub hosts one server for every account, and the OAuth credential selects the
 * account, so every alias uses the same URL under its own server name.
 */
export function mcpServerUrl(): string {
  return MCP_URL
}
