// Temporary folders for isolated OpenCode hosts. They go under the system's /tmp, never under $TMPDIR, which can sit
// below $HOME: OpenCode searches upward from a project for .opencode folders and opencode.json files, and would read
// the owner's own (QA X7). A folder with one of those above it is refused.
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const FOUND_UPWARD = [".opencode", "opencode.json", "opencode.jsonc"]

/** A new folder under `base`, the system's /tmp unless a test passes another. */
export function scratchDir(prefix: string, base = realpathSync("/tmp")): string {
  const dir = realpathSync(mkdtempSync(join(base, prefix)))
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    const found = FOUND_UPWARD.map((name) => join(parent, name)).find((path) => existsSync(path))
    if (found) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`${found} is above the test folder ${dir}, so OpenCode would read it. Remove it, then run the tests again.`)
    }
    if (dirname(parent) === parent) return dir
  }
}
