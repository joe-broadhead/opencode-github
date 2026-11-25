import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_TOOLSETS, TOOLSETS, accountServerName, hostOf, loadOptions } from "../../src/accounts.ts"

test("the defaults are the narrow set the manifest states", () => {
  const options = loadOptions(undefined)
  assert.equal(options.access, "all")
  assert.deepEqual(options.accounts, {})
  assert.equal(options.allowUntestedHost, false)
  assert.equal(options.lockdown, false)
  assert.deepEqual(options.toolsets, DEFAULT_TOOLSETS)
  assert.deepEqual(options.scopes, ["repo", "read:org"])
  assert.equal(options.clientId, undefined)
  assert.equal(options.appSlug, undefined)
})

test("an option the person sets wins over its default", () => {
  const options = loadOptions({
    access: "ask-changes",
    accounts: { work: {}, enterprise: { host: "github.example.com" } },
    allowUntestedHost: true,
    lockdown: true,
    toolsets: ["context", "repos"],
    clientId: "Iv1.0123456789abcdef",
    appSlug: "our-github-app",
    scopes: ["repo"],
  })
  assert.equal(options.access, "ask-changes")
  assert.deepEqual(options.accounts, { work: {}, enterprise: { host: "github.example.com" } })
  assert.equal(options.allowUntestedHost, true)
  assert.equal(options.lockdown, true)
  assert.deepEqual(options.toolsets, ["context", "repos"])
  assert.equal(options.clientId, "Iv1.0123456789abcdef")
  assert.equal(options.appSlug, "our-github-app")
  assert.deepEqual(options.scopes, ["repo"])
})

test("a repeated toolset or scope is kept once, in its order", () => {
  const options = loadOptions({ toolsets: ["repos", "issues", "repos"], scopes: ["repo", "repo", "read:org"] })
  assert.deepEqual(options.toolsets, ["repos", "issues"])
  assert.deepEqual(options.scopes, ["repo", "read:org"])
})

test("an unknown option is OPTIONS_INVALID, never ignored", () => {
  assert.throws(() => loadOptions({ unknown: true }), /OPTIONS_INVALID: "unknown" is not an option/)
})

test("a wrong access level, toolset or profile is OPTIONS_INVALID", () => {
  assert.throws(() => loadOptions({ access: "everything" }), /access must be one of/)
  assert.throws(() => loadOptions({ toolsets: [] }), /toolsets must be a non-empty list/)
  assert.throws(() => loadOptions({ toolsets: ["not-a-toolset"] }), /is not a GitHub toolset/)
  assert.throws(() => loadOptions({ scopes: ["Repo"] }), /each scope must be a GitHub OAuth scope/)
  assert.throws(() => loadOptions({ accounts: { work: { region: "eu" } } }), /accounts.work.region is not a profile field/)
  assert.throws(() => loadOptions({ accounts: { work: { host: 3 } } }), /accounts.work.host must be a host name/)
})

test("github.com is the default host, and ghe.com is not supported yet", () => {
  assert.throws(() => loadOptions({ accounts: { work: { host: "github.com" } } }), /github.com by default/)
  assert.throws(() => loadOptions({ accounts: { work: { host: "acme.ghe.com" } } }), /GHE.com data residency/)
})

test("an alias's server name is the contract's derivation", () => {
  assert.equal(accountServerName("default"), "github")
  assert.equal(accountServerName("work"), "github-work")
  const options = loadOptions({ accounts: { work: {}, enterprise: { host: "github.example.com" } } })
  assert.equal(hostOf(options, "work"), undefined)
  assert.equal(hostOf(options, "enterprise"), "github.example.com")
  assert.equal(hostOf(options, "missing"), undefined)
})

test("the manifest's toolset list is the one the option accepts", () => {
  for (const toolset of TOOLSETS) assert.doesNotThrow(() => loadOptions({ toolsets: [toolset] }))
})
