// The fine-grained personal access token permissions that the default toolsets read with,
// keyed by the parameter names GitHub's new-token page accepts, with the names it shows.
// Device sign-in needs none of them: its `repo read:org` scopes cover the same reads.

/** Repository permissions, all read-only, prefilled on the token page. */
export const TOKEN_PERMISSIONS = {
  metadata: "Metadata",
  contents: "Contents",
  issues: "Issues",
  pull_requests: "Pull requests",
  statuses: "Commit statuses",
  actions: "Actions",
  code_quality: "Code quality",
  security_events: "Code scanning alerts",
  vulnerability_alerts: "Dependabot alerts",
  secret_scanning_alerts: "Secret scanning alerts",
  repository_advisories: "Repository security advisories",
  discussions: "Discussions",
} as const

/** Organisation permissions for the team, issue type and member tools; not prefilled. */
const ORGANIZATION_PERMISSIONS = { members: "Members", issue_types: "Issue Types" } as const

/** The name GitHub's token page shows for a permission parameter, or the parameter itself. */
export function permissionName(key: string): string {
  return (TOKEN_PERMISSIONS as Record<string, string>)[key] ?? (ORGANIZATION_PERMISSIONS as Record<string, string>)[key] ?? key
}
