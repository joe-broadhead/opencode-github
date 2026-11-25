import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/sdk"
import { parse as parseYaml } from "yaml"
import { SKILL_IDS } from "../../src/skills.ts"

const root = fileURLToPath(new URL("../../", import.meta.url))
// The real host loads the built plugin, the way `opencode plugin add` installs it.
const built = (await import(pathToFileURL(join(root, "dist", "index.js")).href)).default

test("every shipped skill is registered on the real 2.4.1 host", async () => {
  const folders = (await readdir(join(root, "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  assert.deepEqual(folders, [...SKILL_IDS].sort(), "SKILL_IDS must name every skills/*/SKILL.md folder")

  const directory = await mkdtemp(join(tmpdir(), "github-skills-"))
  // OpenCode discovers `<project directory>/skills/` by itself. The project is an empty temp directory, never the repo
  // root, so the four ids can only be present if the plugin's setup registers them.
  assert.deepEqual(await readdir(directory), [], "the project directory is empty, so the host cannot discover project skills")
  const host = await OpenCode.create({
    plugins: [built],
    config: { directory },
    app: { name: "opencode", version: "2.4.1" },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error", emit: () => undefined },
  })
  try {
    const session = await host.sessions.create({ location: { directory } })
    await host.sessions.prompt({ sessionID: session.id, text: "activate the github plugin", delivery: "queue" }).catch(() => undefined)
    const deadline = Date.now() + 30_000
    let skills: readonly { readonly id: string; readonly name: string; readonly description?: string; readonly path: string; readonly content: string }[] = []
    for (;;) {
      skills = (await host.skill.list({ location: { directory } })).data
      if (SKILL_IDS.every((id) => skills.some((skill) => skill.id === id))) break
      if (Date.now() > deadline) {
        const missing = SKILL_IDS.filter((id) => !skills.some((skill) => skill.id === id))
        throw new Error(`the host registered no skill ${missing.join(", ")}; it has ${skills.map((skill) => skill.id).join(", ")}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (const id of SKILL_IDS) {
      const skill = skills.find((held) => held.id === id)
      assert.ok(skill, id)
      const text = await readFile(join(root, "skills", id, "SKILL.md"), "utf8")
      const frontmatter = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
      assert.ok(frontmatter, `${id}: no frontmatter`)
      const parsed = parseYaml(frontmatter[1]!) as { name?: unknown; description?: unknown } | null
      assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `${id}: the frontmatter is not a mapping`)
      assert.equal(parsed.name, id)
      assert.equal(typeof parsed.description, "string")
      const description = parsed.description as string
      assert.equal(skill.name, id)
      assert.equal(skill.description, description)
      assert.ok(description.length > 0 && description.length <= 300)
      assert.notEqual(description, ">")
      assert.notEqual(description, "|")
      assert.match(skill.path, new RegExp(`/skills/${id}/SKILL\\.md$`))
      assert.ok(skill.content.trim().length > 0)
      assert.equal(skill.content.trim(), frontmatter[2]!.trim())
    }
    assert.equal(new Set(skills.filter((skill) => (SKILL_IDS as readonly string[]).includes(skill.id)).map((skill) => skill.id)).size, SKILL_IDS.length)
  } finally {
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
