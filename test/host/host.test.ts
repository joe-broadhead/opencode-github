import assert from "node:assert/strict"
import { test } from "node:test"
import { assertHost } from "@we-the-rebel-alliance/plugin-contract/register"
import { manifest } from "../../src/manifest.ts"

const context = (version: string, options: Record<string, unknown> = {}) => ({ app: { version }, options })

test("the tested host starts the plugin", () => {
  assert.doesNotThrow(() => assertHost(context("2.4.1"), manifest))
})

test("an untested host is refused with HOST_UNTESTED and a next step", () => {
  assert.throws(
    () => assertHost(context("2.5.0"), manifest),
    (error: unknown) => error instanceof Error && /^HOST_UNTESTED: /.test(error.message) && error.message.includes("Next step: "),
  )
})

test("allowUntestedHost starts an untested host, and only that option does", () => {
  assert.doesNotThrow(() => assertHost(context("2.5.0", { allowUntestedHost: true }), manifest))
  assert.throws(() => assertHost(context("2.5.0", { allowUntestedHost: false }), manifest), /HOST_UNTESTED/)
})
