#!/usr/bin/env node
// Lints the workflows as workflows, not as YAML: `actionlint` catches a `${{ }}` that exists in some contexts only,
// which makes GitHub reject the whole file and run nothing at all. CI runs it in its own job; here it runs when the
// tool is on PATH and says so when it is not, so a local check never looks greener than it is.
import { spawnSync } from "node:child_process"

const probe = spawnSync("actionlint", ["-version"], { encoding: "utf8" })
if (probe.error?.code === "ENOENT") {
  console.log("actionlint is not on PATH, so the workflow check is skipped here; CI runs it in its own job.")
  process.exit(0)
}
const result = spawnSync("actionlint", ["-color"], { stdio: "inherit" })
process.exit(result.status ?? 1)
