// Packs the package, checks the file list and size, installs the tarball into a fresh project with
// lifecycle scripts disabled (as OpenCode installs plugins), and checks that it pulls in none of the
// packages OpenCode supplies itself. Then it loads the installed plugin in each stock OpenCode release of
// TESTED_HOSTS (the plugin active, its skills read from the installed package), checks that dist/ holds
// exactly the two self-contained entries, and finally imports the server entry with @opencode/plugin installed beside it in
// place of the host. Run it through `npm run test:pack`, which builds first.
// PACK_TARBALL, when set, names the tarball to check instead of packing this checkout; the release workflow sets it to
// the tarball it publishes (scripts/release-pack.mjs). See scripts/pack-source.mjs.
//
// The stock binaries come from OPENCODE_BIN_2_2_3 to OPENCODE_BIN_2_2_6. When one is
// unset, @opencode/cli and its platform package are installed into the temp folder with scripts disabled,
// once per version. Each host runs in its own temporary profile under /tmp, on its own free port, with a
// proxy that refuses every outbound request.
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { packSource } from "./pack-source.mjs"
import { loadSource } from "./source.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const NAME = "@joe-broadhead/opencode-github"
const PLUGIN_ID = "github.platform"
const MAX_PACKED_BYTES = 200_000
// The assets are Jelly's mark: the SVG and its two PNGs.
const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|assets\/icon(?:-128|-256)?\.(?:svg|png)|dist\/(index|tui)\.js|skills\/[a-z0-9-]+\/SKILL\.md)$/
const REQUIRED = ["dist/index.js", "dist/tui.js", "NOTICE", "assets/icon.svg", "assets/icon-128.png", "assets/icon-256.png"]
const SKILLS = ["github-code-research", "github-issue-triage", "github-pr-review"]
// A relative static import, dynamic import or require in a shipped entry. Each entry must be
// self-contained, so an in-place update never pairs a new entry with a stale sibling module.
// The TUI's status contract is plain JSON Schema, so dist/tui.js must stay small and zod-free.
const MAX_TUI_BYTES = 30_000
const ZOD = /node_modules\/zod\/|\bZodError\b|\bZodType\b/
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']\.{1,2}\//
// OpenCode supplies these to plugins at runtime, so the package must not declare or pull them in.
const HOST_PACKAGES = ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]
// Scripts that run on install or pack. The package has none: dist/ is built before packing.
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepack"]
/** The one list of tested releases, from src/host-version.ts. */
const { TESTED_HOSTS: STOCK_HOSTS } = await loadSource("host-version.ts")
const HOST_TIMEOUT_MS = 180_000
const OFFLINE = { OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FREE_MODELS: "1" }

const IMPORT_CHECK = `
import assert from "node:assert/strict"
const server = (await import("${NAME}")).default
assert.equal(server?.id, "${PLUGIN_ID}", "server part id")
assert.equal(typeof server.setup, "function", "server part setup")
assert.match(import.meta.resolve("${NAME}/tui"), /\\/dist\\/tui\\.js$/, "TUI entry")
assert.throws(() => import.meta.resolve("${NAME}/rpc"), "the RPC contract is internal")
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A temp folder under the system's /tmp, never under $TMPDIR, which can sit below $HOME: OpenCode searches upward for
 * .opencode folders and opencode.json files and would read the owner's own. One with them above it is refused.
 */
function scratchDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(realpathSync("/tmp"), prefix)))
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    const found = [".opencode", "opencode.json", "opencode.jsonc"].map((name) => join(parent, name)).find((path) => existsSync(path))
    if (found) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`${found} is above the test folder ${dir}, so OpenCode would read it. Remove it, then run the tests again.`)
    }
    if (dirname(parent) === parent) return dir
  }
}

function run(command, args, cwd, env = process.env) {
  try {
    return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${error.stderr || error.stdout || error.message}`)
  }
}

function checkManifest(manifest) {
  const problems = []
  for (const script of LIFECYCLE_SCRIPTS) if (manifest.scripts?.[script]) problems.push(`package.json has a "${script}" script`)
  if (manifest.bundleDependencies || manifest.bundledDependencies) problems.push("package.json bundles dependencies")
  if (manifest.peerDependencies || manifest.peerDependenciesMeta) problems.push("package.json declares peer dependencies; OpenCode supplies @opencode/plugin, OpenTUI and Solid itself")
  const dependencies = Object.keys(manifest.dependencies ?? {})
  if (dependencies.length > 0) problems.push(`the package must have no runtime dependencies (zod is bundled), found: ${dependencies.join(", ")}`)
  return problems
}

function checkPack(pack) {
  const paths = pack.files.map((file) => file.path)
  const problems = []
  for (const path of paths) if (!ALLOWED.test(path)) problems.push(`unexpected packed file: ${path}`)
  for (const path of REQUIRED) if (!paths.includes(path)) problems.push(`missing packed file: ${path}`)
  if (paths.some((path) => path.endsWith(".tsx"))) problems.push("a .tsx file is packed")
  if (pack.size >= MAX_PACKED_BYTES) problems.push(`packed size ${pack.size} bytes is not under ${MAX_PACKED_BYTES}`)
  return problems
}

/** The installed entries: exactly dist/index.js and dist/tui.js, neither importing a sibling, and a small zod-free TUI. */
function checkEntries(installed) {
  const problems = []
  const files = readdirSync(join(installed, "dist"), { recursive: true }).map(String).sort()
  if (files.join(",") !== "index.js,tui.js") problems.push(`dist/ must hold exactly index.js and tui.js, found: ${files.join(", ")}`)
  for (const file of files.filter((name) => name.endsWith(".js"))) {
    const lines = readFileSync(join(installed, "dist", file), "utf8").split("\n")
    const hit = lines.findIndex((line) => RELATIVE_IMPORT.test(line))
    if (hit !== -1) problems.push(`dist/${file}:${hit + 1} imports a relative module: ${lines[hit].trim().slice(0, 120)}`)
  }
  const tui = readFileSync(join(installed, "dist", "tui.js"), "utf8")
  if (ZOD.test(tui)) problems.push("dist/tui.js contains zod; the RPC contract must be plain JSON Schema")
  if (Buffer.byteLength(tui) >= MAX_TUI_BYTES) problems.push(`dist/tui.js is ${Buffer.byteLength(tui)} bytes, not under ${MAX_TUI_BYTES}`)
  return problems
}

const binaries = new Map()

/** OPENCODE_BIN_<version>, or the stock binary installed from npm with scripts disabled, once per version. */
function stockBinary(version, work) {
  const configured = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (configured) return configured
  if (!binaries.has(version)) binaries.set(version, install(version, work))
  return binaries.get(version)
}

function install(version, work) {
  const dir = join(work, `cli-${version}`)
  mkdirSync(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cli", private: true }))
  const platform = `@opencode/cli-${process.platform}-${process.arch}`
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@opencode/cli@${version}`, `${platform}@${version}`], dir)
  return join(dir, "node_modules", platform, "bin", "opencode")
}

/** A loopback proxy that records each request line and refuses it, so nothing leaves the machine. */
async function deadProxy() {
  const attempts = []
  const server = createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", (chunk) => {
      attempts.push(String(chunk).split("\r\n")[0])
      socket.destroy()
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, attempts, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function until(what, check) {
  const deadline = Date.now() + HOST_TIMEOUT_MS
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await sleep(500)
  }
}

/**
 * Loads the installed plugin into stock OpenCode `version` from a project config, as a user does, and
 * checks that it is active, registered the github server, lists it in /connect as GitHub with only
 * the token method (no client ID yet), inserted its rules after each agent's base allow rule and
 * answers the status RPC. Returns the problems found.
 */
async function loadInStock(version, binary, work, installed) {
  const { defaultRules } = await loadSource("permissions.ts")
  const { isStatus } = await loadSource("rpc.ts")
  const base = join(work, `host-${version}`)
  const home = join(base, "home")
  const project = join(base, "project")
  const profile = {
    HOME: home,
    // Bun ignores a changed HOME, so OpenCode's own variable sets it too.
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(base, "tmp"),
  }
  for (const dir of [...Object.values(profile), project]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({
      plugins: [installed],
      // Keep the built-in local providers from probing their default ports.
      providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    }),
  )
  const proxy = await deadProxy()
  const password = randomUUID()
  const env = {
    ...profile,
    ...OFFLINE,
    PATH: "/usr/bin:/bin",
    OPENCODE_PASSWORD: password,
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    NO_PROXY: "127.0.0.1,localhost",
  }
  const problems = []
  const reported = run(binary, ["--version"], project, env).trim()
  if (reported !== `opencode v${version}`) return [`${binary} reports ${reported}, not opencode v${version}`]
  const outside = run(binary, ["debug", "paths"], project, env)
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((path) => !path?.startsWith(`${base}/`))
  if (outside.length > 0) return [`OpenCode ${version} resolves paths outside its temporary profile: ${outside.join(", ")}`]

  const port = await freePort()
  const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: "ignore" })
  const exited = new Promise((resolve) => server.once("exit", resolve))
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const api = async (method, path, body) => {
    const url = new URL(path, `http://127.0.0.1:${port}`)
    url.searchParams.set("location[directory]", project)
    const response = await fetch(url, { method, headers: { authorization, "content-type": "application/json" }, body: body && JSON.stringify(body) })
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`)
    return response.json()
  }
  try {
    const state = await until("the plugin has loaded", async () => (await api("GET", "/api/plugin")).data.find((plugin) => plugin.id === PLUGIN_ID)?.state)
    if (state.status !== "active") return [`OpenCode ${version} did not activate the plugin: ${JSON.stringify(state)}`]
    const github = await until("the github server is registered", async () => (await api("GET", "/api/mcp")).data.find((item) => item.name === "github"))
    if (typeof github.integrationID !== "string") problems.push(`OpenCode ${version} registered github without an integration`)
    else {
      // What /connect lists: the display name and the sign-in methods, once the plugin's methods replace the host's.
      const listed = await until("the integration lists the token method", async () => {
        const { data } = await api("GET", `/api/integration/${github.integrationID}`)
        const methods = data.methods.map((method) => method.id ?? method.type)
        return methods.join(",") === "github-token" && data
      }).catch(() => undefined)
      if (!listed) problems.push(`OpenCode ${version}: /connect does not offer exactly the token method for github`)
      else if (listed.name !== "GitHub") problems.push(`OpenCode ${version}: /connect names the integration ${listed.name}, not GitHub`)
      else {
        const { data: all } = await api("GET", "/api/integration")
        if (!all.some((item) => item.id === github.integrationID && item.name === "GitHub")) problems.push(`OpenCode ${version}: /connect does not list GitHub`)
      }
    }
    const rules = defaultRules()
    const agents = (await api("GET", "/api/agent")).data.filter((agent) => agent.permissions.some(isBaseAllow))
    if (agents.length === 0) problems.push(`OpenCode ${version} has no agent with a base allow rule`)
    for (const agent of agents) {
      const start = agent.permissions.findIndex(isBaseAllow) + 1
      if (!rules.every((rule, index) => sameRule(agent.permissions[start + index], rule))) {
        problems.push(`OpenCode ${version}: agent ${agent.id} lacks the default rules after its base allow rule`)
      }
    }
    // The skills are read from the package next to dist/ at setup, so the installed layout must resolve them.
    const skills = (await api("GET", "/api/skill")).data.map((skill) => skill.id).filter((id) => id.startsWith("github-")).sort()
    if (skills.join(",") !== SKILLS.join(",")) problems.push(`OpenCode ${version} lists the skills ${skills.join(", ") || "none"}, not ${SKILLS.join(", ")}`)
    const { output } = await api("POST", `/api/rpc/${PLUGIN_ID}/status`, { input: {} })
    if (!isStatus(output)) problems.push(`OpenCode ${version}: the status RPC answered ${JSON.stringify(output)}`)
  } finally {
    server.kill("SIGTERM")
    await Promise.race([exited, sleep(10_000)])
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL")
    await proxy.close()
  }
  const escaped = proxy.attempts.filter((line) => !line.startsWith("CONNECT api.githubcopilot.com:443 "))
  if (escaped.length > 0) problems.push(`OpenCode ${version} tried to reach more than GitHub's MCP server: ${escaped.join(", ")}`)
  return problems
}

const sameRule = (a, b) => a?.action === b.action && a?.resource === b.resource && a?.effect === b.effect
const isBaseAllow = (rule) => sameRule(rule, { action: "*", resource: "*", effect: "allow" })

async function main() {
  const work = scratchDir("github-pack-smoke-")
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const problems = checkManifest(manifest)
    const pack = packSource({ env: process.env, root, scratch: work, run })
    problems.push(...checkPack(pack))
    if (problems.length > 0) throw new Error(problems.join("\n"))

    const consumer = join(work, "consumer")
    mkdirSync(consumer)
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }))
    run("npm", ["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", pack.path ?? join(work, pack.filename)], consumer)
    const installed = (name) => existsSync(join(consumer, "node_modules", name, "package.json"))
    const pulled = HOST_PACKAGES.filter(installed)
    if (pulled.length > 0) throw new Error(`installing the package pulled in host-provided packages: ${pulled.join(", ")}`)

    const entries = checkEntries(join(consumer, "node_modules", NAME))
    if (entries.length > 0) throw new Error(entries.join("\n"))

    for (const version of STOCK_HOSTS) {
      const found = await loadInStock(version, stockBinary(version, work), work, join(consumer, "node_modules", NAME))
      if (found.length > 0) throw new Error(found.join("\n"))
    }

    // Stand in for the host, which supplies @opencode/plugin to the built entries at runtime.
    run("npm", ["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", `@opencode/plugin@${manifest.devDependencies["@opencode/plugin"]}`], consumer)
    run(process.execPath, ["--input-type=module", "-e", IMPORT_CHECK], consumer)

    console.log(
      `pack-smoke: OK (${pack.files.length} files, ${pack.size} bytes packed${pack.unpackedSize ? `, ${pack.unpackedSize} bytes unpacked` : ""}; limit ${MAX_PACKED_BYTES}; loaded in stock OpenCode ${STOCK_HOSTS.join(", ")})`,
    )
    return 0
  } catch (error) {
    console.error(`pack-smoke failed:\n${error.message}`)
    return 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

process.exitCode = await main()
