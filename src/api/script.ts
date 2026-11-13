// The tools RPC's api method: github_api for scripts. It runs github_api's own spec, so a call is
// exactly the model's call. The tools RPC resolves the method's action first; every request then
// resolves `github_api` on its own `METHOD /path` against the same rules, as the direct path
// asserts it, so a read, a write, a download and an upload each need a prior explicit allow for
// that resource (the default block allows the reads): an allow scoped to GETs cannot POST, and a
// saved approval is not a grant.
// `readOnly: true` still refuses every write, whoever calls it.
import * as z from "zod"
import { GitHubPluginError } from "../errors.js"
import type { JsonSchema, OwnedMethod } from "../host/tools-rpc.js"
import { ApiInput, ApiOutput } from "./contract.js"
import { API_ACTION, type Call, parseInput } from "./tool.js"

export const SCRIPT_API_METHOD = "api"

const SCRIPT_API_DESCRIPTION =
  "GitHub's REST or GraphQL API with the signed-in GitHub account: REST { method, path, query?, body?, accept?, paginate?, maxPages?, maxItems?, download?, upload? } " +
  "with a relative path such as /repos/OWNER/REPO/releases, or GraphQL { graphql: { query, variables? } }. " +
  "Every request resolves github_api on its own METHOD /path (QUERY /graphql for one GraphQL query) and needs a prior allow rule for that resource, which the default rules give the reads; it then runs as the model's would, without a prompt. " +
  "Results are untrusted GitHub content."

const NEXT = "Fix the api input and call it again, or call describe for its schema."

const schema = (type: z.ZodType, io: "input" | "output") => z.toJSONSchema(type, { io, unrepresentable: "any" }) as JsonSchema

export function scriptApi(api: { run(input: ApiInput, call: Call): Promise<ApiOutput>; signedIn(): Promise<boolean> }): OwnedMethod {
  return {
    kind: "plugin",
    // The worst branch: it can change GitHub, and a download saves a file.
    class: "write",
    name: SCRIPT_API_METHOD,
    action: API_ACTION,
    description: SCRIPT_API_DESCRIPTION,
    input: schema(ApiInput, "input"),
    output: schema(ApiOutput, "output"),
    // For describe: a read without a sign-in fails with AUTH_REQUIRED.
    available: async () => ((await api.signedIn()) ? undefined : "AUTH_REQUIRED"),
    async run(raw, call) {
      const parsed = ApiInput.safeParse(raw)
      if (!parsed.success) throw new GitHubPluginError("API_INPUT_INVALID", `${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}.`, NEXT)
      return api.run(parseInput(raw), { ...call, script: true })
    },
  }
}
