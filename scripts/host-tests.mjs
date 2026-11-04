// Runs the host tests (test/host) once per tested OpenCode release, TESTED_HOSTS in src/host-version.ts. The release
// in the lockfile (2.2.3) runs on the SDK in node_modules. Each other one runs on HOST_SDK_DIR_<version>, a folder whose
// node_modules holds that @opencode/sdk, or else on @opencode/sdk@<version> installed with scripts disabled, once per
// run, into a temp folder under /tmp that is removed afterwards. The lockfile never gets a second SDK.
// With HOST_SDK_DIR set, it runs once, on that SDK only. Extra arguments go to `bun test`.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadSource } from "./source.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const { TESTED_HOSTS } = await loadSource("host-version.ts")
const locked = JSON.parse(readFileSync(join(root, "node_modules", "@opencode", "sdk", "package.json"), "utf8")).version
const installed = []

function install(version) {
  const dir = realpathSync(mkdtempSync(join(realpathSync("/tmp"), `github-host-sdk-${version}-`)))
  installed.push(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "github-host-sdk", private: true }))
  const result = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@opencode/sdk@${version}`], { cwd: dir, encoding: "utf8" })
  if (result.status !== 0 || !existsSync(join(dir, "node_modules", "@opencode", "sdk", "package.json"))) {
    throw new Error(`Could not install @opencode/sdk@${version}:\n${result.stderr}`)
  }
  return dir
}

const runs = process.env.HOST_SDK_DIR
  ? [{ label: `HOST_SDK_DIR (${process.env.HOST_SDK_DIR})`, dir: process.env.HOST_SDK_DIR }]
  : TESTED_HOSTS.map((version) => ({ label: version, version }))

const failed = []
try {
  for (const run of runs) {
    const dir = run.dir ?? (run.version === locked ? undefined : (process.env[`HOST_SDK_DIR_${run.version.replaceAll(".", "_")}`] ?? install(run.version)))
    console.log(`\nhost tests on @opencode/sdk ${run.label}${dir ? ` from ${dir}` : " from the lockfile"}`)
    const env = { ...process.env }
    delete env.HOST_SDK_DIR
    if (dir) env.HOST_SDK_DIR = dir
    const result = spawnSync("bun", ["test", "test/host", ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" })
    if (result.status !== 0) failed.push(run.label)
  }
} finally {
  for (const dir of installed.splice(0)) rmSync(dir, { recursive: true, force: true })
}
if (failed.length > 0) {
  console.error(`host tests failed on: ${failed.join(", ")}`)
  process.exitCode = 1
} else console.log(`host tests: OK on ${runs.map((run) => run.label).join(", ")}`)
