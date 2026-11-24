import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { GitHubPluginError } from "../../src/errors.js"
import { HOST_RANGE, TESTED_HOSTS, checkHost, isTestedHost } from "../../src/host-version.js"

describe("checkHost", () => {
  it.each(["2.4.1", "2.4.2", "2.4.9"])("loads on %s, inside the supported range", (version) => {
    expect(checkHost(version, false)).toBeUndefined()
  })

  it.each(["2.4.0", "2.5.0", "3.0.0", "2.3.9", "2.4.1-beta.1", "0.0.0-dev-1", "0.0.0-dev-202610301200", "unknown", "", "v2.4.1", "2.4"])(
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
        `HOST_UNTESTED: OpenCode ${version} is outside the supported range >=2.4.1 <2.5.0. Next step: Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.`,
      )
    },
  )

  it("loads outside the range with a warning when allowUntestedHost is set", () => {
    expect(checkHost("2.5.0", true)).toBe("OpenCode 2.5.0 is outside the supported range >=2.4.1 <2.5.0. It loaded because allowUntestedHost is set.")
    expect(checkHost("2.4.1", true)).toBeUndefined()
  })

  it("equals package.json opencode.host", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    expect(HOST_RANGE).toBe(">=2.4.1 <2.5.0")
    expect(manifest.opencode.host).toBe(HOST_RANGE)
  })
})

describe("isTestedHost", () => {
  // The list is the one the host, pack and stock tests run on.
  it("is true only for the tested releases", () => {
    expect(TESTED_HOSTS).toEqual(["2.4.1"])
    for (const version of TESTED_HOSTS) expect(isTestedHost(version)).toBe(true)
    for (const version of ["2.4.99", "2.4.0", "2.5.0", "2.4.1-beta.1", ""]) expect(isTestedHost(version)).toBe(false)
  })
})
