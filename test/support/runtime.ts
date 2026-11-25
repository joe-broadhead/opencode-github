/** The handlers, driven through their real entry, with a fixed clock, no host and a fake GitHub. */
import { accountsOf } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { SourceError } from "@we-the-rebel-alliance/plugin-contract/events"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import type { AccountWiring } from "../../src/accounts.ts"
import { handlersFor, type HandlerRuntime } from "../../src/handlers/index.ts"
import { manifest, version } from "../../src/manifest.ts"
import { createProvider } from "../../src/provider/client.ts"
import { ownerOf } from "../../src/provider/events.ts"
import { ACCOUNTS, createFakeGitHub, NOW } from "./github-fake.ts"

/** The options the fixture and the tests use: two aliases. */
export const OPTIONS = { accounts: { work: {}, personal: {} } } as const

/** The events a call emitted, in order. */
export interface Sent {
  readonly event: string
  readonly data: unknown
}

/** The two aliases, with the fake sign-ins; `missing` names an alias that has no connection. */
export function fakeAccounts(options: Readonly<Record<string, unknown>> = OPTIONS, missing: readonly string[] = []): AccountWiring {
  const plan = accountsOf(manifest, options)
  if (!plan.ok) throw new Error(plan.problems.join("; "))
  const marked = new Set<string>()
  const credentials = (alias: string) => {
    if (missing.includes(alias)) throw new SourceError({ code: "NEEDS_SIGN_IN", what: `the ${alias} account is not signed in`, next: `Run /connect and choose GitHub to sign in as ${alias}.` })
    if (marked.has(alias)) throw new SourceError({ code: "NEEDS_SIGN_IN", what: "GitHub rejected the saved sign-in", next: `Run /connect and choose GitHub to sign in as ${alias}.` })
    const credential = ACCOUNTS[alias]
    if (credential === undefined) throw new SourceError({ code: "ACCOUNT_UNKNOWN", what: `${alias} is not an account of github`, next: "Use one of the aliases in the plugin's accounts option." })
    return credential
  }
  return {
    accounts: plan.value.accounts,
    problems: () => [],
    async mark(alias: string) {
      marked.add(alias)
    },
    async clear(alias: string) {
      marked.delete(alias)
    },
    async read(alias: string) {
      return credentials(alias)
    },
    async login(alias: string) {
      try {
        return credentials(alias).login
      } catch {
        return undefined
      }
    },
    async state(alias: string) {
      try {
        const credential = credentials(alias)
        return { state: "ready", owner: ownerOf(credential.login, credential.host) }
      } catch (error) {
        return error instanceof SourceError && error.code === "NEEDS_SIGN_IN" ? { state: "needs_sign_in", reason: error.what } : { state: "error", reason: String(error) }
      }
    },
    async dispose() {},
  }
}

/** A runtime with the real manifest, the fake provider and a fixed clock. */
export function runtimeFor(input: { options?: Readonly<Record<string, unknown>>; missing?: readonly string[]; overrides?: Partial<HandlerRuntime> } = {}): HandlerRuntime {
  const fake = createFakeGitHub()
  return {
    plugin: manifest.plugin.name,
    manifest,
    version,
    hostVersion: "2.4.1",
    accounts: fakeAccounts(input.options ?? OPTIONS, input.missing ?? []),
    provider: createProvider({ deviceSignIn: true, fetch: fake.fetch }),
    root: process.cwd(),
    clock: () => NOW,
    nextStep: () => null,
    statusState: { last: undefined, lastAccounts: new Map() },
    ...input.overrides,
  }
}

/** The call context a handler sees, as `register` builds it. */
export function callFor(account: string, sent: Sent[] = []): MethodCall {
  const bus = {
    async emit(event: string, data: unknown) {
      sent.push({ event, data })
      return { ok: true }
    },
  }
  return {
    sessionID: "ses_test",
    agent: "build",
    messageID: "msg_test",
    id: "call_test",
    signal: new AbortController().signal,
    progress: async () => undefined,
    account,
    door: "tool",
    bus: bus as unknown as MethodCall["bus"],
    access: {} as MethodCall["access"],
    unguardedAgents: async () => [],
  }
}

/** Run one handler with an account and the input `register` would pass. */
export async function run(runtime: HandlerRuntime, method: "status" | "probe" | "events_list" | "api", input: Readonly<Record<string, unknown>>, account = "work", sent: Sent[] = []): Promise<unknown> {
  const handler = handlersFor(runtime)[method]
  if (handler === undefined) throw new Error(`no handler for ${method}`)
  return handler.run(input, callFor(account, sent))
}
