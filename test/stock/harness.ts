// Stock `opencode serve` binaries for the stock host test, through the public client. Each host gets its own temp root
// holding HOME, OpenCode's test home, the XDG folders, TMPDIR and one project, whose config loads the built plugin from
// this checkout and the probe (./probe), which points the github server at the loopback fake. Outbound HTTP goes to a
// recording proxy that refuses every request; loopback is direct. A start checks the binary's version and that every
// `opencode debug paths` entry stays inside the root.
//
// The binaries come from OPENCODE_BIN_2_2_3, OPENCODE_BIN_2_2_4 and OPENCODE_BIN_2_2_5 (one per TESTED_HOSTS entry).
// When one is unset, the unmodified npm release is installed with scripts disabled, once per version and test run, into
// its own temp folder. Temp folders sit under /tmp (scratchDir), and each host gets its own free port.
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { arch, platform } from "node:os"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { TESTED_HOSTS } from "../../src/host-version.js"
import { scratchDir } from "../host/scratch.js"

export const REPO = realpathSync(fileURLToPath(new URL("../..", import.meta.url)))
const PROBE = join(REPO, "test", "stock", "probe")
const PLUGIN_ID = "github.platform"

/** The stock OpenCode releases the plugin is tested on: the one list in src/host-version.ts. */
export const STOCK_VERSIONS = TESTED_HOSTS

/** How long a stock host may take to start, or a condition to hold; much longer than usual on a busy machine. */
const READY_MS = 180_000

const OFFLINE = { OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FREE_MODELS: "1" }
/** Keeps the built-in local providers from probing their default loopback ports. */
const LOCAL_PROVIDERS_OFF = { providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } } }

const installs = new Map<string, Promise<string>>()
const installed: string[] = []

/** OPENCODE_BIN_<version>, or the npm release, installed at most once per version in this run. */
function stockBinary(version: string): Promise<string> {
  const given = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) return Promise.resolve(given)
  let binary = installs.get(version)
  if (!binary) {
    binary = install(version)
    installs.set(version, binary)
  }
  return binary
}

async function install(version: string): Promise<string> {
  // Its own package.json, and npm's cwd set to it: npm walks up from a folder that has none.
  const dir = scratchDir(`github-stock-opencode-${version}-`)
  installed.push(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "github-stock-opencode", private: true }))
  const native = `@opencode/cli-${platform()}-${arch()}`
  const result = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@opencode/cli@${version}`, `${native}@${version}`], { cwd: dir, encoding: "utf8" })
  const path = join(dir, "node_modules", native, "bin", "opencode")
  if (result.status !== 0 || !existsSync(path)) throw new Error(`Could not install @opencode/cli@${version} for ${platform()}-${arch()}:\n${result.stderr}`)
  return path
}

/** Removes the binaries this run installed; call once after every host has closed. */
export function cleanupStock() {
  for (const dir of installed.splice(0)) rmSync(dir, { recursive: true, force: true })
  installs.clear()
}

/** A loopback proxy that records each request line and refuses it, so nothing leaves the machine. */
async function deadProxy() {
  const attempts: string[] = []
  const server = createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", (chunk) => {
      attempts.push(String(chunk).split("\r\n")[0] ?? "")
      socket.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("the proxy has no port")
  return { url: `http://127.0.0.1:${address.port}`, attempts, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === "string") throw new Error("no free port")
  return address.port
}

export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = READY_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(250)
  }
}

export interface StockInput {
  /** The GitHub plugin's options. */
  readonly options?: Record<string, unknown>
  /** Agents defined in the project config. */
  readonly agents?: Record<string, unknown>
  /** The fake GitHub's MCP endpoint and the token it accepts. */
  readonly fake: { readonly url: string; readonly token: string }
}

export interface StockHost {
  readonly version: string
  readonly client: OpenCodeClient
  readonly location: { readonly directory: string }
  /** The first line of every request that tried to leave the machine. */
  readonly attempts: readonly string[]
  close(): Promise<void>
}

export async function startStock(version: string, input: StockInput): Promise<StockHost> {
  const binary = await stockBinary(version)
  const root = scratchDir(`github-stock-${version}-`)
  const home = join(root, "home")
  const project = join(root, "project")
  const profile = {
    HOME: home,
    // Bun ignores a changed HOME, so OpenCode's own variable sets it too.
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(root, "tmp"),
  }
  for (const dir of [...Object.values(profile), project, join(home, ".config", "opencode")]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify(LOCAL_PROVIDERS_OFF))
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({
      ...LOCAL_PROVIDERS_OFF,
      // The probe comes after the plugin: transforms run in config order.
      plugins: [{ package: REPO, options: input.options ?? {} }, { package: PROBE, options: input.fake }],
      ...(input.agents ? { agents: input.agents } : {}),
    }),
  )
  const proxy = await deadProxy()
  const password = randomUUID()
  const env = { ...profile, ...OFFLINE, PATH: "/usr/bin:/bin", OPENCODE_PASSWORD: password, HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1,localhost" }
  const remove = async () => {
    await proxy.close()
    rmSync(root, { recursive: true, force: true })
  }

  const reported = spawnSync(binary, ["--version"], { cwd: project, env, encoding: "utf8" }).stdout.trim()
  const paths = spawnSync(binary, ["debug", "paths"], { cwd: project, env, encoding: "utf8" }).stdout.trim().split("\n")
  const outside = paths.map((line) => line.trim().split(/\s+/)[1] ?? "").filter((path) => !path.startsWith(root + sep))
  if (reported !== `opencode v${version}` || paths.length < 6 || outside.length > 0) {
    await remove()
    throw new Error(`${binary} reports ${JSON.stringify(reported)} for ${version}, and these paths outside its root: ${outside.join(", ")}`)
  }

  let output = ""
  const port = await freePort()
  const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  server.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString()))
  server.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString()))
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()))
  const close = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM")
      const timer = setTimeout(() => server.kill("SIGKILL"), 10_000)
      await exited
      clearTimeout(timer)
    }
    await remove()
  }
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` } })
  const location = { directory: project }
  try {
    const state = await until("the plugin has loaded", async () => (await client.plugin.list({ location })).data.find((plugin) => plugin.id === PLUGIN_ID)?.state)
    if (state.status !== "active") throw new Error(`the plugin did not activate: ${JSON.stringify(state)}`)
    await until("the github server is connected", async () => (await client.mcp.list({ location })).data.find((item) => item.name === "github")?.status.status === "connected")
  } catch (error) {
    await close()
    throw new Error(`opencode ${version}: ${error instanceof Error ? error.message : String(error)}\n${output.slice(-2000)}`)
  }
  return { version, client, location, attempts: proxy.attempts, close }
}
