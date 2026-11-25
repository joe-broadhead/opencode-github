import assert from "node:assert/strict"
import { test } from "node:test"
import { effectFor, rulesFor } from "@we-the-rebel-alliance/plugin-contract/access"
import { manifest } from "../../src/manifest.ts"

const api = manifest.methods["api"]!
const mcpRead = manifest.methods["mcp:get_me"]!

test("api asks on every call at all and ask-changes, and is off at read-only", () => {
  assert.equal(api.class, "admin")
  assert.equal(api.effect, "ask")
  assert.equal(effectFor(api, "all"), "ask")
  assert.equal(effectFor(api, "ask-changes"), "ask")
  assert.equal(effectFor(api, "read-only"), "deny")
})

test("the generated rules carry the api ask at every level where it runs", () => {
  for (const level of ["all", "ask-changes"] as const) {
    const rule = rulesFor(manifest, level, ["default"]).find((held) => held.action === "github.api" && held.resource === "*")
    assert.equal(rule?.effect, "ask", level)
  }
  const readOnly = rulesFor(manifest, "read-only", ["default"]).find((held) => held.action === "github.api" && held.resource === "*")
  assert.equal(readOnly?.effect, "deny")
})

test("a declared pass-through MCP read still runs at read-only", () => {
  assert.equal(mcpRead.class, "read")
  assert.equal(effectFor(mcpRead, "read-only"), "allow")
  const rule = rulesFor(manifest, "read-only", ["default"]).find((held) => held.action === "github_get_me" && held.resource === "*")
  assert.equal(rule?.effect, "allow")
})
