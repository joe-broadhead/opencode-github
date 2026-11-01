// Registers the plugin's hand-written skills. Each is read once at setup from the
// package's skills/<id>/SKILL.md.
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { type Plugin, Skill } from "@opencode/plugin"
import { GitHubPluginError } from "./errors.js"

export const SKILL_IDS = ["github-pr-review", "github-issue-triage", "github-code-research"] as const

type ParsedSkill = { readonly name: string; readonly description: string; readonly content: string }

/** Parses the frontmatter strictly: exactly `name` (equal to the folder) and a one-line `description`. */
export function parseSkill(id: string, text: string): ParsedSkill {
  const source = text.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (!match) throw invalid(`skills/${id}/SKILL.md has no frontmatter block.`)
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!field || fields.has(field[1]!)) throw invalid(`skills/${id}/SKILL.md has an invalid frontmatter line: ${line.slice(0, 80)}.`)
    fields.set(field[1]!, field[2]!.trim())
  }
  const name = fields.get("name")
  const description = fields.get("description")
  if (fields.size !== 2 || name !== id || !description) {
    throw invalid(`skills/${id}/SKILL.md needs exactly a name equal to "${id}" and a description.`)
  }
  return { name, description, content: match[2]!.trimStart() }
}

function invalid(message: string): GitHubPluginError {
  return new GitHubPluginError("SKILLS_INVALID", message, "Reinstall the plugin.")
}

export function skillPath(id: string): string {
  return fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url))
}

type SkillContext = { readonly skill: Pick<Plugin.Context["skill"], "transform"> }

export async function registerSkills(ctx: SkillContext): Promise<{ dispose(): Promise<void> }> {
  const skills = await Promise.all(
    SKILL_IDS.map(async (id) => {
      const path = skillPath(id)
      const text = await readFile(path, "utf8").catch(() => {
        throw invalid(`skills/${id}/SKILL.md is missing or unreadable.`)
      })
      return { id, path, ...parseSkill(id, text) }
    }),
  )
  return ctx.skill.transform((editor) => {
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
}
