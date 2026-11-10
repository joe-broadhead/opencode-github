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

// The one permission hook: the tools RPC's evaluate hook. A script cannot answer an approval prompt, so it turns an
// ask on one of the RPC's own script calls in flight into a deny; it only tightens and touches no other call. It is
// allowed only in the module and in the bundle that inlines it, exactly once in each.
const HOOK_FILES = ["src/host/tools-rpc.ts", "dist/index.js"]
const HOOK = /permission\.hook/

// scope "all": src/, test/, scripts/ and dist/. "dist": built JavaScript only. "tui": dist/tui.js only.
// `allow` lists the files a rule does not apply to.
const RULES = [
  { name: "V1 plugin package", scope: "all", pattern: /@opencode-ai\//, sample: 'import { tool } from "@opencode-ai/plugin"' },
  { name: "ctx.generate (deprecated)", scope: "all", pattern: /ctx\.generate\./, sample: "await ctx.generate.text(input)" },
  { name: "experimental.policies (deprecated)", scope: "all", pattern: /experimental\.policies/, sample: "config.experimental.policies" },
  { name: "ctx.experimental.artifact (experimental, new in 2.2.4)", scope: "all", pattern: /experimental\.artifact\b/, sample: "await ctx.experimental.artifact.create(input)" },
  { name: "@opencode/ai import (breaks between patches)", scope: "all", pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']@opencode\/ai(?:\/[^"']*)?["']/, sample: 'import { Provider } from "@opencode/ai/provider"' },
  { name: "private OpenCode source import", scope: "all", pattern: /packages\/(core|plugin|schema|sdk|server|tui)\/src/, sample: ["import x from \"../opencode/packages", "core", "src/index.ts\""].join("/") },
  { name: "machine-local path", scope: "all", pattern: /\/Users\//, sample: ["const home = \"", "Users", "someone\""].join("/") },
  { name: "machine-local path", scope: "all", pattern: /\/private\/var\//, sample: ["const tmp = \"", "private", "var", "folders\""].join("/") },
  { name: "permission hook outside the tools RPC", scope: "all", pattern: HOOK, allow: HOOK_FILES, sample: 'await ctx.permission.hook("evaluate", allowEverything)' },
  // Shipped text states behaviour, never who decided it or which internal lane changed it.
  {
    name: "internal process wording",
    scope: "all",
    pattern: /\bowner(?:'s)? (?:decision|ruling)\b|\bthe lead\b|\blane\s+[A-Z]\d*\b|\bhey-jelly\s*#\d+|\bG[1-4] lane\b|\breconcile lane\b/i,
    sample: "The owner's decision was to allow it",
  },
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
  if (rule.allow?.includes(file)) return false
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
    if (HOOK_FILES.includes(file)) {
      const count = lines.filter((line) => HOOK.test(line)).length
      if (count !== 1) hits.push({ file, line: 0, rule: "exactly one permission hook, the tools RPC's evaluate hook", text: `found ${count}` })
    }
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
    // Out of scope: node: in a dist file other than the TUI entry. The tools RPC's one hook, in the module and the bundle.
    const hook = 'const hook = await ctx.permission.hook("evaluate", (evaluation) => {'
    write(clean, "dist/index.js", ['import { readFileSync } from "node:fs"', hook].join("\n"))
    write(clean, "src/host/tools-rpc.ts", hook)
    // A second hook in the module fails the count.
    write(bad, "src/host/tools-rpc.ts", [hook, hook].join("\n"))

    const failures = []
    const badHits = scan(bad)
    RULES.forEach((rule, index) => {
      if (!badHits.some((hit) => hit.rule === rule.name && hit.text === rule.sample.trim().slice(0, 160))) failures.push(`rule ${index} (${rule.name}) did not fire on its bad sample`)
    })
    if (!badHits.some((hit) => hit.file === "src/host/tools-rpc.ts" && hit.text === "found 2")) failures.push("a second permission hook in src/host/tools-rpc.ts was not caught")
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

// The family's working folders and the owner's private names never reach a public file. This reads every git-tracked
// file, so a note in a doc, a skill or a fixture is caught as well as code. AGENTS.md and this script name them on
// purpose and are skipped. Case does not matter.
{
  const { realpathSync, existsSync, readFileSync } = await import("node:fs")
  const { execFileSync } = await import("node:child_process")
  const { join, dirname } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const WORDS = /opencode-release\/|prosus|toqan/i
  const self = realpathSync(fileURLToPath(import.meta.url))
  if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
    const repo = join(dirname(self), "..")
    let listed = []
    try {
      listed = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean)
    } catch {
      // Not a git checkout, such as a packed tarball: the scan above covers the shipped files.
    }
    const hits = []
    for (const path of listed) {
      if (path === "AGENTS.md" || path === "scripts/check-forbidden.mjs") continue
      const file = join(repo, path)
      if (!existsSync(file)) continue
      const buffer = readFileSync(file)
      if (buffer.includes(0)) continue
      buffer.toString("utf8").split(/\r?\n/).forEach((text, index) => {
        if (WORDS.test(text)) hits.push(`${path}:${index + 1}`)
      })
    }
    if (hits.length) {
      console.error(`forbidden-words: the family's working folders and the owner's private names must not appear in a public file:\n  ${hits.join("\n  ")}`)
      process.exitCode = 1
    }
  }
}
