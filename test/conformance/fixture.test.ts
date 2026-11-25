import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { accountsOf, resolveAccount } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { findSource } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { acceptAnswer } from "@we-the-rebel-alliance/plugin-contract/read"
import { manifest, packageName } from "../../src/manifest.ts"
import { OPTIONS, run, runtimeFor, type Sent } from "../support/runtime.ts"

interface RecordedCase {
  readonly name?: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly expect?: unknown
  readonly answer?: unknown
  readonly refuses?: string
}

interface Fixture {
  readonly plugin: string
  readonly namespace: string
  readonly accounts: { readonly real: boolean; readonly aliases: readonly string[]; readonly required: { method: string; code: string }; readonly unknown: { method: string; account: string; code: string } }
  readonly sources: Record<string, { readonly cases: readonly RecordedCase[]; readonly probe: { readonly input: Readonly<Record<string, unknown>>; readonly answer: unknown } }>
  readonly events: { readonly emitted: readonly string[]; readonly status: unknown }
}

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/conformance.json", import.meta.url), "utf8")) as Fixture
const source = findSource(manifest, "github.activity")
const recorded = fixture.sources["github.activity"]
if (source === undefined || recorded === undefined) throw new Error("fixtures/conformance.json records no github.activity source")

function withoutAccount(input: Readonly<Record<string, unknown>>): { readonly account: string; readonly input: Record<string, unknown> } {
  const { account, ...rest } = input
  return { account: typeof account === "string" ? account : "work", input: rest }
}

test("the fixture was recorded for this package, with two accounts and the namespace line", () => {
  assert.equal(fixture.plugin, packageName)
  assert.equal(fixture.namespace, manifest.plugin.summary)
  assert.equal(fixture.accounts.real, true)
  assert.deepEqual(fixture.accounts.aliases, ["work", "personal"])
  assert.deepEqual(fixture.accounts.required, { method: "events_list", code: "ACCOUNT_REQUIRED" })
  assert.deepEqual(fixture.accounts.unknown, { method: "events_list", account: "nobodyhere", code: "ACCOUNT_UNKNOWN" })
})

test("every recorded page is what the handlers answer today, and passes the consumer's check", async () => {
  const runtime = runtimeFor()
  for (const item of recorded.cases) {
    const { account, input } = withoutAccount(item.input ?? {})
    if (item.refuses !== undefined) {
      await assert.rejects(
        () => run(runtime, "events_list", input, account),
        (error: unknown) => error instanceof Error && error.message === item.refuses,
        item.name,
      )
      continue
    }
    const answer = await run(runtime, "events_list", input, account)
    assert.deepEqual(answer, item.answer, item.name)
    const accepted = acceptAnswer(source, account, answer)
    if (!accepted.ok) throw new Error(`${item.name}: ${accepted.failure.message}`)
  }
})

test("the recorded probe and status are what the handlers answer today", async () => {
  const runtime = runtimeFor()
  const probe = withoutAccount(recorded.probe.input)
  assert.deepEqual(await run(runtime, "probe", probe.input, probe.account), recorded.probe.answer)
  assert.deepEqual(await run(runtime, "status", {}, "work"), fixture.events.status)
})

test("the fixture records every bus event the manifest declares", async () => {
  const sent: Sent[] = []
  const runtime = runtimeFor()
  await run(runtime, "status", {}, "work", sent)
  await run(runtime, "api", { method: "POST", path: "/repos/example/work/issues", body: { title: "A test issue" } }, "work", sent)
  assert.deepEqual([...new Set(sent.map((item) => item.event))].sort(), [...fixture.events.emitted].sort())
  assert.deepEqual([...fixture.events.emitted].sort(), Object.keys(manifest.events).sort())
})

test("the account resolution is the contract's: a missing account asks, an unknown one is refused", () => {
  const plan = accountsOf(manifest, OPTIONS)
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  const missing = resolveAccount(plan.value.accounts, {})
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.equal(missing.code, "ACCOUNT_REQUIRED")
    assert.match(missing.next, /work, personal/)
  }
  const unknown = resolveAccount(plan.value.accounts, { account: "nobodyhere" })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.code, "ACCOUNT_UNKNOWN")
})

test("the fixture's cursor case is a real refusal, not a recorded string", async () => {
  const runtime = runtimeFor()
  const issued = (await run(runtime, "events_list", { since: "2026-11-01T00:00:00.000Z" }, "work")) as { cursor: string }
  await assert.rejects(
    () => run(runtime, "events_list", { cursor: issued.cursor }, "personal"),
    (error: unknown) => error instanceof Error && error.message.startsWith("CURSOR_INVALID: "),
  )
})
