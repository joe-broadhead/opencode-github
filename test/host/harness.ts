// An embedded OpenCode host from the public @opencode/sdk, with no listener and no private
// host source. The plugin is loaded the way a user loads it: a config `plugins` entry that
// points at this package (its built dist/) with options. A probe plugin lends its context
// to the tests. GitHub is the loopback fake behind the fetch router, and any other request
// fails the host's close().
//
// Host version: the SDK in devDependencies (2.2.3). HOST_SDK_DIR names a directory whose
// node_modules holds another @opencode/sdk (for example 2.2.4, installed outside the
// lockfile); the host then runs that SDK and reports its version.
import { ROOT, SDK_OVERRIDE } from "./isolate.js"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin"
import { FIXTURE_PAT, startFakeGitHub } from "./fake-github.js"
import { routeFetch } from "./route-fetch.js"

const PLUGIN_ID = "github.platform"
const REPO = realpathSync(fileURLToPath(new URL("../../", import.meta.url)))

const SDK = join(SDK_OVERRIDE ? realpathSync(SDK_OVERRIDE) : REPO, "node_modules", "@opencode", "sdk")
const manifest = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string; exports: { ".": { import: string } } }
/** The OpenCode release under test: the version of the SDK that runs the host. */
export const SDK_VERSION = manifest.version

if (!existsSync(join(REPO, "dist", "index.js"))) throw new Error("dist/ is missing. Run npm run build first.")
export { GithubRpc } from "../../src/rpc.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"

export type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

/** The SDK's client surface; its own declarations import packages that ship no types. */
export type Client = Omit<OpenCodeClient, "plugin"> & {
  readonly sessions: OpenCodeClient["session"]
  readonly plugin: ((plugin: Plugin.Plugin) => Promise<void>) & OpenCodeClient["plugin"]
  readonly close: () => Promise<void>
}

const router = routeFetch()

/** Removes the temp root and restores fetch; call once after every host in the file has closed. */
export function cleanup() {
  // A closed host can still run a retry it had scheduled. It only ever reaches its own
  // closed fake, which is blocked; report it rather than fail.
  if (router.stale.length > 0) console.warn(`requests from closed hosts, blocked: ${[...new Set(router.stale)].join(", ")}`)
  router.restore()
  rmSync(ROOT, { recursive: true, force: true })
}

const probes = new Map<string, Plugin.Context>()
const probe = Plugin.define({
  id: "github.host-test.probe",
  setup: (ctx) => void probes.set(ctx.location.directory, ctx),
})

export interface HostInput {
  /** Plugin options, as a user writes them in opencode.json. */
  readonly options?: Record<string, unknown>
  /** Extra user config, such as permissions, agents or mcp. Receives the fake's origin. */
  readonly config?: (origin: string) => Record<string, unknown>
  /** The version the host reports to plugins; defaults to the SDK's. */
  readonly version?: string
  /**
   * "sdk" registers the built plugin with the SDK instead (default options), so a test can
   * unload it by registering another plugin with its ID.
   */
  readonly load?: "config" | "sdk"
}

let hosts = 0

export async function startHost(input: HostInput = {}) {
  const base = join(ROOT, `host-${++hosts}`)
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  const fake = startFakeGitHub()
  router.target = fake.origin
  const blockedBefore = router.blocked.length
  const sdk = input.load === "sdk"
  const config = {
    ...(sdk ? {} : { plugins: [{ package: REPO, options: input.options ?? {} }] }),
    // Keep the built-in local providers from probing their default ports.
    providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    // Schedule code checks are the host's unattended path that needs no model.
    experimental: { schedules: true },
    ...input.config?.(fake.origin),
  }
  const { OpenCode } = (await import(pathToFileURL(join(SDK, manifest.exports["."].import)).href)) as typeof import("@opencode/sdk")
  const plugins = sdk ? [(await import(pathToFileURL(join(REPO, "dist", "index.js")).href)).default as Plugin.Plugin, probe] : [probe]
  const client = (await OpenCode.create({
    plugins,
    // An embedded host reports "unknown" unless told, and the plugin's host check refuses that.
    app: { version: input.version ?? SDK_VERSION },
    config: { content: JSON.stringify(config), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })) as Client
  const location = { directory: work }
  const host = {
    client,
    location,
    fake,
    probe: () => {
      const ctx = probes.get(work)
      if (!ctx) throw new Error("the probe plugin has not loaded")
      return ctx
    },
    async close() {
      await client.close()
      router.target = undefined
      router.retired.add(fake.origin)
      await fake.close()
      // OpenCode probes a remote server's OAuth metadata (`/.well-known/…`) when it registers or re-registers it. That
      // probe is the host's own, carries no input and is blocked like everything else; it can also land as the host
      // closes, which used to fail a test at random. Any other request off the machine is the failure.
      const blocked = router.blocked.slice(blockedBefore).filter((url) => !/\/\.well-known\//.test(url))
      if (blocked.length > 0) throw new Error(`the host tried to leave the machine: ${[...new Set(blocked)].join(", ")}`)
    },
  }
  try {
    await until("the GitHub plugin has loaded", async () => (await pluginState(host)) !== undefined && probes.has(work), 60_000)
  } catch (error) {
    await host.close().catch(() => undefined)
    throw error
  }
  return host
}

export type Host = Awaited<ReturnType<typeof startHost>>

export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(50)
  }
}

export async function pluginState(host: Host) {
  const { data } = await host.client.plugin.list({ location: host.location })
  return data.find((plugin) => plugin.id === PLUGIN_ID)?.state
}

export async function githubServer(host: Host) {
  const { data } = await host.client.mcp.list({ location: host.location })
  return data.find((server) => server.name === "github")
}

export const integrationID = async (host: Host) =>
  until("the github server has an integration", async () => (await githubServer(host))?.integrationID)

/** The integration's oauth method IDs once the plugin's methods have replaced the host's. */
export async function ownMethods(host: Host, expected: readonly string[]) {
  const id = await integrationID(host)
  return until(`the integration lists ${expected.join(" and ")}`, async () => {
    const { data } = await host.client.integration.get({ integrationID: id, location: host.location })
    const ids = data.methods.flatMap((method) => (method.type === "oauth" ? [method.id] : []))
    return ids.length === expected.length && expected.every((method) => ids.includes(method)) && { name: data.name, ids }
  })
}

/** Signs in through the token method, the way /connect does, and waits until the attempt settles. */
export async function signInWithToken(host: Host, token = FIXTURE_PAT) {
  const id = await integrationID(host)
  const { data: started } = await host.client.integration.oauth.connect({ integrationID: id, methodID: "github-token", location: host.location })
  await host.client.integration.oauth.complete({ integrationID: id, attemptID: started.attemptID, code: token, location: host.location })
  const settled = await settledAttempt(host, id, started.attemptID)
  return { started, settled }
}

export async function settledAttempt(host: Host, id: string, attemptID: string) {
  return until("the sign-in attempt settles", async () => {
    const { data } = await host.client.integration.oauth.status({ integrationID: id, attemptID, location: host.location })
    return data.status !== "pending" && data
  })
}

export const connected = (host: Host) =>
  until("github is connected", async () => (await githubServer(host))?.status.status === "connected")

/** Resolves once the host lists the github server's tool, which happens after it connects. */
export const tool = (host: Host, id: string) =>
  until(`${id} is registered`, async () => (await host.probe().tool.list()).find((item) => item.id === id))

export const toolIDs = async (host: Host) => (await host.probe().tool.list()).map((item) => item.id).filter((id) => id.startsWith("github_")).sort()

export const session = async (host: Host, agent = "build", permissions?: readonly { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]) =>
  (await host.client.sessions.create({ agent, location: host.location, ...(permissions ? { permissions: [...permissions] } : {}) } as never)).id

let calls = 0

/**
 * Runs a tool through the host's own executor, which asserts the tool's permission for the
 * session's agent, as a model's call would. A prompt, if one appears, is answered with
 * `decision`. Reports whether it asked, and how the call ended.
 */
export async function attempt(
  host: Host,
  sessionID: string,
  agent: string,
  id: string,
  decision: "once" | "always" | "reject" = "reject",
  input: Record<string, unknown> = {},
) {
  const executor = await tool(host, id)
  const context = { sessionID, agent, messageID: `msg_host_test_${++calls}`, id: `call_host_test_${calls}`, signal: AbortSignal.timeout(60_000), progress: async () => {} }
  let settled = false
  const run = executor
    .execute(input, context as never)
    .then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    )
    .finally(() => {
      settled = true
    })
  let asked: string | undefined
  while (!settled) {
    const pending = await host.client.permission.list({ sessionID })
    const request = pending.find((item) => item.action === id)
    if (request) {
      asked = request.action
      await host.client.permission.reply({ sessionID, requestID: request.id, decision })
      break
    }
    await Promise.race([run, Bun.sleep(25)])
  }
  const outcome = await run
  return outcome.ok ? { asked, ok: true as const } : { asked, ok: false as const, error: outcome.error }
}

/**
 * Runs Code Mode `code` once with nobody present: OpenCode checks a schedule's code condition
 * when the schedule is created, unattended, with no model. The schedule is deleted at once.
 */
export async function unattended(host: Host, sessionID: string, code: string) {
  try {
    const schedule = await host.client.experimental.schedule.create({
      sessionID,
      name: "github-host-test",
      when: { in: "6 hours" },
      if: { code },
      prompt: "Deleted by the host test before it can run.",
    })
    await host.client.experimental.schedule.delete({ scheduleID: schedule.id })
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
  }
}

export const agentRules = async (host: Host) =>
  new Map((await host.client.agent.list({ location: host.location })).data.map((agent) => [agent.id as string, agent.permissions as Rule[]]))

/** The host's own evaluation for an MCP call (resource `*`), through its permission API. */
export async function effect(host: Host, agent: string, action: string) {
  const sessionID = await session(host, agent)
  return (await host.client.permission.create({ sessionID, agent, action, resources: ["*"] })).effect
}

/** Runs /github-status in a session and returns the notice it posts. */
export async function statusCommand(host: Host, sessionID: string) {
  await host.client.sessions.command({ sessionID, name: "github-status", text: "" })
  return until("/github-status posts its notice", async () => {
    const inbox = await host.client.session.inbox.list({ sessionID })
    const posted = inbox.filter((item) => item.type === "synthetic").at(-1)
    return posted?.type === "synthetic" ? posted.payload.text : undefined
  })
}

/** A tools RPC call's output, or its error's `{ type, code, message }`. */
export async function script(host: Host, method: string, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method, input: input as never, location: host.location })).output }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}
