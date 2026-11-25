import assert from "node:assert/strict"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin"
import { SourceError } from "@we-the-rebel-alliance/plugin-contract/events"
import { loadOptions, registerGithubAccounts } from "../../src/accounts.ts"
import { manifest } from "../../src/manifest.ts"
import { WORK_ACCESS } from "../support/github-fake.ts"

interface FakeIntegration {
  id: string
  name: string
  methods: { id: string; type: string }[]
}

/** A context with the two transforms, an integration per server, and one connection per integration. */
function fakeContext() {
  const integrations = new Map<string, FakeIntegration>()
  const servers = new Map<string, { name: string; integrationID: string; config: Record<string, unknown> }>()
  const connections = new Map<string, unknown>()
  const resolved = new Map<string, unknown>()
  const statuses = new Map<string, unknown>()

  const editor = {
    get(id: string) {
      const found = integrations.get(id)
      return found === undefined ? undefined : { id: found.id, name: found.name }
    },
    update(id: string, update: (integration: FakeIntegration) => void) {
      const held = integrations.get(id) ?? { id, name: id, methods: [] }
      update(held)
      integrations.set(id, held)
    },
  }
  const integrationEditor = {
    ...editor,
    method: {
      list(id: string) {
        return integrations.get(id)?.methods ?? []
      },
      update(input: { integrationID: string; method: { id: string; type: string } }) {
        const held = integrations.get(input.integrationID)
        if (held === undefined) throw new Error(`no integration ${input.integrationID}`)
        held.methods = held.methods.filter((method) => method.id !== input.method.id)
        held.methods.push({ id: input.method.id, type: input.method.type })
      },
      remove(id: string, method: { id: string }) {
        const held = integrations.get(id)
        if (held !== undefined) held.methods = held.methods.filter((item) => item.id !== method.id)
      },
    },
  }
  const mcpEditor = {
    set(name: string, config: Record<string, unknown>) {
      servers.set(name, { name, integrationID: name, config })
      if (!integrations.has(name)) integrations.set(name, { id: name, name, methods: [{ id: "host-oauth", type: "oauth" }] })
    },
  }
  const context = {
    options: {},
    mcp: {
      transform: async (callback: (editor: typeof mcpEditor) => void) => {
        callback(mcpEditor)
        return { dispose: async () => undefined }
      },
      list: async () => ({ data: [...servers.values()] }),
    },
    integration: {
      transform: async (callback: (editor: typeof integrationEditor) => void) => {
        callback(integrationEditor)
        return { dispose: async () => undefined }
      },
      get: async ({ integrationID }: { integrationID: string }) => ({ data: integrations.get(integrationID) }),
      connection: {
        active: async (id: string) => {
          const held = connections.get(id)
          return held !== undefined && statuses.has(id) ? { ...(held as object), status: statuses.get(id) } : held
        },
        resolve: async (connection: { id: string }) => resolved.get(connection.id),
        status: async ({ integrationID, status }: { integrationID: string; status: unknown }) => {
          if (status === undefined) statuses.delete(integrationID)
          else statuses.set(integrationID, status)
        },
      },
    },
    event: {
      subscribe: () =>
        ({
          async *[Symbol.asyncIterator]() {
            // No event arrives in a test.
          },
        }) as AsyncIterable<never>,
    },
  }
  return { context: context as unknown as Plugin.Context, integrations, servers, connections, resolved, statuses }
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test("two aliases get one MCP server each, with an integration of their own", async () => {
  const fake = fakeContext()
  const wiring = await registerGithubAccounts(fake.context, { manifest, options: loadOptions({ accounts: { work: {}, personal: {} } }) })
  try {
    assert.deepEqual([...fake.servers.keys()], ["github-work", "github-personal"])
    const config = fake.servers.get("github-work")?.config as { type: string; url: string; headers: Record<string, string> }
    assert.equal(config.type, "remote")
    assert.match(config.url, /^https:\/\//)
    assert.match(config.headers["X-MCP-Toolsets"] ?? "", /repos/)
    assert.equal(config.headers["X-MCP-Readonly"], "false")
    assert.deepEqual(wiring.problems(), [])
    await wait()
    for (const name of ["github-work", "github-personal"]) {
      const methods = fake.integrations.get(name)?.methods.map((method) => method.id).sort()
      assert.deepEqual(methods, ["github-token"], name)
    }
  } finally {
    await wiring.dispose()
  }
})

test("an alias's credential is resolved from its server integration", async () => {
  const fake = fakeContext()
  fake.connections.set("github-work", { id: "github-work", label: "ana-work" })
  fake.resolved.set("github-work", { type: "oauth", access: "fixture-work-access", metadata: { login: "ana-work" } })
  const wiring = await registerGithubAccounts(fake.context, { manifest, options: loadOptions({ accounts: { work: {}, personal: {} } }) })
  try {
    const credential = await wiring.read("work")
    assert.equal(credential.login, "ana-work")
    assert.equal(credential.token, WORK_ACCESS)
    assert.deepEqual(await wiring.state("work"), { state: "ready", owner: { id: "github:ana-work", label: "ana-work" } })
    const state = await wiring.state("personal")
    assert.equal(state.state, "needs_sign_in")
    await assert.rejects(() => wiring.read("personal"), (error: unknown) => error instanceof SourceError && error.code === "NEEDS_SIGN_IN")
  } finally {
    await wiring.dispose()
  }
})

test("the default account is the server github, and the rules option reaches the server header", async () => {
  const fake = fakeContext()
  const wiring = await registerGithubAccounts(fake.context, { manifest, options: loadOptions({ access: "read-only", lockdown: true }) })
  try {
    assert.deepEqual([...fake.servers.keys()], ["github"])
    assert.deepEqual(wiring.accounts.map((account) => account.alias), ["default"])
    const config = fake.servers.get("github")?.config as { headers: Record<string, string> }
    assert.equal(config.headers["X-MCP-Readonly"], "true")
    assert.equal(config.headers["X-MCP-Lockdown"], "true")
  } finally {
    await wiring.dispose()
  }
})

test("an Enterprise alias gets an integration of its own, with the same sign-in, and no MCP server", async () => {
  const fake = fakeContext()
  fake.connections.set("github-enterprise", { id: "github-enterprise", label: "ana-work" })
  fake.resolved.set("github-enterprise", { type: "oauth", access: "fixture-work-access", metadata: { login: "ana-work" } })
  const wiring = await registerGithubAccounts(fake.context, { manifest, options: loadOptions({ accounts: { work: {}, enterprise: { host: "github.example.com" } } }) })
  try {
    assert.deepEqual([...fake.servers.keys()], ["github-work"])
    const enterpriseCredential = await wiring.read("enterprise")
    assert.equal(enterpriseCredential.login, "ana-work")
    assert.equal(enterpriseCredential.token, WORK_ACCESS)
    assert.equal(enterpriseCredential.host, "github.example.com")
    await wait()
    assert.ok(fake.integrations.has("github-enterprise"))
    assert.deepEqual(await wiring.state("enterprise"), { state: "ready", owner: { id: "github:ana-work@github.example.com", label: "ana-work (github.example.com)" } })
    await wait()
    const methods = fake.integrations.get("github-enterprise")?.methods.map((method) => method.id).sort()
    assert.deepEqual(methods, ["github-token"])
  } finally {
    await wiring.dispose()
  }
})

test("a connection the host reports as needing sign-in is NEEDS_SIGN_IN, and a call that succeeds clears it", async () => {
  const fake = fakeContext()
  fake.connections.set("github-work", { id: "github-work", label: "ana-work" })
  fake.resolved.set("github-work", { type: "oauth", access: WORK_ACCESS, metadata: { login: "ana-work" } })
  const wiring = await registerGithubAccounts(fake.context, { manifest, options: loadOptions({ accounts: { work: {} } }) })
  try {
    await wiring.mark("work", "GitHub rejected the saved sign-in")
    await assert.rejects(() => wiring.read("work"), (error: unknown) => error instanceof SourceError && error.code === "NEEDS_SIGN_IN")
    const state = await wiring.state("work")
    assert.equal(state.state, "needs_sign_in")
    await wiring.clear("work")
    assert.equal((await wiring.read("work")).login, "ana-work")
  } finally {
    await wiring.dispose()
  }
})

test("a connection whose credential is not OAuth is NEEDS_SIGN_IN", async () => {
  const fake = fakeContext()
  fake.connections.set("github-work", { id: "github-work", label: "ana-work" })
  fake.resolved.set("github-work", { type: "key", access: "a key" })
  const wiring = await registerGithubAccounts(fake.context, { manifest, options: loadOptions({ accounts: { work: {} } }) })
  try {
    await assert.rejects(() => wiring.read("work"), (error: unknown) => error instanceof SourceError && error.code === "NEEDS_SIGN_IN")
  } finally {
    await wiring.dispose()
  }
})
