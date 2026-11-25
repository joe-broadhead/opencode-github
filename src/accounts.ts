/**
 * The account wiring: several aliases through the contract's `accounts` module, one vendor MCP server per alias, and
 * the plugin's own sign-in methods on each alias's integration.
 *
 * GitHub's hosted MCP server serves github.com. One server per alias, named `github` for `default` and
 * `github-<alias>` otherwise, gives each alias its own OAuth credential and its own set of `github-<alias>_<tool>`
 * tools. The plugin replaces the server's generic OAuth method (GitHub has no dynamic client registration, so it cannot
 * succeed) with GitHub device flow and a fine-grained personal access token, and reads the alias's token from the same
 * integration for `api`, `events_list` and `probe`.
 *
 * A profile with a `host` names a GitHub Enterprise Server, which GitHub does not host an MCP server for. That alias
 * gets an integration of its own under the same name, with the same two sign-in methods; no MCP tools are registered
 * for it, and `api` is its tool. The contract's `accounts` mechanism is one per plugin, so this is the plugin's own
 * extension of the `mcp` mechanism for a provider whose server is not hosted for every host it serves.
 */
import type { Plugin } from "@opencode/plugin"
import { accountLabel, accountName, accountsOf, redactReason, registerAccounts, type AccountProfile, type AccountSignal, type AccountsRegistration } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { SourceError } from "@we-the-rebel-alliance/plugin-contract/events"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { endpointsFor, mcpServerUrl } from "./provider/client.ts"
import type { Credential } from "./provider/client.ts"
import { isOwnMethod, signIn, type IntegrationEditor } from "./provider/sign-in.ts"
import { ownerOf } from "./provider/events.ts"

/** The three access levels the contract defines. */
export const ACCESS = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS)[number]

/** GitHub's documented toolsets, including the ones only the remote server offers. */
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

/** Every read-only toolset the default scopes (`repo read:org`) cover. */
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

const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/
const APP_SLUG = /^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/
const SCOPE = /^[a-z][a-z0-9_:.-]{0,63}$/
const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?$/

/** The plugin's options, after the checks the manifest's JSON Schema also states. */
export interface Options {
  readonly access: Access
  readonly accounts: Readonly<Record<string, { readonly host?: string }>>
  readonly allowUntestedHost: boolean
  readonly toolsets: readonly Toolset[]
  readonly lockdown: boolean
  readonly clientId?: string
  readonly appSlug?: string
  readonly scopes: readonly string[]
}

const optionsError: (detail: string) => never = (detail) => {
  throw new Error(`OPTIONS_INVALID: ${detail}. Next step: fix the plugin's options in opencode.json.`)
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Read and check the plugin's options. Unknown keys and wrong types are OPTIONS_INVALID, never a silent default. */
export function loadOptions(raw: unknown): Options {
  if (raw === undefined || raw === null) raw = {}
  if (!plain(raw)) return optionsError("the plugin's options must be an object")
  const known = new Set(["access", "accounts", "allowUntestedHost", "toolsets", "lockdown", "clientId", "appSlug", "scopes"])
  for (const key of Object.keys(raw)) if (!known.has(key)) optionsError(`"${key}" is not an option of this plugin`)

  const access = raw["access"] ?? "all"
  if (typeof access !== "string" || !(ACCESS as readonly string[]).includes(access)) optionsError(`access must be one of ${ACCESS.join(", ")}`)

  const allowUntestedHost = raw["allowUntestedHost"] ?? false
  if (typeof allowUntestedHost !== "boolean") optionsError("allowUntestedHost must be true or false")

  const lockdown = raw["lockdown"] ?? false
  if (typeof lockdown !== "boolean") optionsError("lockdown must be true or false")

  let clientId: string | undefined
  const rawClientId = raw["clientId"]
  if (rawClientId !== undefined) {
    if (typeof rawClientId !== "string" || !CLIENT_ID.test(rawClientId)) optionsError("clientId must be an OAuth App or GitHub App client ID")
    clientId = rawClientId
  }
  let appSlug: string | undefined
  const rawAppSlug = raw["appSlug"]
  if (rawAppSlug !== undefined) {
    if (typeof rawAppSlug !== "string" || !APP_SLUG.test(rawAppSlug)) optionsError("appSlug must be a GitHub App's URL name")
    appSlug = rawAppSlug
  }

  const rawScopes = raw["scopes"] ?? DEFAULT_SCOPES
  if (!Array.isArray(rawScopes) || rawScopes.length === 0) optionsError("scopes must be a non-empty list of GitHub OAuth scopes")
  const scopes: string[] = []
  for (const scope of rawScopes) {
    if (typeof scope !== "string" || !SCOPE.test(scope)) optionsError("each scope must be a GitHub OAuth scope name such as repo or read:org")
    if (!scopes.includes(scope)) scopes.push(scope)
  }

  const rawToolsets = raw["toolsets"] ?? DEFAULT_TOOLSETS
  if (!Array.isArray(rawToolsets) || rawToolsets.length === 0) optionsError("toolsets must be a non-empty list")
  const toolsets: Toolset[] = []
  for (const toolset of rawToolsets) {
    if (typeof toolset !== "string" || !(TOOLSETS as readonly string[]).includes(toolset)) optionsError(`"${String(toolset)}" is not a GitHub toolset`)
    if (!toolsets.includes(toolset as Toolset)) toolsets.push(toolset as Toolset)
  }

  const rawAccounts = raw["accounts"] ?? {}
  if (!plain(rawAccounts)) optionsError("accounts must be a map of alias to profile")
  const accounts: Record<string, { host?: string }> = {}
  for (const [alias, profile] of Object.entries(rawAccounts)) {
    if (!plain(profile)) optionsError(`accounts.${alias} must be an object`)
    for (const key of Object.keys(profile)) if (key !== "host") optionsError(`accounts.${alias}.${key} is not a profile field`)
    const host = profile["host"]
    if (host !== undefined && (typeof host !== "string" || !HOST.test(host))) optionsError(`accounts.${alias}.host must be a host name such as github.example.com`)
    if (host !== undefined && /^(.*\.)?github\.com(:[0-9]+)?$/i.test(host)) optionsError(`accounts.${alias}.host is github.com by default; leave it out`)
    if (host !== undefined && /\.ghe\.com(:[0-9]+)?$/i.test(host)) optionsError(`accounts.${alias}.host: GHE.com data residency is not supported yet`)
    accounts[alias] = host === undefined ? {} : { host }
  }

  return { access: access as Access, accounts, allowUntestedHost, toolsets, lockdown, ...(clientId === undefined ? {} : { clientId }), ...(appSlug === undefined ? {} : { appSlug }), scopes }
}

/** The alias's integration or server name: `github` for `default`, `github-<alias>` otherwise. */
export function accountServerName(alias: string): string {
  return accountName("github", alias)
}

/** The alias's GitHub Enterprise host, or undefined on github.com. */
export function hostOf(options: Options, alias: string): string | undefined {
  return options.accounts[alias]?.host
}

/** The MCP server config for one github.com alias. */
function serverConfig(options: Options): Record<string, unknown> {
  return {
    type: "remote",
    url: mcpServerUrl(),
    oauth: {},
    headers: {
      "X-MCP-Toolsets": options.toolsets.join(","),
      "X-MCP-Readonly": String(options.access === "read-only"),
      ...(options.lockdown ? { "X-MCP-Lockdown": "true" } : {}),
    },
  }
}

/** One alias's sign-in, resolved when a handler runs; status reads `state` instead. */
export interface AccountCredentials {
  read(alias: string, signal?: AbortSignal | undefined): Promise<Credential>
  state(alias: string): Promise<AccountSignal>
  login(alias: string): Promise<string | undefined>
}

/** The account wiring a handler runtime holds. */
export interface AccountWiring extends AccountCredentials {
  readonly accounts: readonly AccountProfile[]
  /** What registering the servers and attaching the sign-in methods could not do, read by status. */
  problems(): readonly string[]
  /** Record that GitHub rejected an alias's credential, so /connect and status say so. */
  mark(alias: string, reason: string): Promise<void>
  /** Clear a recorded rejection after a call GitHub accepted. */
  clear(alias: string): Promise<void>
  dispose(): Promise<void>
}

const signInFailure = (what: string, next: string) => new SourceError({ code: "NEEDS_SIGN_IN", what, next })

/** Calls `handle` for each event of `types` until `signal` aborts or the stream ends. */
async function forEachEvent(
  subscribe: Plugin.Context["event"]["subscribe"],
  types: readonly "integration.updated"[],
  signal: AbortSignal,
  handle: () => void,
): Promise<void> {
  const iterator = subscribe({ types, signal })[Symbol.asyncIterator]()
  let stop = () => {}
  const aborted = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
  })
  signal.addEventListener("abort", stop, { once: true })
  try {
    while (!signal.aborted) {
      // Waiting on the abort too: a pending next() is not guaranteed to settle on return().
      const result = await Promise.race([iterator.next(), aborted])
      if (!result || result.done) return
      handle()
    }
  } finally {
    signal.removeEventListener("abort", stop)
    void iterator.return?.()?.catch(() => undefined)
  }
}

/** Waits `ms`, or less if `signal` aborts first. Never rejects. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

const STARTUP_POLL_MS = 250
const STARTUP_WINDOW_MS = 10_000
const RESUBSCRIBE_MS = 5_000

export interface RegisterRequest {
  readonly manifest: Manifest
  readonly options: Options
}

/**
 * Register every alias, then attach the sign-in methods to each alias's integration. Returns the wiring handlers use
 * and a disposer; a registration or attach failure is recorded in `problems` and never takes the plugin down.
 */
export async function registerGithubAccounts(ctx: Plugin.Context, request: RegisterRequest): Promise<AccountWiring> {
  const { manifest, options } = request
  const plan = accountsOf(manifest, options as unknown as Record<string, unknown>)
  if (!plan.ok) return optionsError(plan.problems.join("; "))
  const accounts = plan.value.accounts
  const problems: string[] = []
  const stopped = new AbortController()

  const onGithub = accounts.filter((account) => (account.profile ?? {}).host === undefined)
  const enterprise = accounts.filter((account) => (account.profile ?? {}).host !== undefined)

  // One hosted MCP server per github.com alias. `accountsOf` reads an explicit map, so the filtered options keep only
  // those aliases and never invent a default.
  let registered: AccountsRegistration = { mechanism: "mcp", accounts: [], problems: [] }
  if (onGithub.length > 0) {
    registered = await registerAccounts(ctx, {
      manifest,
      options: {
        ...options,
        accounts: Object.fromEntries(onGithub.map((account) => [account.alias, account.profile ?? {}])),
      },
      server: () => serverConfig(options),
    })
    problems.push(...registered.problems)
  }

  // Enterprise aliases: no hosted server, so the alias's own integration holds the same sign-in methods.
  const targets: { alias: string; name: string; create: boolean }[] = [
    ...onGithub.map((account) => ({ alias: account.alias, name: accountServerName(account.alias), create: false })),
    ...enterprise.map((account) => ({ alias: account.alias, name: accountServerName(account.alias), create: true })),
  ]

  const attached = new Map<string, { id: string; dispose: () => Promise<void> }>()

  const serviceOf = (alias: string): string => (hostOf(options, alias) === undefined ? "GitHub" : "GitHub Enterprise")

  const attach = async (target: { alias: string; name: string; create: boolean }, id: string): Promise<void> => {
    const methods = signIn(
      {
        ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
        scopes: options.scopes,
        endpoints: endpointsFor(hostOf(options, target.alias)),
        ...(options.appSlug === undefined ? {} : { appSlug: options.appSlug }),
        service: serviceOf(target.alias),
      },
      stopped.signal,
    )
    const next = await ctx.integration.transform((editor: IntegrationEditor) => {
      // A server's integration belongs to the server, and the host creates it after setup; an enterprise alias's own
      // integration is created here, on the first transform that names it.
      if (!target.create && editor.get(id) === undefined) return
      editor.update(id, (integration) => {
        integration.name = accountLabel(manifest.plugin.title, target.alias)
      })
      for (const method of editor.method.list(id)) {
        if (method.type === "oauth" && !isOwnMethod(method.id)) editor.method.remove(id, method)
      }
      methods.attach(editor, id)
    })
    const previous = attached.get(target.alias)
    attached.set(target.alias, { id, dispose: () => next.dispose() })
    await previous?.dispose()
  }

  const serverIntegration = async (name: string): Promise<string | undefined> => {
    try {
      return (await ctx.mcp.list()).data.find((server) => server.name === name)?.integrationID
    } catch {
      return undefined
    }
  }

  const genericReturned = async (id: string): Promise<boolean> => {
    try {
      const { data } = await ctx.integration.get({ integrationID: id })
      return data.methods.some((method) => method.type === "oauth" && !isOwnMethod(method.id))
    } catch {
      return false
    }
  }

  let checking: Promise<void> | undefined
  let again = false
  const check = async (): Promise<void> => {
    for (const target of targets) {
      if (stopped.signal.aborted) return
      const id = target.create ? target.name : await serverIntegration(target.name)
      if (id === undefined) continue
      const held = attached.get(target.alias)
      if (held !== undefined && held.id === id && !(await genericReturned(id))) continue
      try {
        await attach(target, id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (!problems.includes(reason)) problems.push(`accounts.${target.alias}: ${reason}`)
      }
    }
  }
  const schedule = (): Promise<void> => {
    if (checking) {
      again = true
      return checking
    }
    checking = (async () => {
      do {
        again = false
        if (!stopped.signal.aborted) await check().catch(() => undefined)
      } while (again)
    })().finally(() => {
      checking = undefined
    })
    return checking
  }

  const listen = (async () => {
    while (!stopped.signal.aborted) {
      await forEachEvent(ctx.event.subscribe, ["integration.updated"], stopped.signal, () => void schedule()).catch(() => undefined)
      if (!stopped.signal.aborted) void schedule()
      await delay(RESUBSCRIBE_MS, stopped.signal)
    }
  })()
  const startup = (async () => {
    const until = Date.now() + STARTUP_WINDOW_MS
    while (!stopped.signal.aborted && Date.now() < until) {
      await schedule()
      await delay(STARTUP_POLL_MS, stopped.signal)
    }
  })()

  const integrationFor = async (alias: string): Promise<string | undefined> => {
    if (hostOf(options, alias) !== undefined) return accountServerName(alias)
    return serverIntegration(accountServerName(alias))
  }

  type ConnectionInfo = Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>
  type CredentialValue = Awaited<ReturnType<Plugin.Context["integration"]["connection"]["resolve"]>>

  const read = async (alias: string, signal?: AbortSignal): Promise<Credential> => {
    signal?.throwIfAborted()
    const id = await integrationFor(alias)
    if (id === undefined) {
      throw signInFailure(`the ${alias} account's GitHub server is not registered yet`, "Wait a moment, then read status; sign the account in if it stays unregistered.")
    }
    let connection: ConnectionInfo
    try {
      connection = await ctx.integration.connection.active(id)
    } catch {
      throw signInFailure(`the ${alias} account's sign-in could not be read`, `Run /connect and choose ${serviceOf(alias)} to sign in again.`)
    }
    if (connection === undefined) throw signInFailure(`the ${alias} account is not signed in`, `Run /connect and choose ${serviceOf(alias)} to sign in as ${alias}.`)
    const reported = "status" in connection ? connection.status : undefined
    if (reported?.status === "needs_auth") throw signInFailure(reported.message || `the ${alias} account needs sign-in again`, `Run /connect and choose ${serviceOf(alias)} to sign in again.`)
    let credential: CredentialValue
    try {
      credential = await ctx.integration.connection.resolve(connection)
    } catch {
      throw signInFailure(`GitHub rejected the saved sign-in for ${alias}`, `Run /connect and choose ${serviceOf(alias)} to sign in again.`)
    }
    signal?.throwIfAborted()
    if (credential?.type !== "oauth") throw signInFailure(`the ${alias} account's connection holds no GitHub OAuth credential`, `Run /connect and choose ${serviceOf(alias)} to sign in again.`)
    const login = typeof credential.metadata?.["login"] === "string" ? credential.metadata["login"] : "label" in connection && typeof connection.label === "string" ? connection.label : undefined
    if (login === undefined || !/^[A-Za-z0-9-]{1,39}$/.test(login)) throw signInFailure(`the ${alias} account's sign-in names no GitHub login`, `Run /connect and choose ${serviceOf(alias)} to sign in again.`)
    const host = hostOf(options, alias)
    return { token: credential.access, login, ...(host === undefined ? {} : { host }) }
  }

  return {
    accounts,
    problems: () => [...problems],
    read,
    async login(alias) {
      try {
        return (await read(alias)).login
      } catch {
        return undefined
      }
    },
    async state(alias) {
      try {
        const credential = await read(alias)
        return { state: "ready", owner: ownerOf(credential.login, credential.host) }
      } catch (error) {
        if (error instanceof SourceError && error.code === "NEEDS_SIGN_IN") return { state: "needs_sign_in", reason: error.what }
        return { state: "error", reason: error instanceof Error ? error.message : String(error) }
      }
    },
    async mark(alias, reason) {
      const id = await integrationFor(alias)
      if (id === undefined) return
      try {
        const connection = await ctx.integration.connection.active(id)
        if (connection === undefined) return
        await ctx.integration.connection.status({ integrationID: id, connection, status: { status: "needs_auth", message: redactReason(reason) } })
      } catch {
        // A host that cannot record it still maps the failure; the next pull sees it.
      }
    },
    async clear(alias) {
      const id = await integrationFor(alias)
      if (id === undefined) return
      try {
        const connection = await ctx.integration.connection.active(id)
        if (connection === undefined || !("status" in connection) || connection.status === undefined) return
        await ctx.integration.connection.status({ integrationID: id, connection, status: undefined })
      } catch {
        // The status is a hint; a failure to clear it changes no call.
      }
    },
    async dispose() {
      stopped.abort()
      await Promise.all([listen, startup, checking])
      for (const held of attached.values()) await held.dispose().catch(() => undefined)
      attached.clear()
    },
  }
}
