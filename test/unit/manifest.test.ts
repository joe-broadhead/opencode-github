import assert from "node:assert/strict"
import { test } from "node:test"
import { checkManifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { manifest, packageName, version } from "../../src/manifest.ts"

const methods = Object.entries(manifest.methods)

test("the package is the github plugin at 0.0.0", () => {
  assert.equal(packageName, "@we-the-rebel-alliance/github-plugin")
  assert.equal(version, "0.0.0")
  assert.equal(manifest.plugin.name, "github")
  assert.equal(manifest.plugin.title, "GitHub")
  assert.equal(manifest.plugin.vendor.id, "github")
})

test("the manifest is the contract's, and the namespace line fits its budget", () => {
  const checked = checkManifest(manifest)
  assert.equal(checked.ok, true, checked.ok ? "" : checked.problems.join("; "))
  assert.ok(manifest.plugin.summary.length <= 400)
  assert.equal(manifest.plugin.host.opencode, ">=2.4.1 <2.5.0")
  assert.deepEqual(manifest.plugin.host.tested, ["2.4.1"])
})

test("every callable is declared once: 102 methods, the inventory's classes", () => {
  assert.equal(methods.length, 102)
  const classes = methods.reduce<Record<string, number>>((counts, [, item]) => {
    counts[item.class] = (counts[item.class] ?? 0) + 1
    return counts
  }, {})
  assert.deepEqual(classes, { read: 64, write: 28, send: 5, delete: 2, admin: 3 })
  assert.equal(methods.filter(([name]) => name.startsWith("mcp:")).length, 98)
  assert.equal(new Set(methods.map(([name]) => name)).size, methods.length)
})

test("the methods that take an account say so, and only status takes none", () => {
  for (const [name, item] of methods) {
    if (name === "status") assert.equal(item.accounts, "none", name)
    else assert.equal(item.accounts, "optional", name)
  }
  assert.equal(manifest.methods["probe"]?.class, "read")
  assert.deepEqual(manifest.methods["probe"]?.operations, ["users.get"])
  assert.deepEqual(manifest.methods["events_list"]?.operations, ["search.issues", "search.commits", "notifications.list"])
  assert.equal(manifest.methods["api"]?.class, "admin")
  assert.deepEqual(manifest.methods["api"]?.operations, ["rest.read", "rest.write", "graphql.query", "graphql.mutation", "download", "upload"])
})

test("a pass-through tool's operation is its own name, and the dangerous names carry their class", () => {
  for (const [name, item] of methods) {
    if (!name.startsWith("mcp:")) continue
    assert.deepEqual(item.operations, [name.slice(4)], name)
  }
  assert.equal(manifest.methods["mcp:delete_file"]?.class, "delete")
  assert.equal(manifest.methods["mcp:delete_repository"]?.class, "delete")
  assert.equal(manifest.methods["mcp:add_issue_comment"]?.class, "send")
  assert.equal(manifest.methods["mcp:update_issue_comment"]?.class, "send")
  assert.equal(manifest.methods["mcp:create_repository_ruleset"]?.class, "admin")
  assert.equal(manifest.methods["mcp:custom_properties_write"]?.class, "admin")
})

test("the activity source is declared once, with its service, operations and limits", () => {
  assert.equal(manifest.sources.length, 1)
  const source = manifest.sources[0]!
  assert.equal(source.id, "github.activity")
  assert.equal(source.kind, "events")
  assert.equal(source.method, "events_list")
  assert.deepEqual(source.input, { source: "github" })
  assert.equal(source.service?.id, "github.activity")
  assert.equal(source.private, true)
  assert.equal(source.cost?.class, "free")
  assert.ok((source.maxBytes ?? 0) > 0 && (source.maxBytes ?? 0) <= 1_048_576)
  const operations = manifest.methods["events_list"]?.operations ?? []
  for (const operation of source.operations ?? []) assert.ok(operations.includes(operation), operation)
})

test("the manifest declares the three bus events and no actions", () => {
  assert.deepEqual(Object.keys(manifest.events).sort(), ["account", "changed", "status"])
  assert.deepEqual(manifest.actions, [])
})

test("the options carry access, accounts and the plugin's own settings, each with a default where it has one", () => {
  const options = manifest.options as { properties: Record<string, Record<string, unknown>> }
  assert.deepEqual(options.properties["access"]?.enum, ["all", "ask-changes", "read-only"])
  assert.equal(options.properties["access"]?.default, "all")
  assert.equal((options.properties["allowUntestedHost"] as { default?: unknown } | undefined)?.default, false)
  assert.ok(options.properties["accounts"] !== undefined)
  const profile = (options.properties["accounts"] as { additionalProperties?: { properties?: Record<string, unknown> } }).additionalProperties
  assert.ok(profile?.properties?.["host"] !== undefined)
  assert.deepEqual(manifest.accounts?.via, "mcp")
})
