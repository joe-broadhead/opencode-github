// The github_api tool's input and output.
import * as z from "zod"

export const ACCEPT = {
  json: "application/vnd.github+json",
  diff: "application/vnd.github.diff",
  patch: "application/vnd.github.patch",
  raw: "application/vnd.github.raw+json",
  "octet-stream": "application/octet-stream",
} as const

const Scalar = z.union([z.string(), z.number(), z.boolean()])

export const RestInput = z.strictObject({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .min(2)
    .max(2048)
    .describe("Relative API path such as /repos/OWNER/REPO/releases. Never a full URL. GraphQL goes in graphql, not here."),
  query: z.record(z.string(), z.union([Scalar, z.array(Scalar)])).optional().describe("Query parameters, such as per_page."),
  body: z.unknown().optional().describe("JSON request body."),
  accept: z.enum(["json", "diff", "patch", "raw", "octet-stream"]).optional().describe("Response format; default json."),
  paginate: z.boolean().optional().describe("GET only: follow the Link header and join the pages."),
  maxPages: z.number().int().min(1).max(100).optional().describe("With paginate: most pages to fetch; default 10."),
  maxItems: z.number().int().min(1).max(10_000).optional().describe("With paginate: most items to keep; default 1000."),
  download: z
    .strictObject({ path: z.string().min(1), overwrite: z.boolean().optional() })
    .optional()
    .describe("GET only: save the response to this file inside the project, for artifacts, logs and release assets."),
  upload: z
    .strictObject({ path: z.string().min(1), contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/) })
    .optional()
    .describe("POST only: send this file inside the project as the body, to the uploads host, for release assets."),
})

export const GraphqlInput = z.strictObject({
  graphql: z.strictObject({
    query: z.string().min(1).max(100_000).describe("One GraphQL document. A single query reads; anything else writes."),
    variables: z.record(z.string(), z.unknown()).optional(),
  }),
})

export const ApiInput = z.union([RestInput, GraphqlInput])
export type ApiInput = z.output<typeof ApiInput>
export type RestInput = z.output<typeof RestInput>
export type GraphqlInput = z.output<typeof GraphqlInput>

export const ApiOutput = z.strictObject({
  /** A 2xx status, and for GraphQL no errors. */
  ok: z.boolean(),
  status: z.number().int(),
  /** Parsed JSON, or text for diff, patch and raw. Untrusted GitHub content. */
  data: z.unknown().optional(),
  contentType: z.string().optional(),
  truncated: z.boolean(),
  nextStep: z.string().optional(),
  rateLimit: z.strictObject({ limit: z.number(), remaining: z.number(), resetAt: z.string() }).optional(),
  pagination: z.strictObject({ pages: z.number().int(), items: z.number().int(), more: z.boolean() }).optional(),
  download: z.strictObject({ path: z.string(), bytes: z.number().int(), sha256: z.string() }).optional(),
  trust: z.strictObject({ githubContent: z.literal("untrusted") }),
})
export type ApiOutput = z.output<typeof ApiOutput>
