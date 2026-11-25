/**
 * `events_list`: the activity source's one read (contract §7). The input, its normalisation and the page come from the
 * contract's `events` module; this handler checks what only the plugin knows (the source) and asks the provider.
 */
import { parseEventsListInput, SourceError, PAGE_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/events"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { credentialFor, refuseInput, refuseSource, serviceOf, type HandlerRuntime } from "./shared.ts"
import { SOURCE } from "../provider/events.ts"

/** `events_list`: one account's page of GitHub activity, oldest first, with a cursor bound to the account and sign-in. */
export function eventsListHandler(runtime: HandlerRuntime): MethodHandler {
  return {
    description:
      "List what the signed-in GitHub user was involved in since a cursor, oldest first: issue and pull request changes, commits they authored, and readable notifications. Pass the previous cursor with the same account to read what follows it.",
    input: {
      type: "object",
      properties: {
        source: { type: "string", description: "The source to read; only github." },
        cursor: { type: "string", description: "The cursor a previous page returned." },
        since: { type: "string", description: "An ISO date or date-time; ignored when cursor is given." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "How many events to list, from 1 to 500." },
      },
      additionalProperties: false,
    },
    output: PAGE_SCHEMA,
    async run(input, call) {
      const parsed = parseEventsListInput(input)
      if (!parsed.ok) refuseInput(parsed.problems)
      if (parsed.value.source !== undefined && parsed.value.source !== SOURCE) refuseSource(runtime.plugin, parsed.value.source)
      const credential = await credentialFor(runtime, call)
      try {
        return await runtime.provider.page({
          credential,
          request: {
            alias: call.account,
            login: credential.login,
            host: credential.host,
            request: parsed.value,
            now: runtime.clock(),
            service: serviceOf(credential),
          },
          signal: call.signal,
        })
      } catch (error) {
        if (error instanceof SourceError && error.code === "NEEDS_SIGN_IN") await runtime.accounts.mark(call.account, error.what)
        throw error
      }
    },
  }
}
