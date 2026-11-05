import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { defaultRules } from "../../src/permissions.js"
import { ENTERPRISE_INTEGRATION_ID, ENTERPRISE_NAME } from "../../src/enterprise.js"
import { SERVER_NAME } from "../../src/rpc.js"
import { API_TOOL_NAME, HIDDEN, KNOWN_TOOLS, TOOL_PREFIX } from "../../src/tools.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own default rules never reach them; Jelly writes each declared "ask" or
 * "deny" as that tool's default instead. So each declared effect must be the one these rules give the tool after a
 * base allow, and the declared skills must be the ones the package ships.
 */

type Tool = { name: string; permission: string; effect: string; readOnly: boolean }
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[]; jelly: unknown }
const jelly = manifest.jelly as {
  title: string
  summary: string
  icon: string
  tools: Tool[]
  skills: string[]
  rpc: unknown[]
  views: unknown[]
  signIns: unknown[]
  contributes: Record<string, unknown[]>
}
const rules: readonly { action: string; resource: string; effect: string }[] = [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()]
const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)
const effectOf = (action: string) => [...rules].reverse().find((rule) => wildcard(rule.action).test(action) && rule.resource === "*")?.effect

describe("the jelly declaration", () => {
  it("gives each tool the effect the plugin's own default rules give it", () => {
    expect(jelly.tools.length).toBeGreaterThan(0)
    for (const tool of jelly.tools) expect(effectOf(tool.permission), tool.permission).toBe(tool.effect)
  })

  it("names each tool once, as the engine names its permission (namespace.tool for namespace_tool)", () => {
    const names = jelly.tools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of jelly.tools) expect(tool.name.replaceAll(".", "_"), tool.name).toBe(tool.permission)
  })

  it("declares every known tool but the hidden ones, and github_api, marking the reads read-only", () => {
    const hidden = new Set<string>(HIDDEN)
    const known = new Map<string, boolean>()
    for (const toolset of Object.values(KNOWN_TOOLS)) {
      for (const name of toolset.write) known.set(`${TOOL_PREFIX}${name}`, false)
      for (const name of toolset.read) if (!hidden.has(name)) known.set(`${TOOL_PREFIX}${name}`, true)
    }
    known.set(`${TOOL_PREFIX}${API_TOOL_NAME}`, false)
    const declared = new Map(jelly.tools.map((tool) => [tool.permission, tool.readOnly]))
    expect([...declared.keys()].sort()).toEqual([...known.keys()].sort())
    for (const [permission, readOnly] of known) expect(declared.get(permission), permission).toBe(readOnly)
  })

  it("declares the github server's sign-in, which takes a Jelly host's OAuth App as clientId, and, as its alternative, the GitHub Enterprise one", () => {
    expect(jelly.signIns).toEqual([
      { id: "github", label: "GitHub", server: SERVER_NAME, group: "github", hostClient: { id: "github", option: "clientId" } },
      { id: "github-enterprise", label: ENTERPRISE_NAME, integration: ENTERPRISE_INTEGRATION_ID, group: "github" },
    ])
  })

  it("declares no RPC methods, views or contributions, and no keys Jelly's declaration schema does not have", () => {
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
    expect(jelly.contributes).toEqual({ homeFeeds: [], homeWidgets: [], workKinds: [], settings: [] })
    expect(Object.keys(jelly).sort()).toEqual(["contributes", "icon", "rpc", "signIns", "skills", "summary", "title", "tools", "views"])
  })

  it("has a one-line summary of 1 to 120 characters", () => {
    expect(jelly.summary).toBe(jelly.summary.trim())
    expect(jelly.summary.length).toBeGreaterThan(0)
    expect(jelly.summary.length).toBeLessThanOrEqual(120)
    expect(jelly.summary).not.toContain("\n")
  })

  // Jelly keeps an icon only if its cleaner passes it (hey-jelly's plugin-icon.ts); this checks the same vocabulary
  // without importing Jelly. The cleaner refuses <title> (hey-jelly #33).
  it("ships a small SVG icon, drawn only with elements Jelly's cleaner keeps, and no title", () => {
    const ELEMENTS = ["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask"]
    expect(jelly.icon).toBe("assets/icon.svg")
    expect(manifest.files.filter((entry) => entry.startsWith("assets"))).toEqual([jelly.icon])
    const svg = readFileSync(new URL(`../../${jelly.icon}`, import.meta.url), "utf8")
    expect(svg.length).toBeLessThan(2048)
    expect(svg.trim()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 48 48"[ >]/)
    expect(svg).not.toMatch(/<title|<\?xml|<!|&|<script|<style|href=/i)
    const names = [...svg.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1])
    expect(names.filter((name) => !ELEMENTS.includes(name!))).toEqual([])
  })

  it("names every skill the package ships", () => {
    expect([...jelly.skills].sort()).toEqual(readdirSync(new URL("../../skills", import.meta.url)).sort())
  })
})
