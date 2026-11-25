import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { Plugin } from "@opencode/plugin"
import { readSkills, registerSkills, type SkillFile } from "../../src/skills.ts"

const root = new URL("../..", import.meta.url)

test("readSkills reads every shipped skill, sorted by id", () => {
  const skills = readSkills()
  assert.deepEqual(skills.map((skill) => skill.id), ["github", "github-code-research", "github-issue-triage", "github-pr-review"])
  for (const skill of skills) {
    assert.equal(skill.name, skill.id)
    assert.ok(skill.description.length > 0 && skill.description.length <= 300, skill.id)
    assert.ok(![">", "|", ">-", "|-", ">+", "|+"].includes(skill.description.trim()), skill.id)
    assert.ok(skill.content.trim().length > 0, skill.id)
    assert.equal(skill.path, join(new URL("skills/", root).pathname, skill.id, "SKILL.md"))
    assert.ok(readFileSync(skill.path, "utf8").includes(skill.content.trim().slice(0, 20)))
  }
})

test("readSkills parses a folded block description as its text, not the marker", () => {
  const directory = mkdtempSync(join(tmpdir(), "github-skill-block-"))
  try {
    mkdirSync(join(directory, "github-block"))
    writeFileSync(
      join(directory, "github-block", "SKILL.md"),
      "---\nname: github-block\ndescription: >\n  A folded description\n  on two lines.\n---\nBody text.\n",
    )
    const skills = readSkills(directory)
    assert.equal(skills.length, 1)
    assert.equal(skills[0]?.description.trim(), "A folded description on two lines.")
    assert.notEqual(skills[0]?.description.trim(), ">")
    assert.equal(skills[0]?.content, "Body text.")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("readSkills refuses a bare block marker, a wrong name and a missing body", () => {
  const directory = mkdtempSync(join(tmpdir(), "github-skill-invalid-"))
  try {
    mkdirSync(join(directory, "github-bare"))
    writeFileSync(join(directory, "github-bare", "SKILL.md"), "---\nname: github-bare\ndescription: >\n---\nBody.\n")
    assert.throws(() => readSkills(directory), /SCHEMA_VIOLATION: skills\/github-bare\/SKILL.md/)
    rmSync(join(directory, "github-bare"), { recursive: true, force: true })
    mkdirSync(join(directory, "github-fold-plus"))
    writeFileSync(join(directory, "github-fold-plus", "SKILL.md"), "---\nname: github-fold-plus\ndescription: >+\n---\nBody.\n")
    assert.throws(() => readSkills(directory), /SCHEMA_VIOLATION: skills\/github-fold-plus\/SKILL.md/)
    rmSync(join(directory, "github-fold-plus"), { recursive: true, force: true })
    mkdirSync(join(directory, "github-literal-plus"))
    writeFileSync(join(directory, "github-literal-plus", "SKILL.md"), "---\nname: github-literal-plus\ndescription: |+\n---\nBody.\n")
    assert.throws(() => readSkills(directory), /SCHEMA_VIOLATION: skills\/github-literal-plus\/SKILL.md/)
    rmSync(join(directory, "github-literal-plus"), { recursive: true, force: true })
    mkdirSync(join(directory, "github-wrong"))
    writeFileSync(join(directory, "github-wrong", "SKILL.md"), "---\nname: another-name\ndescription: Description.\n---\nBody.\n")
    assert.throws(() => readSkills(directory), /names "another-name", not its directory "github-wrong"/)
    rmSync(join(directory, "github-wrong"), { recursive: true, force: true })
    mkdirSync(join(directory, "github-empty"))
    writeFileSync(join(directory, "github-empty", "SKILL.md"), "---\nname: github-empty\ndescription: Description.\n---\n")
    assert.throws(() => readSkills(directory), /has no content below its frontmatter/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("registerSkills adds every checked skill to the host transform", async () => {
  const added: SkillFile[] = []
  const context = {
    skill: {
      transform: async (callback: (editor: { add(skill: SkillFile): void }) => void) => {
        callback({ add: (skill) => added.push(skill) })
        return { dispose: async () => undefined }
      },
    },
  } as unknown as Plugin.Context
  const skills = readSkills()
  const registration = await registerSkills(context, skills)
  assert.deepEqual(added.map((skill) => skill.id), skills.map((skill) => skill.id))
  assert.deepEqual(added.map((skill) => skill.description), skills.map((skill) => skill.description))
  await registration.dispose()
})
