// GitHub reads some path segments without regard to case: account, organisation and repository
// names, team slugs, environment, label, secret and variable names. github_api's permission
// resource writes those segments in lower case, so `/repos/Owner/Prod/…` and `/repos/owner/prod/…`
// meet the same rules. The request itself keeps the case it was given.

/** Segment patterns, matched from the start of the path: `@` is a name in lower case, `*` any segment, else a literal. */
const NAMES = [
  "repos/@/@",
  "orgs/@",
  "users/@",
  "enterprises/@",
  "orgs/*/teams/@",
  "orgs/*/teams/*/repos/@/@",
  "orgs/*/teams/*/memberships/@",
  "orgs/*/members/@",
  "orgs/*/public_members/@",
  "orgs/*/memberships/@",
  "orgs/*/outside_collaborators/@",
  "orgs/*/blocks/@",
  "teams/*/members/@",
  "teams/*/memberships/@",
  "teams/*/repos/@/@",
  "user/following/@",
  "user/blocks/@",
  "user/starred/@/@",
  "user/memberships/orgs/@",
  "users/*/following/@",
  "repos/*/*/collaborators/@",
  "repos/*/*/assignees/@",
  "repos/*/*/environments/@",
  "repos/*/*/labels/@",
  "repos/*/*/issues/*/labels/@",
].map((pattern) => pattern.split("/"))

/** Secret and variable names follow these segments wherever they appear (GitHub stores them in upper case). */
const BEFORE_NAME = new Set(["secrets", "variables"])

/** Letters to lower case, percent-encodings unchanged (they stay upper case). */
const lower = (segment: string) => segment.replace(/%[0-9A-F]{2}|[^%]+/g, (part) => (part.startsWith("%") ? part : part.toLowerCase()))

/** The path as github_api's rules see it: the case-insensitive name segments in lower case. */
export function permissionPath(path: string): string {
  const segments = path.split("/")
  const names = new Set<number>()
  for (const pattern of NAMES) {
    // A path shorter than the pattern matches as far as it goes, so `/repos/Owner` is covered too.
    const matched = pattern.every((part, index) => part === "@" || part === "*" || segments[index + 1] === undefined || part === segments[index + 1]!.toLowerCase())
    if (matched) pattern.forEach((part, index) => part === "@" && index + 1 < segments.length && names.add(index + 1))
  }
  segments.forEach((_segment, index) => {
    if (index > 1 && BEFORE_NAME.has(segments[index - 1]!.toLowerCase())) names.add(index)
  })
  return segments.map((segment, index) => (names.has(index) ? lower(segment) : segment)).join("/")
}

/**
 * A github_api rule resource (`METHOD /path`, with wildcards) whose name segments are not in lower case. It never
 * matches, because the resource it is checked against always has them in lower case.
 */
export function neverMatches(resource: string): boolean {
  return lowerResource(resource) !== resource
}

/** The rule resource with its name segments in lower case, as it should be written. */
export function lowerResource(resource: string): string {
  const space = resource.indexOf(" ")
  const path = space === -1 ? "" : resource.slice(space + 1)
  return path.startsWith("/") ? `${resource.slice(0, space)} ${permissionPath(path)}` : resource
}
