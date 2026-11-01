// The OpenCode releases this plugin is tested on. Equal to package.json opencode.host.
import { GitHubPluginError } from "./errors.js"

export const TESTED_HOST_RANGE = ">=2.2.3 <2.3.0"

const LOWEST: Version = [2, 2, 3]
const ABOVE: Version = [2, 3, 0]

type Version = readonly [number, number, number]

/**
 * Refuses an untested OpenCode release, unless `allowUntested` is set; then it returns a
 * warning for the status. Prereleases, dev builds and unparsable versions count as untested.
 */
export function checkHost(version: string, allowUntested: boolean): string | undefined {
  if (isTested(version)) return undefined
  const message = `OpenCode ${version} is not a tested host for this plugin (tested: ${TESTED_HOST_RANGE}).`
  if (!allowUntested) {
    throw new GitHubPluginError(
      "HOST_UNTESTED",
      message,
      "Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true.",
    )
  }
  return `${message} It loaded because allowUntestedHost is set.`
}

function isTested(version: string): boolean {
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
