// Builds dist/index.js: the one server entry package.json exports, as one self-contained ES module.
//
//   npm run build
//
// @opencode/* stays external, because OpenCode provides it at run time. The contract modules are bundled, so a tag
// installs and runs with no build and no runtime dependency. dist/ is generated, never edited by hand.
import { readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "dist")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

rmSync(dist, { recursive: true, force: true })
await build({
  entryPoints: [{ in: join(root, "src", "index.ts"), out: "index" }],
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["@opencode/*"],
  legalComments: "none",
  logLevel: "warning",
  banner: { js: `// ${pkg.name} ${pkg.version}. Built by scripts/build.mjs; do not edit.` },
})

console.log(`built ${pkg.name} ${pkg.version} into dist/index.js`)
