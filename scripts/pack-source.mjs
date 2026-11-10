// The package the pack smoke checks. When PACK_TARBALL names a file, that file is the one: the release workflow passes the
// tarball it publishes (through scripts/release-pack.mjs). Otherwise the smoke packs this checkout itself with npm pack.
// Both come back the same way, like an `npm pack --json` entry, so the checks do not depend on which one it is.
import { existsSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"

/**
 * @param {{ env: Record<string, string | undefined>, root: string, scratch: string,
 *   run: (command: string, args: string[], cwd: string) => string }} options
 */
export function packSource({ env, root, scratch, run }) {
  const named = env.PACK_TARBALL
  if (named) {
    const path = resolve(named)
    if (!existsSync(path)) throw new Error(`PACK_TARBALL names no file: ${named}`)
    const files = run("tar", ["-tzf", path], root)
      .split("\n")
      .filter((line) => line && !line.endsWith("/"))
      .map((line) => ({ path: line.replace(/^package\//, "") }))
    return { path, filename: basename(path), files, size: statSync(path).size }
  }
  return JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], root))[0]
}
