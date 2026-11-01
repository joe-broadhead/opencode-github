// Imported first by the harness, before anything loads OpenCode. OpenCode reads its XDG roots
// once at import, and Bun's os.homedir() ignores a changed HOME, so the environment is
// replaced here: a fresh temp root holds HOME, XDG_*, TMPDIR and OpenCode's test home, and
// a parent OpenCode session, provider keys and proxies do not leak in. The working directory
// moves there too, because the host can also open a location at it.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** A directory whose node_modules holds another @opencode/sdk, such as 2.2.4 installed outside the lockfile. */
export const SDK_OVERRIDE = process.env.HOST_SDK_DIR ? resolve(process.env.HOST_SDK_DIR) : undefined

export const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "github-host-test-")))
const home = join(ROOT, "home")

const KEEP = ["PATH", "LANG", "TZ", "TERM"]
for (const key of Object.keys(process.env)) {
  if (!KEEP.includes(key) && !key.startsWith("BUN_")) delete process.env[key]
}
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  TMPDIR: join(ROOT, "tmp"),
  OPENCODE_TEST_HOME: home,
})
for (const dir of [home, join(ROOT, "tmp")]) mkdirSync(dir, { recursive: true })
process.chdir(home)
