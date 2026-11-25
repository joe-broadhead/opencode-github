/**
 * The plugin's hand-written skills, read once at setup and registered with `ctx.skill`.
 *
 * `register` owns tools, RPC and the bus but not skills; each package's skills ship in `skills/<id>/SKILL.md` and must
 * be added to the host explicitly. A broken or missing file is recorded for `status` instead of taking the plugin
 * down, so one bad skill never hides GitHub's tools.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { type Plugin, Skill } from "@opencode/plugin"

/** Every skill the package ships, in the order its folder lists them. */
export const SKILL_IDS = ["github", "github-pr-review", "github-issue-triage", "github-code-research"] as const
export type SkillId = (typeof SKILL_IDS)[number]

export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly content: string
}

/** Parses the frontmatter strictly: exactly `name` (equal to the folder) and a one-line `description`. */
export function parseSkill(id: string, text: string): ParsedSkill {
  const source = text.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (!match) throw new Error(`skills/${id}/SKILL.md has no frontmatter block`)
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!field || fields.has(field[1]!)) throw new Error(`skills/${id}/SKILL.md has an invalid frontmatter line: ${line.slice(0, 80)}`)
    fields.set(field[1]!, field[2]!.trim())
  }
  const name = fields.get("name")
  const description = fields.get("description")
  const content = match[2]!.trimStart()
  if (fields.size !== 2 || name !== id || description === undefined || description.length === 0) {
    throw new Error(`skills/${id}/SKILL.md needs exactly a name equal to "${id}" and a description`)
  }
  if (content.trim().length === 0) throw new Error(`skills/${id}/SKILL.md has no content`)
  return { name, description, content }
}

/** The absolute path of one skill file inside the installed package. */
export function skillPath(id: SkillId): string {
  return fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url))
}

type SkillContext = { readonly skill: Pick<Plugin.Context["skill"], "transform"> }

/** Register every skill; a broken one is a status problem, never a setup failure. */
export async function registerSkills(ctx: SkillContext): Promise<{ dispose(): Promise<void>; problems: readonly string[] }> {
  const problems: string[] = []
  const skills: { id: SkillId; path: string; name: string; description: string; content: string }[] = []
  for (const id of SKILL_IDS) {
    const path = skillPath(id)
    try {
      const text = await readFile(path, "utf8")
      skills.push({ id, path, ...parseSkill(id, text) })
    } catch (error) {
      problems.push(`skills/${id}/SKILL.md: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let registration: { dispose(): Promise<void> } | undefined
  try {
    registration = await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        editor.add({
          id: Skill.ID.make(skill.id),
          name: Skill.Name.make(skill.name),
          description: skill.description,
          // The host brands absolute paths; this one comes from the package location.
          path: skill.path as Skill.Info["path"],
          content: skill.content,
        })
      }
    })
  } catch (error) {
    problems.push(`skills: the host refused the skill transform: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    problems,
    async dispose() {
      await registration?.dispose().catch(() => undefined)
    },
  }
}
