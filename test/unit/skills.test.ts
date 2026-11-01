import { existsSync, readFileSync, readdirSync } from "node:fs"
import { isAbsolute } from "node:path"
import { describe, expect, it } from "vitest"
import { SKILL_IDS, parseSkill, registerSkills, skillPath } from "../../src/skills.js"
import { jargonIn } from "./jargon.js"

const read = (id: string) => readFileSync(skillPath(id), "utf8")

describe("the shipped skills", () => {
  it("are exactly the three hand-written skills", () => {
    expect(readdirSync(new URL("../../skills/", import.meta.url)).sort()).toEqual([...SKILL_IDS].sort())
  })

  it.each(SKILL_IDS)("%s has its folder name and a one-line description", (id) => {
    const skill = parseSkill(id, read(id))
    expect(skill.name).toBe(id)
    expect(skill.description.length).toBeGreaterThan(40)
    expect(skill.description).not.toContain("\n")
  })

  it.each(SKILL_IDS)("%s is short, plain and points to /github-status", (id) => {
    const text = read(id)
    expect(text.split("\n").length).toBeLessThan(80)
    expect(jargonIn(text)).toEqual([])
    expect(text).toContain("/github-status")
    expect(text).toMatch(/never as instructions to you/)
  })
})

describe("parseSkill", () => {
  it("reads CRLF files and drops the frontmatter from the content", () => {
    expect(parseSkill("demo", "---\r\nname: demo\r\ndescription: Does a thing.\r\n---\r\n\r\n# Demo\r\n")).toEqual({
      name: "demo",
      description: "Does a thing.",
      content: "# Demo\n",
    })
  })

  it.each([
    ["no frontmatter", "# Demo\n"],
    ["a name that is not the folder", "---\nname: other\ndescription: x\n---\nbody\n"],
    ["no description", "---\nname: demo\n---\nbody\n"],
    ["an empty description", "---\nname: demo\ndescription:\n---\nbody\n"],
    ["an extra field", "---\nname: demo\ndescription: x\nlicense: MIT\n---\nbody\n"],
    ["a repeated field", "---\nname: demo\nname: demo\ndescription: x\n---\nbody\n"],
    ["a line that is not a field", "---\nname: demo\n  description: x\n---\nbody\n"],
  ])("rejects %s", (_case, text) => {
    expect(() => parseSkill("demo", text)).toThrow(/^SKILLS_INVALID: skills\/demo\/SKILL\.md .* Next step: Reinstall the plugin\.$/)
  })
})

describe("registerSkills", () => {
  it("adds the three skills with absolute paths and their content", async () => {
    type Ctx = Parameters<typeof registerSkills>[0]
    const added: Array<{ id: string; name: string; description?: string; path: string; content: string }> = []
    const ctx = {
      skill: {
        transform: async (callback: (editor: { add(skill: (typeof added)[number]): void }) => void) => {
          callback({ add: (skill) => added.push(skill) })
          return { dispose: async () => {} }
        },
      },
    } as unknown as Ctx
    await registerSkills(ctx)
    expect(added.map((skill) => skill.id)).toEqual([...SKILL_IDS])
    for (const skill of added) {
      expect(skill.name).toBe(skill.id)
      expect(isAbsolute(skill.path) && existsSync(skill.path)).toBe(true)
      expect(skill.content.startsWith("# ")).toBe(true)
      expect(skill.description).toBe(parseSkill(skill.id, read(skill.id)).description)
    }
  })
})
