import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { GitHubPluginError } from "../../src/errors.js"
import { TESTED_HOST_RANGE, checkHost } from "../../src/host-version.js"

describe("checkHost", () => {
  it.each(["2.2.3", "2.2.4", "2.2.9", "2.2.10"])("accepts %s", (version) => {
    expect(checkHost(version, false)).toBeUndefined()
  })

  it.each(["2.2.2", "2.3.0", "3.0.0", "2.1.9", "2.2.4-beta.1", "0.0.0-dev-1", "0.0.0-dev-202610301200", "unknown", "", "v2.2.3", "2.2"])(
    "refuses %j",
    (version) => {
      let error: unknown
      try {
        checkHost(version, false)
      } catch (cause) {
        error = cause
      }
      expect(error).toBeInstanceOf(GitHubPluginError)
      expect((error as GitHubPluginError).code).toBe("HOST_UNTESTED")
      expect((error as GitHubPluginError).message).toBe(
        `HOST_UNTESTED: OpenCode ${version} is not a tested host for this plugin (tested: >=2.2.3 <2.3.0). Next step: Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.`,
      )
    },
  )

  it("loads an untested host with a warning when allowUntestedHost is set", () => {
    expect(checkHost("2.3.0", true)).toBe(
      "OpenCode 2.3.0 is not a tested host for this plugin (tested: >=2.2.3 <2.3.0). It loaded because allowUntestedHost is set.",
    )
    expect(checkHost("2.2.3", true)).toBeUndefined()
  })

  it("equals package.json opencode.host", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    expect(TESTED_HOST_RANGE).toBe(">=2.2.3 <2.3.0")
    expect(manifest.opencode.host).toBe(TESTED_HOST_RANGE)
  })
})
