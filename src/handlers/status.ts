/**
 * `status`: what a person and an app read before anything else. It carries no content and no credential.
 *
 * The host range, the version and the account list come from the manifest and the options; `unguardedAgents` names an
 * agent that no longer holds the rules `register` generated, and is never patched. A change of state is one `status`
 * nudge and one `account` nudge per alias whose sign-in state changed.
 */
import { accountStatuses, STATUS_SCHEMA, statusAnswer, type AccountSignal } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { EMPTY, unguardedOf, type HandlerRuntime } from "./shared.ts"

/** `status`: name, version, host, state, one entry per alias, unguarded agents and a next step. */
export function statusHandler(runtime: HandlerRuntime): MethodHandler {
  return {
    description: "Read the plugin's version, OpenCode host, account status and any next step.",
    input: EMPTY,
    output: STATUS_SCHEMA,
    async run(_input, call) {
      const signals: Record<string, AccountSignal> = {}
      const problems: string[] = [...runtime.accounts.problems()]
      for (const account of runtime.accounts.accounts) {
        const signal = await runtime.accounts.state(account.alias)
        signals[account.alias] = signal
        // The status builder's overall state counts a setup problem, not an alias in error: report the alias's reason
        // as a problem too, so the plugin never says ready while an account cannot be read.
        if (signal.state === "error" && signal.reason !== undefined) problems.push(signal.reason)
        const held = runtime.statusState.lastAccounts.get(account.alias)
        if (held !== signal.state) {
          runtime.statusState.lastAccounts.set(account.alias, signal.state)
          await call.bus.emit("account", { account: account.alias, state: signal.state })
        }
      }
      const next = runtime.nextStep()
      if (next !== null && problems.length === 0) problems.push(next)
      const unguarded = await unguardedOf(call)
      const answer = statusAnswer({
        manifest: runtime.manifest,
        version: runtime.version,
        hostVersion: runtime.hostVersion,
        accounts: accountStatuses(runtime.accounts.accounts, signals),
        problems,
        unguardedAgents: unguarded,
      })
      if (runtime.statusState.last !== answer.state) {
        runtime.statusState.last = answer.state
        await call.bus.emit("status", { state: answer.state })
      }
      return answer
    },
  }
}
