// Packs the package and checks the tarball a consumer installs.
//
//   npm run test:pack   (after npm run build)
//
// The tarball must carry the built server entry, the manifest, the skills and the icons, and nothing else; it must
// declare no runtime dependencies and no lifecycle script, and the server entry must be self-contained (no relative
// import, no contract copy, no kit) with @opencode/* left external for the host to provide.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const REQUIRED = ["package.json", "dist/index.js", "README.md", "LICENSE", "NOTICE", "assets/icon.svg", "skills/github/SKILL.md"]
const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|assets\/icon(?:-128|-256)?\.(?:svg|png)|dist\/index\.js|skills\/[a-z0-9-]+\/SKILL\.md)$/
const MAX_BYTES = 1_500_000

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const packed = JSON.parse(output)[0]
const files = new Set(packed.files.map((file) => file.path))
const problems = []
for (const file of REQUIRED) if (!files.has(file)) problems.push(`the tarball is missing ${file}`)
for (const file of files) if (!ALLOWED.test(file)) problems.push(`the tarball carries ${file}, which is not a release file`)
if (packed.size > MAX_BYTES) problems.push(`the tarball is ${packed.size} bytes, over ${MAX_BYTES}`)
if (pkg.name !== "@we-the-rebel-alliance/github-plugin" || pkg.version !== "0.0.0") problems.push(`the package is ${pkg.name}@${pkg.version}`)
if (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).length > 0) problems.push("the package declares runtime dependencies")
for (const script of ["preinstall", "install", "postinstall", "prepare", "prepack"]) if (pkg.scripts?.[script] !== undefined) problems.push(`the package has a ${script} script`)

const entry = readFileSync(join(root, "dist", "index.js"), "utf8")
if (/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']\.{1,2}\//.test(entry)) problems.push("dist/index.js has a relative import, so it is not self-contained")
if (entry.includes("plugin-kit")) problems.push("dist/index.js contains the kit")
if (!/from ["']@opencode\/plugin["']/.test(entry)) problems.push("dist/index.js does not import @opencode/plugin as an external host module")
if (!entry.includes("HOST_UNTESTED")) problems.push("dist/index.js does not carry the host gate")

if (problems.length > 0) {
  for (const problem of problems) console.error(`pack: ${problem}`)
  process.exitCode = 1
} else {
  console.log(`pack: ${packed.files.length} files, ${packed.size} bytes; dist/index.js, the manifest, the skills and the icons are in the tarball`)
}
