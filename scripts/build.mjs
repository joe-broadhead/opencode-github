// Builds dist/ as exactly two self-contained files, so an in-place plugin update can never mix
// a new entry with a stale sibling module that the host still holds:
// - dist/index.js: the server part (src/index.ts);
// - dist/tui.js: the TUI part (src/tui/index.tsx). Babel compiles its JSX with OpenTUI's Solid
//   preset as esbuild loads it, so no .tsx ships or runs from node_modules.
// esbuild bundles each entry alone (no splitting, no chunks): shared code such as the RPC
// contract, which is plain JSON Schema, is inlined into both; zod, which only the server
// part's option and github_api schemas use, goes into dist/index.js alone. What the host
// provides stays a bare import: @opencode/plugin, OpenTUI, Solid and node: built-ins. The build fails if an output imports
// anything else, or anything relative.
// NOTICE carries the licence of every bundled package, and nothing else. The build fails when
// NOTICE no longer matches what esbuild bundled; `node scripts/build.mjs --notice` rewrites it.
// Sources import zod as `import * as z`, which lets esbuild leave out what is unused.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { transformAsync } from "@babel/core"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const dist = join(root, "dist")
const HOST_PROVIDED = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const allowed = (path) =>
  path.startsWith("node:") || HOST_PROVIDED.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name))

const presets = [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }], "@babel/preset-typescript"]

/** Compiles .tsx with Babel's Solid preset as esbuild loads it; esbuild handles plain .ts itself. */
const solid = {
  name: "solid-tsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const result = await transformAsync(readFileSync(args.path, "utf8"), { filename: args.path, configFile: false, babelrc: false, presets })
      if (!result?.code) throw new Error(`Babel produced no output for ${relative(root, args.path)}`)
      return { contents: result.code, loader: "js" }
    })
  },
}

async function bundle(entry, outfile, plugins = []) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, entry)],
    outfile: join(dist, outfile),
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: HOST_PROVIDED,
    plugins,
    legalComments: "inline",
    metafile: true,
    logLevel: "warning",
  })
  const unexpected = Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter((item) => item.external && !allowed(item.path)).map((item) => item.path),
  )
  if (unexpected.length > 0) throw new Error(`dist/${outfile} imports modules that are neither bundled nor provided by the host: ${unexpected.join(", ")}`)
  return result.metafile
}

/** Checks NOTICE against the packages in the bundles (or rewrites it with --notice). */
function checkNotice(metafiles) {
  const inputs = metafiles.flatMap((metafile) => Object.keys(metafile.inputs))
  const packages = new Set(inputs.flatMap((input) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1] ?? []))
  const sections = [...packages].sort().map((name) => {
    const dir = join(root, "node_modules", name)
    const { version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry))
    if (!file) throw new Error(`${name} is bundled but ships no licence file`)
    return `## ${name} ${version} (${license})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`
  })
  const notice = `opencode-github bundles this third-party code into dist/.\n\n${sections.join("\n")}`
  const path = join(root, "NOTICE")
  if (process.argv.includes("--notice")) writeFileSync(path, notice)
  else if (!existsSync(path) || readFileSync(path, "utf8") !== notice) {
    throw new Error("NOTICE does not match the bundled packages. Run `node scripts/build.mjs --notice` to rewrite it.")
  }
}

try {
  rmSync(dist, { recursive: true, force: true })
  const server = await bundle("src/index.ts", "index.js")
  const tui = await bundle("src/tui/index.tsx", "tui.js", [solid])
  checkNotice([server, tui])
  const files = readdirSync(dist, { recursive: true }).map(String).sort()
  if (files.join(",") !== "index.js,tui.js") throw new Error(`dist/ must hold exactly index.js and tui.js, found: ${files.join(", ")}`)
} catch (error) {
  console.error(`build failed: ${error.message}`)
  process.exitCode = 1
}
