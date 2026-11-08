import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/config.js"
import { observeMcp, registerMcp } from "../../src/mcp.js"

type Ctx = Parameters<typeof registerMcp>[0]
type Editor = Parameters<Parameters<Ctx["mcp"]["transform"]>[0]>[0]
type Config = Parameters<Editor["set"]>[1]

// Replays every registered transform over a fresh editor, as OpenCode does on each read.
function fakeMcp(initial: Record<string, Config> = {}) {
  const transforms: Array<(editor: Editor) => void> = []
  const build = () => {
    const servers = new Map<string, Config>(Object.entries(structuredClone(initial)))
    const editor = {
      list: () => [...servers.entries()],
      get: (name: string) => servers.get(name),
      set: (name: string, config: Config) => void servers.set(name, config),
      update: () => {
        throw new Error("not used")
      },
      remove: (name: string) => void servers.delete(name),
    } as unknown as Editor
    for (const transform of transforms) transform(editor)
    return Object.fromEntries(servers)
  }
  const ctx: Ctx = {
    mcp: {
      transform: async (callback) => {
        transforms.push(callback)
        return { dispose: async () => void transforms.splice(transforms.indexOf(callback), 1) }
      },
    },
  }
  return { ctx, build, transforms }
}

describe("registerMcp", () => {
  it("registers GitHub's server with exactly the documented URL and headers", async () => {
    const host = fakeMcp()
    const mcp = await registerMcp(host.ctx, loadOptions({}))
    expect(mcp.conflict()).toBeUndefined()
    expect(host.build()).toEqual({
      github: {
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { "X-MCP-Toolsets": "context,repos,issues,pull_requests,users,actions,git,labels,code_quality,code_security,secret_protection,dependabot,security_advisories,discussions,orgs", "X-MCP-Readonly": "false" },
      },
    })
    expect(mcp.conflict()).toBe(false)
  })

  it("maps toolsets, read-only and lockdown to GitHub's headers", async () => {
    const host = fakeMcp()
    await registerMcp(host.ctx, loadOptions({ toolsets: ["actions", "gists"], access: "all", lockdown: true }))
    expect(host.build().github).toEqual({
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { "X-MCP-Toolsets": "actions,gists", "X-MCP-Readonly": "false", "X-MCP-Lockdown": "true" },
    })
  })

  it("never sets OAuth, protocol or a tool list", async () => {
    const host = fakeMcp()
    await registerMcp(host.ctx, loadOptions({}))
    const config = host.build().github as Record<string, unknown> & { headers: Record<string, string> }
    expect(Object.keys(config).sort()).toEqual(["headers", "type", "url"])
    expect(Object.keys(config.headers)).not.toContain("X-MCP-Tools")
  })

  it("leaves a server named github from the user's config untouched and reports the conflict", async () => {
    const own: Config = { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer from-config" } } as Config
    const host = fakeMcp({ github: own })
    const mcp = await registerMcp(host.ctx, loadOptions({}))
    expect(host.build()).toEqual({ github: own })
    expect(mcp.conflict()).toBe(true)
  })

  it("follows the config when the user's server goes away", async () => {
    const initial: Record<string, Config> = { github: { type: "remote", url: "https://example.test/mcp" } as Config }
    const host = fakeMcp(initial)
    const mcp = await registerMcp(host.ctx, loadOptions({}))
    host.build()
    expect(mcp.conflict()).toBe(true)
    delete initial.github
    expect((host.build().github as { url: string }).url).toBe("https://api.githubcopilot.com/mcp/")
    expect(mcp.conflict()).toBe(false)
  })

  it("is the same on every replay and disposes", async () => {
    const host = fakeMcp()
    const mcp = await registerMcp(host.ctx, loadOptions({}))
    expect(host.build()).toEqual(host.build())
    await mcp.dispose()
    expect(host.build()).toEqual({})
  })
})

describe("observeMcp (GitHub Enterprise Server)", () => {
  it("registers nothing and reports whether another server named github exists", async () => {
    const none = fakeMcp()
    const watched = await observeMcp(none.ctx)
    expect(watched.conflict()).toBeUndefined()
    expect(none.build()).toEqual({})
    expect(watched.conflict()).toBe(false)

    const user = fakeMcp({ github: { type: "remote", url: "https://example.com/mcp" } as Config })
    const other = await observeMcp(user.ctx)
    expect(user.build()).toEqual({ github: { type: "remote", url: "https://example.com/mcp" } })
    expect(other.conflict()).toBe(true)
    await other.dispose()
    expect(user.transforms).toEqual([])
  })
})
