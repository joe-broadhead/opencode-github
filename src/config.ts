// Plugin options and the constants they default to.
import * as z from "zod"
import { GitHubPluginError } from "./errors.js"
import { ACCESS } from "./rpc.js"

export const MCP_URL = "https://api.githubcopilot.com/mcp/"

/** Where the plugin's own requests go: sign-in, the token check and github_api. */
export type Endpoints = {
  /** The web host, for sign-in pages and device flow. */
  readonly web: string
  /** The REST API base. */
  readonly api: string
  readonly graphql: string
  /** The base for release asset uploads. */
  readonly uploads: string
}

export const GITHUB_COM: Endpoints = {
  web: "https://github.com",
  api: "https://api.github.com",
  graphql: "https://api.github.com/graphql",
  uploads: "https://uploads.github.com",
}

/** github.com, or the GitHub Enterprise Server at `host`. */
export function endpoints(options: Pick<Options, "host">): Endpoints {
  if (!options.host) return GITHUB_COM
  const web = `https://${options.host}`
  return { web, api: `${web}/api/v3`, graphql: `${web}/api/graphql`, uploads: `${web}/api/uploads` }
}

/** GitHub's documented toolsets, including the ones only the remote server offers (v2.1.0). */
export const TOOLSETS = [
  "context",
  "actions",
  "code_quality",
  "code_security",
  "copilot",
  "copilot_issue_intents",
  "copilot_spaces",
  "dependabot",
  "discussions",
  "gists",
  "git",
  "github_support_docs_search",
  "governance",
  "issues",
  "labels",
  "notifications",
  "orgs",
  "projects",
  "pull_requests",
  "repos",
  "secret_protection",
  "security_advisories",
  "stargazers",
  "users",
] as const
export type Toolset = (typeof TOOLSETS)[number]

/**
 * Every read-only toolset the default scopes (`repo read:org`) cover. projects, gists and
 * notifications need more scopes, so they stay opt-in.
 */
export const DEFAULT_TOOLSETS: readonly Toolset[] = [
  "context",
  "repos",
  "issues",
  "pull_requests",
  "users",
  "actions",
  "git",
  "labels",
  "code_quality",
  "code_security",
  "secret_protection",
  "dependabot",
  "security_advisories",
  "discussions",
  "orgs",
]
const DEFAULT_SCOPES: readonly string[] = ["repo", "read:org"]

const unique = (values: readonly string[]) => new Set(values).size === values.length

/** What the generated default rules allow. `all` is the default; the other two are how a user restricts the plugin. */
export type Access = (typeof ACCESS)[number]

const OptionsSchema = z.strictObject({
  toolsets: z
    .array(z.enum(TOOLSETS))
    .min(1, "list at least one toolset")
    .refine(unique, "list each toolset once")
    .default([...DEFAULT_TOOLSETS]),
  /** What the generated default rules allow: everything, changes ask, or read-only. */
  access: z.enum(ACCESS).optional(),
  /**
   * Deprecated: `true` means `access: "read-only"` and `false` means `access: "all"`. Kept so an existing config keeps
   * working; status says so.
   */
  readOnly: z.boolean().optional(),
  lockdown: z.boolean().default(false),
  unknownTools: z.enum(["ask", "hide"]).default("ask"),
  /** An OAuth App for device sign-in, set by the user or an organisation; without it only token sign-in is offered. */
  clientId: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, "use the OAuth App's client ID (letters, digits, '.', '_' or '-')")
    .optional(),
  scopes: z
    .array(z.string().regex(/^[a-z][a-z0-9_:.-]{0,63}$/, "use a GitHub OAuth scope name such as repo or read:org"))
    .refine(unique, "list each scope once")
    .default([...DEFAULT_SCOPES]),
  allowUntestedHost: z.boolean().default(false),
  host: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/i, "use the server's host name, such as github.example.com")
    .refine((host) => !/^(.+\.)?github\.com(:[0-9]+)?$/i.test(host), "leave it out for github.com")
    .refine((host) => !/\.ghe\.com(:[0-9]+)?$/i.test(host), "GHE.com data residency is not supported yet")
    .optional(),
})

type ParsedOptions = z.output<typeof OptionsSchema>

export type Options = ParsedOptions & {
  /** The one switch the default rules follow: `access`, or the deprecated `readOnly` mapped onto it. */
  readonly access: Access
  /** Read-only means every change is refused and GitHub's own server lists no write tools: `access === "read-only"`. */
  readonly readOnly: boolean
  /** The note status shows when the deprecated `readOnly` option set the access. */
  readonly deprecation?: string
}



export function loadOptions(raw: unknown): Options {
  const result = OptionsSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path.join(".")
    const message = issue?.code === "unrecognized_keys" ? "this option does not exist" : (issue?.message ?? "invalid value")
    throw new GitHubPluginError(
      "OPTIONS_INVALID",
      path ? `Invalid plugin option "${path}": ${message}.` : `Invalid plugin options: ${message}.`,
      "Fix the options for @joe-broadhead/opencode-github in opencode.json.",
    )
  }
  const { readOnly, ...rest } = result.data
  // The old option is the same switch: `readOnly: true` is read-only and `readOnly: false` is everything allowed.
  const access: Access = rest.access ?? (readOnly === true ? "read-only" : "all")
  return {
    ...rest,
    access,
    readOnly: access === "read-only",
    ...(readOnly === undefined || rest.access !== undefined
      ? {}
      : { deprecation: `The readOnly option is deprecated: it maps to access "${access}". Set the access option instead, and remove readOnly.` }),
  }
}
