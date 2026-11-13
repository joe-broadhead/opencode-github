// A GitHub App's user token, told apart from an OAuth App's, and the words for installing the App. A GitHub App's
// device flow uses the same endpoints as an OAuth App's, so the client ID alone does not say which it is: the token
// does. GitHub prefixes a GitHub App user token with `ghu_` and an OAuth App token with `gho_`, and a GitHub App's token
// response always carries an empty `scope`.
import type { Endpoints } from "./config.js"

/** Whether `token`, as GitHub returned it with `scope`, is a GitHub App user token. Reads only the prefix. */
export function isAppToken(token: string, scope?: string): boolean {
  if (token.startsWith("ghu_")) return true
  if (token.startsWith("gho_")) return false
  return scope === ""
}

/** The step that installs the GitHub App: its own page with `appSlug`, otherwise the words for it. */
export function installStep(endpoints: Endpoints, appSlug: string | undefined): string {
  return appSlug
    ? `Install it at ${endpoints.web}/apps/${appSlug}/installations/new`
    : "Install the GitHub App on that account or organization"
}

/** The account a REST path is about: the owner in /repos/{owner}/…, the org in /orgs/{org}/…, the user in /users/{user}/…. */
export function ownerOf(path: string | undefined): string | undefined {
  const match = path && /^\/(?:repos|orgs|users)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:[/?]|$)/.exec(path)
  return match ? match[1] : undefined
}
