// Fails when source, tests, scripts or the built dist/ use an API that public OpenCode
// 2.2.3 deprecates, marks experimental or does not support, or contain a machine-local
// path. `--self-test` proves that every rule fires on a bad fixture and that a clean
// fixture passes; `npm run lint` runs it first.
//
// Patterns that this scan greps for literally (machine-local paths, private host source
// paths) are split here so this file does not trip the scan itself.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const SELF = "scripts/check-forbidden.mjs"
const SCANNED = ["src", "test", "scripts"]

// scope "all": src/, test/, scripts/ and dist/. "dist": built JavaScript only. "tui": dist/tui.js only.
const RULES = [
  { name: "V1 plugin package", scope: "all", pattern: /@opencode-ai\//, sample: 'import { tool } from "@opencode-ai/plugin"' },
  { name: "ctx.generate (deprecated)", scope: "all", pattern: /ctx\.generate\./, sample: "await ctx.generate.text(input)" },
  { name: "experimental.policies (deprecated)", scope: "all", pattern: /experimental\.policies/, sample: "config.experimental.policies" },
  { name: "ctx.experimental.artifact (experimental, new in 2.2.4)", scope: "all", pattern: /experimental\.artifact\b/, sample: "await ctx.experimental.artifact.create(input)" },
  { name: "@opencode/ai import (breaks between patches)", scope: "all", pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']@opencode\/ai(?:\/[^"']*)?["']/, sample: 'import { Provider } from "@opencode/ai/provider"' },
  { name: "private OpenCode source import", scope: "all", pattern: /packages\/(core|plugin|schema|sdk|server|tui)\/src/, sample: ["import x from \"../opencode/packages", "core", "src/index.ts\""].join("/") },
  { name: "machine-local path", scope: "all", pattern: /\/Users\//, sample: ["const home = \"", "Users", "someone\""].join("/") },
  { name: "machine-local path", scope: "all", pattern: /\/private\/var\//, sample: ["const tmp = \"", "private", "var", "folders\""].join("/") },
  { name: ".tsx import in built output", scope: "dist", pattern: /from\s*["'][^"']+\.tsx["']/, sample: 'import View from "./view.tsx"' },
  { name: "relative import in built output", scope: "dist", pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']\.{1,2}\//, sample: 'import { Status } from "./rpc.js"' },
  { name: "node: import in the TUI entry", scope: "tui", pattern: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)["']node:/, sample: 'import { readFileSync } from "node:fs"' },
]

// Lines that must not trip any rule: the public replacements and near misses.
const CLEAN_SAMPLE = [
  'import { Plugin } from "@opencode/plugin"',
  'import { Rpc } from "@opencode/plugin/rpc"',
  "await ctx.experimental.generate.text(input)",
  "const policies = config.policies",
  'import View from "./view.js"',
  'const note = "@opencode/ai is the host\'s own package"',
].join("\n")

function inScope(rule, file) {
  if (rule.scope === "all") return true
  if (rule.scope === "dist") return file.startsWith("dist/")
  return file === "dist/tui.js"
}

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path)
    return [path]
  })
}

function sourceFiles(root) {
  let listed
  try {
    // Tracked files plus new, unignored files, so a check before `git add` still sees them.
    listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCANNED], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\0")
      .filter(Boolean)
  } catch {
    listed = SCANNED.flatMap((dir) => walk(join(root, dir)).map((path) => relative(root, path).split(sep).join("/")))
  }
  return [...new Set(listed)].filter((file) => file !== SELF && existsSync(join(root, file)))
}

function distFiles(root) {
  return walk(join(root, "dist"))
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((file) => file.endsWith(".js"))
}

function scan(root) {
  const hits = []
  for (const file of [...sourceFiles(root), ...distFiles(root)]) {
    const lines = readFileSync(join(root, file), "utf8").split("\n")
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (inScope(rule, file) && rule.pattern.test(line)) hits.push({ file, line: index + 1, rule: rule.name, text: line.trim().slice(0, 160) })
      }
    })
  }
  return hits
}

function write(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), `${text}\n`)
}

function selfTest() {
  const base = mkdtempSync(join(tmpdir(), "check-forbidden-"))
  try {
    const bad = join(base, "bad")
    const clean = join(base, "clean")
    RULES.forEach((rule, index) => {
      const file = rule.scope === "tui" ? "dist/tui.js" : rule.scope === "dist" ? `dist/bad-${index}.js` : `src/bad-${index}.ts`
      write(bad, file, rule.sample)
    })
    write(clean, "src/index.ts", CLEAN_SAMPLE)
    write(clean, "test/unit/clean.test.ts", CLEAN_SAMPLE)
    write(clean, "scripts/clean.mjs", CLEAN_SAMPLE)
    // Built output may not import relatively at all, so its clean sample leaves that line out.
    write(clean, "dist/tui.js", CLEAN_SAMPLE.split("\n").filter((line) => !line.includes('"./')).join("\n"))
    // Out of scope: node: in a dist file other than the TUI entry.
    write(clean, "dist/index.js", 'import { readFileSync } from "node:fs"')

    const failures = []
    const badHits = scan(bad)
    RULES.forEach((rule, index) => {
      if (!badHits.some((hit) => hit.rule === rule.name && hit.text === rule.sample.trim().slice(0, 160))) failures.push(`rule ${index} (${rule.name}) did not fire on its bad sample`)
    })
    const cleanHits = scan(clean)
    for (const hit of cleanHits) failures.push(`clean fixture tripped ${hit.rule} at ${hit.file}:${hit.line}`)

    if (failures.length > 0) {
      for (const failure of failures) console.error(`check-forbidden self-test: ${failure}`)
      return 1
    }
    console.log("check-forbidden self-test: OK (every rule fires on the bad fixture; the clean fixture passes)")
    return 0
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest()
  const root = fileURLToPath(new URL("../", import.meta.url))
  const hits = scan(root)
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.rule}: ${hit.text}`)
  if (hits.length > 0) {
    console.error(`check-forbidden: ${hits.length} forbidden use(s). Use the public OpenCode 2.2.3 API instead, and keep machine-local paths out of the repo.`)
    return 1
  }
  console.log("check-forbidden: OK")
  return 0
}

process.exitCode = main()
