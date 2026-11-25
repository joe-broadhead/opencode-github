import assert from "node:assert/strict"
import { test } from "node:test"
import { SourceError } from "@we-the-rebel-alliance/plugin-contract/events"
import { accountStatuses } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { unguardedOf } from "../../src/handlers/shared.ts"
import { createProvider } from "../../src/provider/client.ts"
import { createFakeGitHub } from "../support/github-fake.ts"
import { fakeAccounts, run, runtimeFor, type Sent } from "../support/runtime.ts"

const since = "2026-11-01T00:00:00.000Z"

test("status reports the plugin, the host, both aliases and a ready state", async () => {
  const runtime = runtimeFor()
  const sent: Sent[] = []
  const answer = (await run(runtime, "status", {}, "work", sent)) as Record<string, unknown>
  assert.equal(answer["name"], "github")
  assert.equal(answer["version"], "0.0.0")
  assert.deepEqual(answer["host"], { version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
  assert.equal(answer["state"], "ready")
  assert.deepEqual(answer["unguardedAgents"], [])
  assert.equal(answer["nextStep"], null)
  const accounts = answer["accounts"] as { alias: string; state: string; owner?: { id: string } }[]
  assert.deepEqual(accounts.map((account) => account.alias), ["work", "personal"])
  assert.ok(accounts.every((account) => account.state === "ready"))
  assert.deepEqual(sent.map((item) => item.event), ["account", "account", "status"])
  // The second read changes nothing, so it nudges nothing.
  await run(runtime, "status", {}, "work", sent)
  assert.equal(sent.length, 3)
})

test("status names an alias that needs sign-in, and a missing agent list is unknown, never zero", async () => {
  const runtime = runtimeFor({ missing: ["personal"] })
  const answer = (await run(runtime, "status", {}, "work")) as Record<string, unknown>
  assert.equal(answer["state"], "needs_sign_in")
  assert.match(String(answer["nextStep"]), /Sign in/)
  const accounts = answer["accounts"] as { alias: string; state: string; reason?: string }[]
  assert.equal(accounts[1]?.state, "needs_sign_in")
  assert.ok(accounts[1]?.reason !== undefined)
})

test("an alias in error makes the whole status an error, with its redacted reason", async () => {
  const base = fakeAccounts()
  const runtime = runtimeFor({ overrides: { accounts: { ...base, state: async () => ({ state: "error", reason: "the connection failed" }) } } })
  const answer = (await run(runtime, "status", {})) as Record<string, unknown>
  assert.equal(answer["state"], "error")
  assert.match(String(answer["nextStep"]), /connection failed/)
})

test("an unreadable agent list is a problem, never zero agents", async () => {
  const failing = { unguardedAgents: async () => { throw new Error("the agent list could not be read") } } as unknown as Parameters<typeof unguardedOf>[0]
  const read = await unguardedOf(failing)
  assert.deepEqual(read.agents, [])
  assert.match(read.problem ?? "", /the agent list could not be read/)
})

test("probe reads the signed-in owner and emits the account nudge only on a change", async () => {
  const runtime = runtimeFor()
  const sent: Sent[] = []
  const answer = await run(runtime, "probe", { source: "github" }, "work", sent)
  assert.deepEqual(answer, { source: "github", account: "work", owner: { id: "github:ana-work", label: "ana-work" }, trust: "untrusted" })
  assert.deepEqual(sent, [])

  const missing = runtimeFor({ missing: ["work"] })
  const nudged: Sent[] = []
  await assert.rejects(() => run(missing, "probe", {}, "work", nudged), (error: unknown) => error instanceof SourceError && error.code === "NEEDS_SIGN_IN")
  assert.deepEqual(nudged, [{ event: "account", data: { account: "work", state: "needs_sign_in" } }])
})

test("events_list answers a page for the alias, and refuses an unknown source", async () => {
  const runtime = runtimeFor()
  const page = (await run(runtime, "events_list", { since }, "work")) as Record<string, unknown>
  assert.equal(page["account"], "work")
  assert.equal(page["source"], "github")
  assert.equal((page["events"] as unknown[]).length, 4)
  assert.equal(page["trust"], "untrusted")
  await assert.rejects(
    () => run(runtime, "events_list", { source: "other" }),
    (error: unknown) => error instanceof SourceError && error.code === "SOURCE_UNKNOWN",
  )
})

test("events_list refuses another alias's cursor", async () => {
  const runtime = runtimeFor()
  const page = (await run(runtime, "events_list", { since }, "work")) as { cursor: string }
  await assert.rejects(
    () => run(runtime, "events_list", { cursor: page.cursor }, "personal"),
    (error: unknown) => error instanceof SourceError && error.code === "CURSOR_INVALID",
  )
})

test("a probe GitHub rejects marks the alias, and a working one clears it", async () => {
  const fake = createFakeGitHub()
  const marked: string[] = []
  const cleared: string[] = []
  const accounts = { ...fakeAccounts(), mark: async (alias: string) => { marked.push(alias) }, clear: async (alias: string) => { cleared.push(alias) } }
  const runtime = runtimeFor({ overrides: { provider: createProvider({ deviceSignIn: true, fetch: fake.fetch }), accounts } })
  fake.revoke("ana-work")
  await assert.rejects(() => run(runtime, "probe", {}, "work"), (error: unknown) => error instanceof SourceError && error.code === "NEEDS_SIGN_IN")
  assert.deepEqual(marked, ["work"])
  const answer = await run(runtime, "probe", {}, "personal")
  assert.equal((answer as { owner: { id: string } }).owner.id, "github:ana-personal")
  assert.deepEqual(cleared, ["personal"])
})

test("an api call GitHub answers 401 marks the alias, and a working call clears it", async () => {
  const fake = createFakeGitHub()
  const marked: string[] = []
  const cleared: string[] = []
  const accounts = { ...fakeAccounts(), mark: async (alias: string) => { marked.push(alias) }, clear: async (alias: string) => { cleared.push(alias) } }
  const runtime = runtimeFor({ overrides: { provider: createProvider({ deviceSignIn: true, fetch: fake.fetch }), accounts } })
  fake.revoke("ana-work")
  const rejectedSent: Sent[] = []
  const rejected = await run(runtime, "api", { method: "GET", path: "/repos/example/work" }, "work", rejectedSent)
  assert.equal((rejected as { status: number }).status, 401)
  assert.deepEqual(rejectedSent, [])
  assert.deepEqual(marked, ["work"])
  await run(runtime, "api", { method: "GET", path: "/repos/example/work" }, "personal")
  assert.deepEqual(cleared, ["personal"])
})

test("api reads emit nothing and writes emit one changed nudge", async () => {
  const runtime = runtimeFor()
  const readSent: Sent[] = []
  const read = await run(runtime, "api", { method: "GET", path: "/repos/example/work" }, "work", readSent)
  assert.equal((read as { ok: boolean }).ok, true)
  assert.deepEqual(readSent, [])

  const writeSent: Sent[] = []
  const write = await run(runtime, "api", { method: "POST", path: "/repos/example/work/issues", body: { title: "A test issue" } }, "work", writeSent)
  assert.equal((write as { status: number }).status, 201)
  assert.deepEqual(writeSent, [{ event: "changed", data: { capability: "github.activity", account: "work", reason: "write" } }])
})

test("api refuses a broken form before any request", async () => {
  const runtime = runtimeFor()
  for (const input of [
    {},
    { method: "GET", path: "/x", graphql: { query: "query { viewer { login } }" } },
    { method: "POST", path: "/x", download: { path: "f" } },
    { method: "GET", path: "/x", upload: { path: "f", contentType: "application/zip" } },
    { method: "POST", path: "/x", upload: { path: "f", contentType: "application/zip" }, body: {} },
    { method: "POST", path: "/x", paginate: true },
    { method: "POST", path: "/x", download: { path: "f" }, upload: { path: "f", contentType: "application/zip" } },
    { method: "FETCH", path: "/x" },
  ]) {
    await assert.rejects(
      () => run(runtime, "api", input),
      (error: unknown) => error instanceof SourceError && error.code === "INPUT_INVALID",
      JSON.stringify(input),
    )
  }
})

test("the status answer's aliases are the accountStatuses the manifest declares", async () => {
  const runtime = runtimeFor()
  const answer = (await run(runtime, "status", {})) as { accounts: unknown }
  assert.deepEqual(answer.accounts, accountStatuses(runtime.accounts.accounts, {
    work: { state: "ready", owner: { id: "github:ana-work", label: "ana-work" } },
    personal: { state: "ready", owner: { id: "github:ana-personal", label: "ana-personal" } },
  }))
})
