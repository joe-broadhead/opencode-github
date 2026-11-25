import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { McpListOutput } from "@opencode/client"
import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"
import { MCP_URL } from "../../src/provider/endpoints.ts"

const root = fileURLToPath(new URL("../../", import.meta.url))
// The real host loads the built plugin, the way `opencode plugin add` installs it.
const built = (await import(pathToFileURL(join(root, "dist", "index.js")).href)).default

/** A second plugin that records the MCP configs the host holds, including the URL `client.mcp.list` does not return. */
interface ConfigProbe {
  readonly plugin: Plugin.Plugin
  readonly configs: Map<string, Record<string, unknown>>
  capture(): Promise<void>
}

function configProbe(): ConfigProbe {
  const configs = new Map<string, Record<string, unknown>>()
  let context: Plugin.Context | undefined
  const plugin = Plugin.define({
    id: "mcp-config-probe",
    async setup(held) {
      context = held
      return async () => undefined
    },
  })
  return {
    plugin,
    configs,
    async capture() {
      if (context === undefined) throw new Error("the config probe's setup did not run")
      const registration = await context.mcp.transform((editor) => {
        for (const [name, config] of editor.list()) configs.set(name, structuredClone(config) as Record<string, unknown>)
      })
      await registration.dispose()
    },
  }
}

/** A host with HOME and every XDG directory in a temp root, an empty project and a config that is not the repo's. */
async function isolatedHost(input: { content: string; plugins: readonly Plugin.Plugin[] }) {
  const home = await mkdtemp(join(tmpdir(), "github-mcp-"))
  process.env["HOME"] = home
  for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) process.env[key] = join(home, key.toLowerCase())
  const project = join(home, "project")
  const config = join(home, "config")
  await mkdir(project)
  await mkdir(config)
  assert.deepEqual(await readdir(project), [], "the project directory is empty, so the host cannot discover a server from it")
  const host = await OpenCode.create({
    plugins: input.plugins,
    config: { content: input.content, directory: config, project: false },
    app: { name: "opencode", version: "2.4.1" },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error", emit: () => undefined },
  })
  return { host, home, project, async close() { await host.close(); await rm(home, { recursive: true, force: true }) } }
}

/** Activate the plugin and wait until the host lists exactly `expected`, or fail with what it listed. */
async function serversOf(host: Awaited<ReturnType<typeof isolatedHost>>["host"], project: string, expected: readonly string[]) {
  const session = await host.sessions.create({ location: { directory: project } })
  await host.sessions.prompt({ sessionID: session.id, text: "activate the github plugin", delivery: "queue" }).catch(() => undefined)
  const deadline = Date.now() + 30_000
  let data: McpListOutput["data"] = []
  for (;;) {
    data = (await host.mcp.list({ location: { directory: project } })).data
    const names = data.map((server) => server.name).sort()
    if (expected.every((name) => names.includes(name)) && names.length === expected.length) return data
    if (Date.now() > deadline) {
      throw new Error(`the host registered no ${expected.join(", ")}; it listed ${names.join(", ") || "nothing"}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test("the real 2.4.1 host registers the github MCP server for the default account", async () => {
  const probe = configProbe()
  const edge = await isolatedHost({ content: "{}", plugins: [built, probe.plugin] })
  try {
    const servers = await serversOf(edge.host, edge.project, ["github"])
    assert.equal(servers.length, 1)
    assert.ok(servers[0]?.integrationID, "the host gives the server its own integration")
    assert.notEqual(servers[0]?.status.status, "disabled")

    // `client.mcp.list` names the server; the host's own config holds the URL it was registered with. Both come from
    // the same registration, so a wrong or missing URL fails here too.
    await probe.capture()
    const config = probe.configs.get("github")
    assert.ok(config, "the host holds the github server's config")
    assert.equal(config["type"], "remote")
    assert.equal(config["url"], MCP_URL)
    assert.deepEqual(config["oauth"], {}, "the host accepted the empty OAuthConfig, not a boolean or a missing value")
  } finally {
    await edge.close()
  }
})

test("the real 2.4.1 host registers one MCP server per account alias", async () => {
  const probe = configProbe()
  const edge = await isolatedHost({
    content: JSON.stringify({ plugins: [{ package: root, options: { accounts: { work: {}, personal: {} } } }] }),
    plugins: [probe.plugin],
  })
  try {
    const servers = await serversOf(edge.host, edge.project, ["github-personal", "github-work"])
    assert.equal(new Set(servers.map((server) => server.integrationID)).size, 2, "each alias has its own integration")
    for (const server of servers) assert.notEqual(server.status.status, "disabled")

    await probe.capture()
    for (const name of ["github-work", "github-personal"]) {
      const config = probe.configs.get(name)
      assert.ok(config, `the host holds the ${name} server's config`)
      assert.equal(config["type"], "remote")
      assert.equal(config["url"], MCP_URL)
      assert.deepEqual(config["oauth"], {})
    }
  } finally {
    await edge.close()
  }
})
