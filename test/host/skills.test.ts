import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/sdk"
import type { Plugin } from "@opencode/plugin"
import { load, resolve } from "@opencode/plugin/host"
import { waitForActivation } from "@we-the-rebel-alliance/plugin-contract/kit"
import { parse as parseYaml } from "yaml"

const root = fileURLToPath(new URL("../..", import.meta.url))

/** The real host's domains this test reads, as `@opencode/plugin` exposes them to a plugin. */
interface Host {
  readonly sessions: {
    create(input: Record<string, unknown>): Promise<{ readonly id: string }>
    prompt(input: Record<string, unknown>): Promise<unknown>
  }
  readonly plugin: {
    list(input: Record<string, unknown>): Promise<{ readonly data: readonly { readonly id?: string }[] }>
  }
  readonly skill: {
    list(input: Record<string, unknown>): Promise<{
      readonly data: readonly { readonly id: string; readonly name: string; readonly description?: string; readonly path: string; readonly content: string }[]
    }>
  }
  close(): Promise<void>
}

test("the real OpenCode 2.4.1 host registers every skills/<name>/SKILL.md after load", async () => {
  const entry = resolve({ directory: root }).server
  assert.ok(entry !== undefined, "the package has no server entry")
  const module = (await load(entry)) as { readonly default?: Plugin.Plugin }
  const definition = module.default
  assert.ok(definition !== undefined, "the server entry exports no Plugin.define value")

  const ids = readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  assert.ok(ids.length > 0, "the package ships no skill")

  // An empty project: OpenCode discovers `<project>/skills/` itself, so using the repository root here would let
  // the test pass without `registerSkills`. The skills must come from the plugin's transform alone.
  const project = mkdtempSync(join(tmpdir(), "plugin-skill-project-"))
  // An empty project: the ids can only come from the plugin's transform.
  assert.deepEqual(readdirSync(project), [], "the project directory is empty, so the host cannot discover project skills")
  try {
    const host = (await OpenCode.create({
      plugins: [definition],
      config: { directory: project },
      app: { name: "opencode", version: "2.4.1" },
      log: { level: "error", emit: () => undefined },
    })) as unknown as Host

    try {
      const session = await host.sessions.create({ location: { directory: project }, agent: "build", permissions: [] })
      await host.sessions.prompt({ sessionID: session.id, text: "activate the skill registration", delivery: "queue" }).catch(() => undefined)
      await waitForActivation({
        isActive: async () => {
          const list = await host.plugin.list({ location: { directory: project } }).catch(() => undefined)
          return list?.data.some((entry) => entry.id === definition.id) ?? false
        },
        timeoutMs: 20_000,
      })
      const answer = await host.skill.list({ location: { directory: project } })
      for (const id of ids) {
        const skill = answer.data.find((candidate) => candidate.id === id)
        assert.ok(skill !== undefined, `the host did not register the ${id} skill`)
        assert.equal(skill.name, id)
        assert.equal(skill.path, join(root, "skills", id, "SKILL.md"))
        assert.ok(skill.content.trim().length > 0, `the ${id} skill has no body`)
        const text = readFileSync(skill.path, "utf8")
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
        assert.ok(frontmatter !== null, `the ${id} skill has no frontmatter`)
        const parsed = parseYaml(frontmatter[1] ?? "") as { readonly description?: unknown }
        assert.equal(typeof parsed.description, "string", `the ${id} skill has no YAML description`)
        const expected = parsed.description as string
        assert.notEqual(expected.trim(), "", `the ${id} skill has an empty description`)
        assert.ok(expected.length <= 300, `the ${id} skill description is over 300 characters`)
        for (const marker of [">", "|", ">-", "|-", ">+", "|+"]) assert.notEqual(expected.trim(), marker, `the ${id} skill registers the block marker ${marker}, not its text`)
        assert.equal(skill.description, expected, `the ${id} skill description is not the YAML text`)
      }
    } finally {
      await host.close()
    }
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
