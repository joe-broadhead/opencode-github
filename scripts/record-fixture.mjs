// Rewrites fixtures/conformance.json from the fake GitHub behind test/support.
//
//   npm run fixtures
//
// The fake is deterministic and answers two invented accounts, work and personal. The commands the plugin sends are
// recorded as answers only, never as requests, and nothing here carries a credential. `npx plugin-kit record` then
// redacts the file and checks it, so the committed fixture is the one the conformance kit reads.
import { mkdirSync, writeFileSync } from "node:fs"
import { manifest, packageName } from "../src/manifest.ts"
import { NOW } from "../test/support/github-fake.ts"
import { runtimeFor, run } from "../test/support/runtime.ts"

const runtime = runtimeFor()
const source = manifest.sources[0]
if (source === undefined) throw new Error("the manifest declares no source")
const sourceName = typeof source.input?.["source"] === "string" ? source.input["source"] : source.id
const since = "2026-11-01T00:00:00.000Z"

const page = (account, input) => run(runtime, "events_list", { source: sourceName, ...input }, account)

const workPage = await page("work", { since })
const personalPage = await page("personal", { since })
const emptyPage = await page("work", { since: "2026-11-24T00:00:00.000Z" })

async function refusal(account, input) {
  try {
    await page(account, input)
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error("expected a refusal")
}

const cursorRefusal = await refusal("personal", { cursor: workPage.cursor })
const sourceRefusal = await refusal("work", { source: "other" })

const probe = await run(runtime, "probe", { source: sourceName }, "work")
const sent = []
const status = await run(runtime, "status", {}, "work", sent)
// One change, so the fixture names every event the manifest declares: changed after the write, status and account from
// the status read.
await run(runtime, "api", { method: "POST", path: "/repos/example/work/issues", body: { title: "A test issue" } }, "work", sent)
const emitted = [...new Set(sent.map((item) => item.event))]

const fixture = {
  plugin: packageName,
  namespace: manifest.plugin.summary,
  accounts: {
    real: true,
    aliases: ["work", "personal"],
    required: { method: "events_list", code: "ACCOUNT_REQUIRED" },
    unknown: { method: "events_list", account: "nobodyhere", code: "ACCOUNT_UNKNOWN" },
    cursors: [{ method: "events_list", account: "work", other: "personal", code: "CURSOR_INVALID" }],
  },
  sources: {
    [source.id]: {
      cases: [
        { name: "a work page", input: { source: sourceName, account: "work", since }, expect: "page", answer: workPage },
        { name: "a personal page", input: { source: sourceName, account: "personal", since }, expect: "page", answer: personalPage },
        { name: "an empty window", input: { source: sourceName, account: "work", since: "2026-11-24T00:00:00.000Z" }, expect: "empty", answer: emptyPage },
        {
          name: "another account's cursor is refused",
          input: { source: sourceName, account: "personal", cursor: workPage.cursor },
          expect: "CURSOR_INVALID",
          refuses: cursorRefusal,
        },
        { name: "an unknown source is refused", input: { source: "other", account: "work" }, expect: "SOURCE_UNKNOWN", refuses: sourceRefusal },
      ],
      probe: { input: { source: sourceName, account: "work" }, answer: probe },
      atomicPages: { reason: "one page merges four provider reads under one cut, so a page is not one provider request" },
    },
  },
  events: { emitted, status },
}

mkdirSync("fixtures", { recursive: true })
writeFileSync("fixtures/conformance.json", `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`recorded fixtures/conformance.json for ${packageName} at ${new Date(NOW).toISOString()}`)
