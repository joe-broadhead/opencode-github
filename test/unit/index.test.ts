import type { Plugin } from "@opencode/plugin"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GitHubPluginError } from "../../src/errors.js"
import plugin from "../../src/index.js"

const LOCATION = { directory: "/workspace" }

// Only the parts of the context the server part uses; every registration is logged.
function fakeContext(input: { version?: string; options?: Record<string, unknown>; failSkills?: boolean } = {}) {
  const log: string[] = []
  const registration = (name: string) => {
    log.push(`register ${name}`)
    return { dispose: async () => void log.push(`dispose ${name}`) }
  }
  const transform = (name: string) => async () => registration(name)
  let streams = 0
  const ctx = {
    app: { name: "opencode", version: input.version ?? "2.2.3", channel: "latest" },
    location: LOCATION,
    options: input.options ?? {},
    agent: { transform: transform("agent"), list: async () => ({ location: LOCATION, data: [] }) },
    tool: { transform: transform("tool") },
    mcp: { transform: transform("mcp"), list: async () => ({ location: LOCATION, data: [] }) },
    integration: { transform: transform("integration"), get: async () => ({ location: LOCATION, data: { methods: [] } }), connection: { active: async () => undefined } },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]() {
          streams++
          return {
            next: () => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))),
            return: async () => {
              streams--
              return { done: true, value: undefined }
            },
          }
        },
      }),
    },
    command: { transform: transform("command") },
    rpc: { register: async () => ({ ...registration("rpc"), events: { emit: async () => {} } }) },
    session: { synthetic: async () => ({}) },
    permission: { hook: async () => registration("permission hook") },
    skill: {
      transform: async () => {
        if (input.failSkills) throw new Error("skills failed")
        return registration("skill")
      },
    },
  }
  return { ctx: ctx as unknown as Plugin.Context, log, streams: () => streams }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("github.platform", () => {
  it("keeps its plugin ID", () => {
    expect(plugin.id).toBe("github.platform")
  })

  it("registers permissions, the tool filter, the server, github_api, status, the tools RPC and skills in order, and cleans up in reverse", async () => {
    const host = fakeContext()
    const cleanup = await plugin.setup(host.ctx)
    expect(host.log).toEqual([
      "register agent",
      "register tool",
      "register mcp",
      "register tool",
      "register command",
      "register rpc",
      "register rpc",
      "register permission hook",
      "register skill",
    ])
    expect(host.streams()).toBe(2)
    expect(typeof cleanup).toBe("function")
    host.log.length = 0
    await (cleanup as () => Promise<void>)()
    expect(host.log).toEqual([
      "dispose skill",
      "dispose permission hook",
      "dispose rpc",
      "dispose rpc",
      "dispose command",
      "dispose tool",
      "dispose mcp",
      "dispose tool",
      "dispose agent",
    ])
    expect(host.streams()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("with host set, registers no MCP server and no tool filter, and keeps the sign-in on its own integration", async () => {
    const host = fakeContext({ options: { host: "ghe.example.com" } })
    const cleanup = (await plugin.setup(host.ctx)) as () => Promise<void>
    // The MCP transform only watches for another server named github, for the tools RPC.
    expect(host.log).toEqual([
      "register agent",
      "register integration",
      "register mcp",
      "register tool",
      "register command",
      "register rpc",
      "register rpc",
      "register permission hook",
      "register skill",
    ])
    await cleanup()
    expect(host.streams()).toBe(0)
  })

  it("refuses an untested OpenCode before registering anything", async () => {
    const host = fakeContext({ version: "2.3.0" })
    const error = await Promise.resolve(plugin.setup(host.ctx)).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(GitHubPluginError)
    expect((error as GitHubPluginError).code).toBe("HOST_UNTESTED")
    expect(host.log).toEqual([])
  })

  it("loads an untested OpenCode when allowUntestedHost is set", async () => {
    const host = fakeContext({ version: "0.0.0-dev-1", options: { allowUntestedHost: true } })
    const cleanup = (await plugin.setup(host.ctx)) as () => Promise<void>
    expect(host.log).toContain("register skill")
    await cleanup()
  })

  it("rejects invalid options before registering anything", async () => {
    const host = fakeContext({ options: { repositories: ["octo/repo"] } })
    const error = await Promise.resolve(plugin.setup(host.ctx)).catch((cause: unknown) => cause)
    expect((error as GitHubPluginError).code).toBe("OPTIONS_INVALID")
    expect(host.log).toEqual([])
  })

  it("disposes what it registered when a later step fails, then rethrows", async () => {
    const host = fakeContext({ failSkills: true })
    await expect(Promise.resolve(plugin.setup(host.ctx))).rejects.toThrow("skills failed")
    expect(host.log.filter((line) => line.startsWith("dispose"))).toEqual([
      "dispose permission hook",
      "dispose rpc",
      "dispose rpc",
      "dispose command",
      "dispose tool",
      "dispose mcp",
      "dispose tool",
      "dispose agent",
    ])
    expect(host.streams()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
