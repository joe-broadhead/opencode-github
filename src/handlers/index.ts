/**
 * The handler table: one entry per method the manifest declares, by the method's name.
 *
 * A handler says what one method looks like and does the work; `register` adds the account selector, the doors, the
 * permission assertions and the answer checks. The provider is the only layer that talks to GitHub.
 */
import type { HandlerTable } from "@we-the-rebel-alliance/plugin-contract/register"
import { apiHandler } from "./api.ts"
import { eventsListHandler } from "./events-list.ts"
import { probeHandler } from "./probe.ts"
import { statusHandler } from "./status.ts"
import type { HandlerRuntime } from "./shared.ts"

export type { HandlerRuntime } from "./shared.ts"

/** Every method's handler. The pass-through `mcp:<tool>` methods belong to the vendor's server and have none. */
export function handlersFor(runtime: HandlerRuntime): HandlerTable {
  return {
    status: statusHandler(runtime),
    probe: probeHandler(runtime),
    events_list: eventsListHandler(runtime),
    api: apiHandler(runtime),
  }
}
