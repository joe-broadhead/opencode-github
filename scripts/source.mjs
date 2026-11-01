// Loads a TypeScript module from src/ for a maintainer script. dist/ holds only the bundled
// entries, so scripts that need internals (the tool catalog, the options, the default
// rules) bundle the one module they need with esbuild and import the result.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))

/** Imports `src/<path>` (for example "config.ts") with its dependencies bundled. */
export async function loadSource(path) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, "src", path)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["@opencode/plugin", "@opencode/plugin/*"],
    logLevel: "warning",
  })
  // Next to package.json, so the host packages left external resolve from node_modules.
  const dir = mkdtempSync(join(root, ".source-"))
  try {
    const file = join(dir, "module.mjs")
    writeFileSync(file, result.outputFiles[0].text)
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
