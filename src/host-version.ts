// The OpenCode releases this plugin supports and is tested on. HOST_RANGE equals package.json
// opencode.host; TESTED_HOSTS is the one list of tested releases, which the tests and CI use too.
import { GitHubPluginError } from "./errors.js"

export const HOST_RANGE = ">=2.2.3 <2.3.0"
export const TESTED_HOSTS = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"] as const

const LOWEST: Version = [2, 2, 3]
const ABOVE: Version = [2, 3, 0]

type Version = readonly [number, number, number]

/**
 * Refuses an OpenCode release outside the supported range, unless `allowUntested` is set; then it
 * returns a warning for the status. Prereleases, dev builds and unparsable versions are outside it.
 */
export function checkHost(version: string, allowUntested: boolean): string | undefined {
  if (inRange(version)) return undefined
  const message = `OpenCode ${version} is outside the supported range ${HOST_RANGE}.`
  if (!allowUntested) {
    throw new GitHubPluginError(
      "HOST_UNTESTED",
      message,
      "Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.",
    )
  }
  return `${message} It loaded because allowUntestedHost is set.`
}

/** Whether this exact release is one the plugin is tested on. */
export function isTestedHost(version: string): boolean {
  return (TESTED_HOSTS as readonly string[]).includes(version)
}

function inRange(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const parsed: Version = [Number(match[1]), Number(match[2]), Number(match[3])]
  return compare(parsed, LOWEST) >= 0 && compare(parsed, ABOVE) < 0
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return 0
}
