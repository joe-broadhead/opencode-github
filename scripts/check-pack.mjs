// Packs the plugin and checks the files a consumer receives.
//
//   npm run pack
// `npm pack` reads package.json `files`; this check proves the tarball holds the manifest, the built server entry, every
// skill, the assets, the README and the licence, and nothing else. It runs after `npm run bundle`, because
// `dist/index.js` is generated.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

const plugin = pkg.capabilities?.plugin?.name
if (typeof plugin !== "string" || plugin === "") {
  console.error("pack: package.json capabilities names no plugin id")
  process.exit(1)
}

const expected = [
  "LICENSE",
  "README.md",
  "assets/icon-128.png",
  "assets/icon-256.png",
  "assets/icon.svg",
  "dist/index.js",
  "package.json",
  `skills/${plugin}/SKILL.md`,
  "skills/github-code-research/SKILL.md",
  "skills/github-issue-triage/SKILL.md",
  "skills/github-pr-review/SKILL.md",
].sort()

const directory = mkdtempSync(join(tmpdir(), "plugin-pack-"))
try {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  const packed = JSON.parse(output)[0]
  if (typeof packed !== "object" || packed === null || !Array.isArray(packed.files)) {
    throw new Error("npm pack did not report the tarball's files")
  }
  const files = packed.files.map((file) => file.path).sort()
  const missing = expected.filter((file) => !files.includes(file))
  const unexpected = files.filter((file) => !expected.includes(file))
  if (missing.length > 0 || unexpected.length > 0) {
    if (missing.length > 0) console.error(`pack: the tarball is missing ${missing.join(", ")}`)
    if (unexpected.length > 0) console.error(`pack: the tarball carries unexpected ${unexpected.join(", ")}`)
    process.exitCode = 1
  } else {
    console.log(`pack: ${files.length} files: ${files.join(", ")}`)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
