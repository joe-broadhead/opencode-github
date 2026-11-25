/** The shapes, refusals and bus nudges the handlers share. */
import { SourceError } from "@we-the-rebel-alliance/plugin-contract/events"
import type { JsonSchema, Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import type { UnguardedAgentsResult } from "@we-the-rebel-alliance/plugin-contract/access"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import type { AccountWiring } from "../accounts.ts"
import type { Provider, Credential } from "../provider/client.ts"

/** A method that takes no input. */
export const EMPTY: JsonSchema = { type: "object", properties: {}, additionalProperties: false }

/** Refuse an input the contract's parser rejected, in the contract's one form. */
export function refuseInput(problems: readonly string[]): never {
  throw new SourceError({ code: "INPUT_INVALID", what: problems.join("; "), next: "Pass only the input the method's schema describes." })
}

/** Refuse a source this plugin does not have. */
export function refuseSource(plugin: string, source: string): never {
  throw new SourceError({ code: "SOURCE_UNKNOWN", what: `${source} is not a source of ${plugin}`, next: "Read the github source, or omit source." })
}

/** The plugin state the handlers may read, built once in `setup`. */
export interface HandlerRuntime {
  /** The plugin's id, as the manifest names it. */
  readonly plugin: string
  /** The installed manifest, for the status answer. */
  readonly manifest: Manifest
  /** The package version, which `status` reports. */
  readonly version: string
  /** The OpenCode release the plugin runs on. */
  readonly hostVersion: string
  /** The accounts and their sign-ins. */
  readonly accounts: AccountWiring
  readonly provider: Provider
  /** The project folder a download writes inside. */
  readonly root: string
  /** The clock a page's `asOf` is stamped with; tests pass a fixed one. */
  readonly clock: () => number
  /** The first account or setup problem, for `status.nextStep`, or null. */
  nextStep(): string | null
  /** The last state status answered, so a change is one `status` nudge. */
  statusState: { last: string | undefined; lastAccounts: Map<string, string> }
}

/**
 * The agents whose rules no longer hold the generated ones, as `status` reports them. The call answers
 * `{ ok: true, agents } | { ok: false, error }` and never throws; `statusAnswer` turns the failure into a problem and
 * the empty list into unknown, never zero.
 */
export function unguardedOf(call: MethodCall): Promise<UnguardedAgentsResult> {
  return call.unguardedAgents()
}

/** The service name a next step shows: GitHub, or GitHub Enterprise. */
export function serviceOf(credential: Credential): string {
  return credential.host === undefined ? "GitHub" : "GitHub Enterprise"
}

/**
 * The alias's sign-in, with the contract's `account` nudge on a change: a call that finds an alias needing sign-in says
 * so once, and a call that finds it ready after that says so too.
 */
export async function credentialFor(runtime: HandlerRuntime, call: MethodCall): Promise<Credential> {
  try {
    const credential = await runtime.accounts.read(call.account, call.signal)
    if (runtime.statusState.lastAccounts.get(call.account) === "needs_sign_in") {
      runtime.statusState.lastAccounts.set(call.account, "ready")
      await call.bus.emit("account", { account: call.account, state: "ready" })
    }
    return credential
  } catch (error) {
    if (error instanceof SourceError && error.code === "NEEDS_SIGN_IN") {
      if (runtime.statusState.lastAccounts.get(call.account) !== "needs_sign_in") {
        runtime.statusState.lastAccounts.set(call.account, "needs_sign_in")
        await call.bus.emit("account", { account: call.account, state: "needs_sign_in" })
      }
    }
    throw error
  }
}
