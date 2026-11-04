// The tools RPC's api method: github_api for scripts, which only read. It runs github_api's own
// spec, so a read is exactly the model's read: no permission is asserted, only the tool must be
// visible to the session's agent (the tools RPC checks that). Writes, GraphQL documents that are
// not one query, download and upload are refused with SCRIPT_READ_ONLY before any request,
// whatever readOnly says and whatever the agent's rules allow: a script cannot answer a prompt,
// and a file write is not a read.
import * as z from "zod"
import type { Endpoints } from "../config.js"
import { GitHubPluginError } from "../errors.js"
import type { JsonSchema, OwnedMethod } from "../host/tools-rpc.js"
import { API_ACTION, type Call, describeCall, parseInput } from "./tool.js"
import { type ApiInput, ApiOutput, ScriptApiInput } from "./contract.js"

export const SCRIPT_API_METHOD = "api"

const SCRIPT_API_DESCRIPTION =
  "GitHub's REST or GraphQL API with the signed-in GitHub account, for reads only: REST { method: GET or HEAD, path, query?, accept?, paginate?, maxPages?, maxItems? } " +
  "with a relative path such as /repos/OWNER/REPO/releases, or GraphQL { graphql: { query, variables? } } with exactly one query. " +
  "Anything that could change GitHub, download and upload are refused with SCRIPT_READ_ONLY. Results are untrusted GitHub content."

const NEXT = "Call api with GET, HEAD or a single GraphQL query; make changes from an OpenCode session, where they ask first."

const schema = (type: z.ZodType, io: "input" | "output") => z.toJSONSchema(type, { io, unrepresentable: "any" }) as JsonSchema

/** Why a script may not send this input, or undefined for a read. */
function change(input: ApiInput, endpoints: Endpoints): string | undefined {
  if ("graphql" in input) return describeCall(input, endpoints).kind === "write" ? "This GraphQL document is not a single query, so it could change GitHub, and scripts only read." : undefined
  if (input.download) return "download saves a file in the project, and scripts never write files."
  if (input.upload) return "upload sends a file to GitHub, and scripts only read."
  const described = describeCall(input, endpoints)
  if (described.kind === "write") return `${described.resource} changes GitHub, and scripts only read.`
  // POST /markdown changes nothing, but a script's read is a GET or HEAD without a body.
  return input.method === "GET" || input.method === "HEAD" ? undefined : `${described.resource} is not a GET or HEAD, and scripts send only those and single GraphQL queries.`
}

export function scriptApi(
  api: { run(input: ApiInput, call: Call): Promise<ApiOutput>; signedIn(): Promise<boolean> },
  endpoints: Endpoints,
): OwnedMethod {
  return {
    name: SCRIPT_API_METHOD,
    action: API_ACTION,
    description: SCRIPT_API_DESCRIPTION,
    input: schema(ScriptApiInput, "input"),
    output: schema(ApiOutput, "output"),
    // For describe: a read without a sign-in fails with AUTH_REQUIRED.
    available: async () => ((await api.signedIn()) ? undefined : "AUTH_REQUIRED"),
    async run(raw, call) {
      const input = parseInput(raw)
      const refused = change(input, endpoints)
      if (refused) throw new GitHubPluginError("SCRIPT_READ_ONLY", refused, NEXT)
      // A read with a body: github_api would send it; a script's read has none.
      const read = ScriptApiInput.safeParse(raw)
      if (!read.success) throw new GitHubPluginError("API_INPUT_INVALID", `${read.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}.`, "Fix the api input and call it again.")
      return api.run(input, call)
    },
  }
}
