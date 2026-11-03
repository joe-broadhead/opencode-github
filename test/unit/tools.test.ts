import { describe, expect, it } from "vitest"
import { KNOWN_TOOLS, PINNED, TOOL_PREFIX, allReadTools, registerToolFilter, toolKind } from "../../src/tools.js"

type Ctx = Parameters<typeof registerToolFilter>[0]
type Editor = Parameters<Parameters<Ctx["tool"]["transform"]>[0]>[0]
type Tool = { id: string; options?: Record<string, unknown> }

// A tool registry that replays transforms over fresh copies, as OpenCode does on each read.
function fakeTools(initial: Tool[]) {
  const transforms: Array<(editor: Editor) => void> = []
  const build = () => {
    const tools = new Map(initial.map((tool) => [tool.id, structuredClone(tool)]))
    const editor = {
      list: () => [...tools.values()],
      get: (id: string) => tools.get(id),
      update: (id: string, update: (tool: Tool) => void) => {
        const tool = tools.get(id)
        if (tool) update(tool)
      },
      remove: (id: string) => void tools.delete(id),
    } as unknown as Editor
    for (const transform of transforms) transform(editor)
    return [...tools.values()]
  }
  const ctx: Ctx = {
    tool: {
      transform: async (callback) => {
        transforms.push(callback)
        return { dispose: async () => void transforms.splice(transforms.indexOf(callback), 1) }
      },
    },
  }
  return { ctx, build }
}

const mcpTool = (name: string, options: Record<string, unknown> = {}): Tool => ({ id: `github_${name}`, options: { namespace: "github", codemode: true, ...options } })
const TOOLS = [
  mcpTool("get_me"),
  mcpTool("issue_read"),
  mcpTool("pull_request_read"),
  mcpTool("search_code"),
  mcpTool("create_pull_request"),
  mcpTool("brand_new_tool"),
  mcpTool("another_new_tool"),
  { id: "github_helper", options: { namespace: "other" } },
  { id: "linear_list_issues", options: { namespace: "linear" } },
]
const ids = (tools: Tool[]) => tools.map((tool) => tool.id)

describe("the catalog", () => {
  it("covers the required toolsets", () => {
    for (const toolset of ["context", "repos", "issues", "pull_requests", "users", "actions", "notifications", "labels", "discussions", "gists"]) {
      expect(Object.keys(KNOWN_TOOLS)).toContain(toolset)
    }
  })

  it("classifies tools as read or write", () => {
    expect(toolKind("get_me")).toBe("read")
    expect(toolKind("pull_request_read")).toBe("read")
    expect(toolKind("issue_write")).toBe("write")
    expect(toolKind("merge_pull_request")).toBe("write")
    expect(toolKind("brand_new_tool")).toBeUndefined()
  })

  it("knows the hosted server's dependency check as a dependabot read", () => {
    // It looks up packages in the GitHub Advisory Database and changes nothing on GitHub.
    expect(KNOWN_TOOLS.dependabot.read).toContain("check_dependency_vulnerabilities")
    expect(toolKind("check_dependency_vulnerabilities")).toBe("read")
    expect(allReadTools()).toContain("check_dependency_vulnerabilities")
  })

  it("never lists a tool as both read and write", () => {
    const writes = new Set(Object.values(KNOWN_TOOLS).flatMap((toolset) => toolset.write as readonly string[]))
    expect(allReadTools().filter((name) => writes.has(name))).toEqual([])
  })

  it("lists every read once, sorted", () => {
    const reads = allReadTools()
    expect(reads).toEqual([...new Set(reads)].sort())
    expect(reads).toContain("get_file_contents")
    expect(reads).not.toContain("create_issue")
  })

  it("pins only catalogued reads", () => {
    expect(PINNED).toEqual(["get_me", "issue_read", "pull_request_read"])
    for (const name of PINNED) expect(toolKind(name)).toBe("read")
    expect(TOOL_PREFIX).toBe("github_")
  })
})

describe("registerToolFilter", () => {
  it("records unknown GitHub tools and keeps them visible by default", async () => {
    const host = fakeTools(TOOLS)
    const filter = await registerToolFilter(host.ctx, { unknownTools: "ask", owned: () => true })
    expect(ids(host.build())).toEqual(ids(TOOLS))
    expect(filter.tools()).toEqual({ visible: 7, unknown: ["github_another_new_tool", "github_brand_new_tool"] })
  })

  it("hides unknown GitHub tools under hide, and only those", async () => {
    const host = fakeTools(TOOLS)
    const filter = await registerToolFilter(host.ctx, { unknownTools: "hide", owned: () => true })
    expect(ids(host.build())).toEqual(ids(TOOLS).filter((id) => id !== "github_brand_new_tool" && id !== "github_another_new_tool"))
    expect(filter.tools()).toEqual({ visible: 5, unknown: ["github_another_new_tool", "github_brand_new_tool"] })
  })

  it("ignores tools of other servers or plugins", async () => {
    const host = fakeTools(TOOLS)
    const filter = await registerToolFilter(host.ctx, { unknownTools: "hide", owned: () => true })
    const built = ids(host.build())
    expect(built).toContain("github_helper")
    expect(built).toContain("linear_list_issues")
    expect(filter.tools().unknown).not.toContain("github_helper")
  })

  it("removes the hidden ui_get and leaves it out of the count and the default rules", async () => {
    const host = fakeTools([...TOOLS, mcpTool("ui_get")])
    const filter = await registerToolFilter(host.ctx, { unknownTools: "ask", owned: () => true })
    expect(ids(host.build())).not.toContain("github_ui_get")
    expect(filter.tools()).toEqual({ visible: 7, unknown: ["github_another_new_tool", "github_brand_new_tool"] })
    expect(toolKind("ui_get")).toBe("read")
    expect(allReadTools()).not.toContain("ui_get")

    const notOwned = fakeTools([mcpTool("ui_get")])
    await registerToolFilter(notOwned.ctx, { unknownTools: "ask", owned: () => false })
    expect(ids(notOwned.build())).toEqual(["github_ui_get"])
  })

  it("pins the entry tools in Code Mode", async () => {
    const host = fakeTools(TOOLS)
    await registerToolFilter(host.ctx, { unknownTools: "ask", owned: () => true })
    const pinned = host.build().filter((tool) => tool.options?.pinned === true)
    expect(ids(pinned)).toEqual(["github_get_me", "github_issue_read", "github_pull_request_read"])
    expect(pinned[0]?.options).toEqual({ namespace: "github", codemode: true, pinned: true })
  })

  it("does not pin when the server turns Code Mode off", async () => {
    const host = fakeTools([mcpTool("get_me", { codemode: false })])
    await registerToolFilter(host.ctx, { unknownTools: "ask", owned: () => true })
    expect(host.build()[0]?.options).toEqual({ namespace: "github", codemode: false })
  })

  it("leaves a server named github that is not the plugin's as it is, but still counts unknown tools", async () => {
    const host = fakeTools(TOOLS)
    const filter = await registerToolFilter(host.ctx, { unknownTools: "hide", owned: () => false })
    expect(host.build()).toEqual(TOOLS)
    expect(filter.tools()).toEqual({ visible: 7, unknown: ["github_another_new_tool", "github_brand_new_tool"] })
  })

  it("disposes", async () => {
    const host = fakeTools(TOOLS)
    const filter = await registerToolFilter(host.ctx, { unknownTools: "hide", owned: () => true })
    await filter.dispose()
    expect(host.build()).toEqual(TOOLS)
  })
})
