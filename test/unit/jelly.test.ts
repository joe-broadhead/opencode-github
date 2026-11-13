import { describe, expect, it } from "vitest"
import { defaultRules } from "../../src/permissions.js"
import { loadOptions } from "../../src/config.js"
import { ENTERPRISE_INTEGRATION_ID, ENTERPRISE_NAME } from "../../src/enterprise.js"
import { ACCESS, SERVER_NAME } from "../../src/rpc.js"
import { API_TOOL_NAME, HIDDEN, KNOWN_TOOLS, TOOL_PREFIX } from "../../src/tools.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingChoices, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own default rules never reach them; Jelly writes each declared "ask" or
 * "deny" as that tool's default instead. The shared kit checks the declaration against Jelly's plugin authors'
 * standard; the tests below add what only GitHub declares.
 */

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
const jelly = manifest.jelly as Declaration & { rpc: unknown[]; views: unknown[]; contributes: Record<string, unknown[]> & { settings: PluginSetting[] }; tools: DeclaredTool[] }

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    expect(declarationProblems(ROOT, { effectOf: effectFromRules(defaultRules()) })).toEqual([])
  })

  it("declares every known tool but the hidden ones, github_api and events_list, marking the reads read-only", () => {
    const hidden = new Set<string>(HIDDEN)
    const known = new Map<string, boolean>()
    for (const toolset of Object.values(KNOWN_TOOLS)) {
      for (const name of toolset.write) known.set(`${TOOL_PREFIX}${name}`, false)
      for (const name of toolset.read) if (!hidden.has(name)) known.set(`${TOOL_PREFIX}${name}`, true)
    }
    known.set(`${TOOL_PREFIX}${API_TOOL_NAME}`, false)
    known.set(`${TOOL_PREFIX}events_list`, true)
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

  it("declares flat settings the plugin reads, and no RPC methods, views or other contributions", () => {
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
    expect(jelly.contributes.homeFeeds).toEqual([])
    expect(jelly.contributes.homeWidgets).toEqual([])
    expect(jelly.contributes.workKinds).toEqual([])
    expect(jelly.contributes.settings.map((setting) => {
      const entry = setting as { key: string; type: string }
      return { key: entry.key, type: entry.type }
    })).toEqual([{ key: "access", type: "string" }, { key: "unknownTools", type: "string" }, { key: "lockdown", type: "boolean" }])
    const defaults = loadOptions({})
    for (const setting of jelly.contributes.settings) {
      const entry = setting as { key: "access" | "unknownTools" | "lockdown"; default: unknown }
      expect(entry.default).toBe(defaults[entry.key])
    }
    expect(loadOptions({ access: "read-only", unknownTools: "hide", lockdown: true })).toMatchObject({ access: "read-only", unknownTools: "hide", lockdown: true })
  })

  it("the settings follow Jelly's rules for a declared setting", () => {
    expect(settingsProblems(jelly.contributes.settings)).toEqual([])
  })

  it("access declares Jelly's own words for its three values, and unknownTools its two", () => {
    const setting = (key: string) => jelly.contributes.settings.find((entry) => entry.key === key)!
    expect(setting("access").choices).toEqual(ACCESS_CHOICES)
    expect((settingChoices(setting("unknownTools")) ?? []).map((choice) => choice.value)).toEqual(["ask", "hide"])
    expect(settingChoices(setting("lockdown"))).toBeUndefined()
  })

  it("the options parser takes every value of each declared closed set, and refuses a value outside it", () => {
    const sets = jelly.contributes.settings.filter((entry) => settingChoices(entry) !== undefined)
    expect(sets.map((entry) => entry.key)).toEqual(["access", "unknownTools"])
    expect((settingChoices(sets[0]!) ?? []).map((choice) => choice.value)).toEqual([...ACCESS])
    for (const entry of sets) {
      const key = entry.key as "access" | "unknownTools"
      for (const { value } of settingChoices(entry) ?? []) expect<string>(loadOptions({ [key]: value })[key]).toBe(value)
      expect<string>(loadOptions({})[key]).toBe(entry.default as string)
      expect(settingValueIssue(entry, "write")).not.toBeNull()
      expect(() => loadOptions({ [key]: "write" })).toThrow(/OPTIONS_INVALID|Invalid plugin option/)
    }
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
