/** `probe`: whose an account is. It reads the account, never any content. */
import { parseProbeInput, SourceError, PROBE_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/events"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { credentialFor, refuseInput, refuseSource, serviceOf, type HandlerRuntime } from "./shared.ts"
import { SOURCE } from "../provider/events.ts"

/** `probe`: the owner and the provider sign-in's scopes for one account. */
export function probeHandler(runtime: HandlerRuntime): MethodHandler {
  return {
    description: "Read the signed-in GitHub owner for one account. Use it to tell accounts apart; it reads no content.",
    input: {
      type: "object",
      properties: { source: { type: "string", description: "The source to probe; only github." } },
      additionalProperties: false,
    },
    output: PROBE_SCHEMA,
    async run(input, call) {
      const parsed = parseProbeInput(input)
      if (!parsed.ok) refuseInput(parsed.problems)
      if (parsed.value.source !== undefined && parsed.value.source !== SOURCE) refuseSource(runtime.plugin, parsed.value.source)
      const credential = await credentialFor(runtime, call)
      try {
        const answer = await runtime.provider.probe({
          credential,
          request: { alias: call.account, login: credential.login, host: credential.host, service: serviceOf(credential) },
        })
        await runtime.accounts.clear(call.account)
        return answer
      } catch (error) {
        if (error instanceof SourceError && error.code === "NEEDS_SIGN_IN") await runtime.accounts.mark(call.account, error.what)
        throw error
      }
    },
  }
}
