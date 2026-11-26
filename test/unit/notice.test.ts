// The release tarball ships NOTICE next to a bundle that inlines third-party code. This test builds the server entry
// with the same externals as scripts/bundle.mjs, collects every package that actually ends up in the bundle
// (including packages inlined by a bundled dist, such as zod inside plugin-contract), and requires a NOTICE section
// for each: its heading and the package's LICENSE text verbatim.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../../", import.meta.url))
/** The plugin itself is not a third-party package. */
const PLUGIN = "@we-the-rebel-alliance/github-plugin"

interface Bundled {
  readonly version: string
  readonly license: string
  readonly text: string
}

/** A package name from an esbuild input path, or undefined for the plugin's own sources. */
function packageOf(path: string): string | undefined {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)
  return match?.[1]
}

function keep(name: string | undefined): name is string {
  return name !== undefined && name !== PLUGIN && !name.startsWith("@opencode/")
}

/** Every third-party package esbuild actually inlines into the server bundle. */
async function bundledPackages(): Promise<Map<string, Bundled>> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["@opencode/*"],
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  })
  const names = new Set<string>()
  const inputs = Object.keys(result.metafile.inputs)
  for (const path of inputs) {
    const name = packageOf(path)
    if (keep(name)) names.add(name)
  }
  // A bundled dist can inline its own dependencies; its chunks keep the original module path in a comment.
  for (const path of inputs) {
    if (!path.startsWith("node_modules/")) continue
    const text = readFileSync(join(root, path), "utf8")
    for (const match of text.matchAll(/\/\/\s*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g)) if (keep(match[1])) names.add(match[1]!)
  }
  // plugin-contract's dist carries zod pre-bundled, so zod has no input of its own and a name or comment scan can
  // miss it. Its code in the built bundle is the proof that it is inlined and must be noticed.
  const bundle = result.outputFiles?.[0]?.text ?? ""
  if (/\$ZodType|ZodError/.test(bundle)) names.add("zod")
  const packages = new Map<string, Bundled>()
  for (const name of [...names].sort()) {
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as { version?: string; license?: string }
    packages.set(name, {
      version: pkg.version ?? "",
      license: pkg.license ?? "",
      text: readFileSync(join(root, "node_modules", name, "LICENSE"), "utf8"),
    })
  }
  return packages
}

/** What a NOTICE lacks: a heading for a package, or its verbatim licence text. */
function problems(notice: string, packages: ReadonlyMap<string, Bundled>): string[] {
  const missing: string[] = []
  for (const [name, pkg] of packages) {
    const heading = `## ${name} ${pkg.version} (${pkg.license})`
    if (!notice.includes(heading)) missing.push(`${name}: no "${heading}" heading`)
    else if (!notice.includes(pkg.text)) missing.push(`${name}: licence text is not verbatim`)
  }
  return missing
}

test("every package the bundle inlines has its verbatim licence in NOTICE", async () => {
  const packages = await bundledPackages()
  assert.ok(packages.size > 0, "the bundle inlines no third-party package")
  assert.ok(packages.has("yaml"), "the YAML parser is bundled")
  assert.ok(packages.has("@we-the-rebel-alliance/plugin-contract"), "plugin-contract is bundled")
  assert.ok(packages.has("zod"), "zod's code is inlined inside plugin-contract's dist")
  assert.deepEqual(problems(readFileSync(join(root, "NOTICE"), "utf8"), packages), [])
})

test("a missing section is reported", async () => {
  const packages = await bundledPackages()
  const notice = readFileSync(join(root, "NOTICE"), "utf8")
  const without = notice.replace(/^## yaml [\s\S]*?(?=^## )/m, "")
  assert.ok(problems(without, packages).some((item) => item.startsWith("yaml:")))
})
