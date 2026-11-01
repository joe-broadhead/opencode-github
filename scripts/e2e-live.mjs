// Live end-to-end check against GitHub, run by a maintainer with a token (Bun):
//   GITHUB_E2E_TOKEN=<token> npm run e2e
// An in-process OpenCode host from @opencode/sdk loads the built plugin from a config
// plugins entry, as a user would, in a temporary profile. It signs in with the token method,
// waits up to 60 s for github to connect, runs every case in test/e2e/cases.json (each
// catalogued read tool of the default toolsets) and prints a pass/fail table without
// response content. The token is never printed. Write tools are never called: the plugin
// runs read-only and every case must be a catalogued read.
// Exit codes: 0 every case passed, 1 a case failed, 2 GITHUB_E2E_TOKEN is not set.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const token = process.env.GITHUB_E2E_TOKEN
if (!token) {
  console.error(
    "GITHUB_E2E_TOKEN is not set. Create a fine-grained personal access token that can read the repositories in test/e2e/cases.json, then run: GITHUB_E2E_TOKEN=<token> npm run e2e",
  )
  process.exit(2)
}

const PLUGIN_ID = "github.platform"
const CASE_TIMEOUT_MS = 60_000
const REPO = realpathSync(fileURLToPath(new URL("../", import.meta.url)))
const root = realpathSync(mkdtempSync(join(tmpdir(), "github-e2e-")))
const home = join(root, "home")

// A temporary profile: OpenCode reads its XDG roots once at import, so this runs before it loads.
// The working directory moves into it too, because the host can also open a location there.
const KEEP = /^(PATH|LANG|TZ|TERM|BUN_.*|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/
for (const key of Object.keys(process.env)) if (!KEEP.test(key)) delete process.env[key]
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  TMPDIR: join(root, "tmp"),
  OPENCODE_TEST_HOME: home,
})
for (const dir of [home, join(root, "tmp"), join(root, "work")]) mkdirSync(dir, { recursive: true })
process.chdir(home)

const scrub = (text) => String(text).split("\n")[0].replaceAll(token, "<token>").slice(0, 160)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`)
    await sleep(250)
  }
}

/** Resolves {name} placeholders from the file's values; records names that are not set. */
function resolveArgs(value, values, missing) {
  const lookup = (name) => {
    const found = values[name]
    if (found === undefined || found === "") missing.add(name)
    return found ?? ""
  }
  if (typeof value === "string") {
    const whole = /^\{([a-z_]+)\}$/.exec(value)
    return whole ? lookup(whole[1]) : value.replace(/\{([a-z_]+)\}/g, (_, name) => String(lookup(name)))
  }
  if (Array.isArray(value)) return value.map((item) => resolveArgs(item, values, missing))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveArgs(item, values, missing)]))
  return value
}

// Bun imports TypeScript directly.
const { HIDDEN, KNOWN_TOOLS, toolKind } = await import(pathToFileURL(join(REPO, "src", "tools.ts")).href)
const { DEFAULT_TOOLSETS } = await import(pathToFileURL(join(REPO, "src", "config.ts")).href)
const file = JSON.parse(readFileSync(join(REPO, "test", "e2e", "cases.json"), "utf8"))

const notReads = file.cases.filter((item) => toolKind(item.tool) !== "read").map((item) => item.tool)
if (notReads.length > 0) {
  console.error(`test/e2e/cases.json may only list catalogued read tools. Remove: ${notReads.join(", ")}`)
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}
const listed = new Set(file.cases.map((item) => item.tool))
const uncovered = DEFAULT_TOOLSETS.flatMap((toolset) => KNOWN_TOOLS[toolset].read).filter(
  (name, index, all) => all.indexOf(name) === index && !listed.has(name) && !HIDDEN.includes(name),
)

const { Plugin } = await import("@opencode/plugin")
const { OpenCode } = await import("@opencode/sdk")
const version = JSON.parse(readFileSync(join(REPO, "node_modules", "@opencode", "sdk", "package.json"), "utf8")).version
const location = { directory: join(root, "work") }
const probes = []
const probe = Plugin.define({ id: "github.e2e.probe", setup: (ctx) => void probes.push(ctx) })
const config = {
  plugins: [{ package: REPO, options: {} }],
  // Keep the built-in local providers from probing their default ports.
  providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
}

const rows = []
const record = (name, ok, detail) => rows.push({ name, ok, detail })
let host
try {
  host = await OpenCode.create({
    plugins: [probe],
    // An embedded host reports "unknown" unless told, and the plugin refuses that.
    app: { version },
    config: { content: JSON.stringify(config), directory: join(root, "config"), project: false, claude: false },
    database: { path: join(root, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })
  const server = async () => (await host.mcp.list({ location })).data.find((item) => item.name === "github")
  await until(
    "the plugin to load",
    async () => {
      const state = (await host.plugin.list({ location })).data.find((item) => item.id === PLUGIN_ID)?.state
      if (state?.status === "failed") throw new Error(`the plugin failed to load: ${scrub(state.error)}`)
      return state?.status === "active" && probes.length > 0
    },
    60_000,
  )
  // Stop before signing in unless OpenCode keeps its global folders in the temporary profile.
  const { paths } = await host.server.info()
  const global = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((key) => join(process.env[key], "opencode"))
  if (global.some((path) => !existsSync(path)) || !realpathSync(paths.tmp).startsWith(`${root}/`)) {
    throw new Error("OpenCode is not using the temporary profile")
  }
  const integrationID = await until("the github server to register", async () => (await server())?.integrationID, 60_000)
  await until(
    "the token sign-in method",
    async () => (await host.integration.get({ integrationID, location })).data.methods.some((method) => method.type === "oauth" && method.id === "github-token"),
    30_000,
  )
  const { data: started } = await host.integration.oauth.connect({ integrationID, methodID: "github-token", location })
  await host.integration.oauth.complete({ integrationID, attemptID: started.attemptID, code: token, location })
  const attempt = await until(
    "the sign-in to finish",
    async () => {
      const { data } = await host.integration.oauth.status({ integrationID, attemptID: started.attemptID, location })
      return data.status !== "pending" && data
    },
    30_000,
  )
  if (attempt.status !== "complete") throw new Error(`sign-in ${attempt.status}${attempt.message ? `: ${scrub(attempt.message)}` : ""}`)
  await until("github to connect", async () => (await server())?.status.status === "connected", 60_000).catch(async (error) => {
    const status = (await server())?.status
    throw new Error(`${error.message}; github is ${status?.status ?? "missing"}${status?.error ? `: ${scrub(status.error)}` : ""}`)
  })

  const ctx = probes[0]
  const tools = await until("GitHub's tools", async () => {
    const list = await ctx.tool.list()
    return list.some((item) => item.id === "github_get_me") && list
  }, 30_000)
  const sessionID = (await host.session.create({ agent: "build", location })).id
  let calls = 0
  const run = async (id, args) => {
    const executor = tools.find((item) => item.id === id)
    if (!executor) throw new Error("not offered by GitHub's server")
    const context = { sessionID, agent: "build", messageID: `msg_e2e_${++calls}`, id: `call_e2e_${calls}`, signal: AbortSignal.timeout(CASE_TIMEOUT_MS), progress: async () => {} }
    let settled = false
    const pending = executor.execute(args, context).finally(() => {
      settled = true
    })
    // A read never asks; if one does, refuse it rather than wait.
    while (!settled) {
      const request = (await host.permission.list({ sessionID })).find((item) => item.action === id)
      if (request) {
        await host.permission.reply({ sessionID, requestID: request.id, decision: "reject" })
        await pending.catch(() => undefined)
        throw new Error("asked for permission; known reads should not")
      }
      await Promise.race([pending.catch(() => undefined), sleep(100)])
    }
    return pending
  }

  for (const name of uncovered) record(name, false, "no case in test/e2e/cases.json")
  for (const item of file.cases) {
    const missing = new Set()
    const args = resolveArgs(item.args, file.values, missing)
    if (missing.size > 0) {
      record(item.tool, false, `set ${[...missing].map((name) => `values.${name}`).join(", ")} in test/e2e/cases.json`)
      continue
    }
    const started = Date.now()
    await run(`github_${item.tool}`, args).then(
      () => record(item.tool, true, `${Date.now() - started} ms`),
      (error) => record(item.tool, false, scrub(error instanceof Error ? error.message : error)),
    )
  }
} catch (error) {
  record("setup", false, scrub(error instanceof Error ? error.message : error))
} finally {
  await host?.close().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}

const width = Math.max(...rows.map((row) => row.name.length))
console.log(`GitHub end-to-end on OpenCode ${version}`)
for (const row of rows) console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.name.padEnd(width)}  ${row.detail}`)
const passed = rows.filter((row) => row.ok).length
console.log(`${passed} of ${rows.length} passed.`)
process.exit(passed === rows.length ? 0 : 1)
