// Renders the built TUI part (dist/tui.js) with OpenTUI's test renderer on a fake TUI
// context. Run it through `npm run test:tui`, which builds first.
//
// OpenTUI's preload makes Bun load Solid's reactive client build instead of its server build.
// It has to run before anything imports Solid, so the fake and the build are imported below.
import "@opentui/solid/preload"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin/tui"
import type { Status } from "../../src/rpc.js"
import { jargonIn } from "../unit/jargon.js"

const DIST = new URL("../../dist/tui.js", import.meta.url)
if (!existsSync(fileURLToPath(DIST))) throw new Error("dist/tui.js is missing. Run npm run build first.")
const { DEFAULT_LOCATION, LOCATION, fakeContext, settle } = await import("./fake.js")
const plugin = ((await import(DIST.href)) as { default: Plugin.Definition }).default

const UNAVAILABLE = "GitHub status unavailable. Run /github-status for details."
/** A rendered row: the label in its 28-character column, then the value. */
const row = (label: string, value: string) => `${label.padEnd(28)} ${value}`

const needsAuth: Status = {
  version: "0.0.2",
  state: "sign_in_required",
  access: "read-only",
  toolsets: ["context", "repos", "issues", "pull_requests"],
  tools: { visible: 26, unknown: [], mode: "ask" },
  unguardedAgents: [],
  host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
  nextStep: "Run /connect and choose GitHub.",
}

const connected: Status = {
  ...needsAuth,
  state: "connected",
  account: "octocat",
  nextStep: "Nothing to do.",
}

const harnesses: ReturnType<typeof fakeContext>[] = []

/** Sets the plugin up on a fake context; the host renders a dialog when it is shown. */
async function setUp(options = { location: LOCATION as typeof LOCATION | undefined }) {
  const fake = fakeContext(options)
  harnesses.push(fake)
  const cleanup = await plugin.setup(fake.context as unknown as Plugin.Context)
  if (!cleanup) throw new Error("setup returned no cleanup")
  return { ...fake, cleanup }
}

/** Sets the plugin up and opens the view through its command. */
async function open(options?: Parameters<typeof setUp>[0]) {
  const view = await setUp(options)
  await view.command("github.status").run()
  await view.frame()
  return view
}

/** Answers the latest status call and returns the rendered frame. */
async function answer(view: Awaited<ReturnType<typeof open>>, outcome: { readonly status?: unknown; readonly error?: unknown }) {
  const call = view.calls.at(-1)
  if (!call) throw new Error("no status call")
  if ("error" in outcome) call.reject(outcome.error)
  else call.resolve(outcome.status)
  await settle()
  return view.frame()
}

afterEach(() => {
  for (const fake of harnesses.splice(0)) fake.dialog.screen?.renderer.destroy()
})

describe("GitHub TUI status view", () => {
  test("setup registers the palette entry and /github, and neither listens nor sends", async () => {
    const view = await setUp()
    expect(plugin.id).toBe("github.platform.tui")
    expect(view.command("github.status")).toMatchObject({ title: "GitHub: Status", group: "GitHub", palette: true, slash: { name: "github" } })
    expect(view.layerOf("github.status")?.mode).toBe("global")
    expect(view.subscribed()).toEqual([])
    expect(view.dialog.open).toBeUndefined()
    expect(view.calls).toHaveLength(0)
  })

  test("opening it shows loading, then asks the status method with {} for the current location", async () => {
    const view = await open()
    expect(view.dialog.size).toBe("large")
    const frame = await view.frame()
    expect(frame).toContain("GitHub status")
    expect(frame).toContain("Loading GitHub status…")
    expect(frame).toContain("r refresh · esc close")
    expect(view.subscribed().sort()).toEqual(["agent.updated", "credential.switched", "credential.updated", "integration.updated", "mcp.status.changed", "server.connected"])
    expect(view.calls).toHaveLength(1)
    expect(view.calls[0]).toMatchObject({ rpcID: "github.platform", input: {}, options: { location: LOCATION } })
    expect(view.calls[0]?.options.signal).toBeInstanceOf(AbortSignal)
  })

  test("falls back to the default location when the TUI has none", async () => {
    const view = await open({ location: undefined })
    expect(view.calls[0]?.options.location).toEqual(DEFAULT_LOCATION)
  })

  test("renders sign_in_required with the /connect next step, and every row", async () => {
    const view = await open()
    const frame = await answer(view, { status: needsAuth })
    expect(frame).not.toContain("Loading")
    expect(frame).toContain(row("Connection", "sign-in required"))
    expect(frame).toContain(row("Account", "none"))
    expect(frame).toContain(row("Access", "reads run without asking; every change and every new tool is denied"))
    expect(frame).toContain(row("Toolsets", "context, repos, issues, pull_requests"))
    expect(frame).toContain(row("Host", "github.com"))
    expect(frame).toContain(row("Tools", "26 available"))
    expect(frame).toContain(row("OpenCode", "2.2.3 (tested)"))
    expect(frame).toContain(row("Next step", "Run /connect and choose GitHub"))
    expect(frame).toContain(row("Agents without default rules", "none"))
    expect(frame).not.toContain("rules below")
    const order = ["Connection", "Account", "Access", "Toolsets", "Host", "Tools ", "Agents without default rules", "OpenCode", "Next step"].map((text) => frame.indexOf(text))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(jargonIn(frame)).toEqual([])
  })

  test("an mcp.status.changed event for github re-renders it connected with the account", async () => {
    const view = await open()
    await answer(view, { status: needsAuth })
    view.emit("mcp.status.changed", { server: "slack" })
    expect(view.calls).toHaveLength(1)
    view.emit("mcp.status.changed", { server: "github" })
    expect(view.calls).toHaveLength(2)
    const frame = await answer(view, { status: connected })
    expect(frame).toContain(row("Connection", "connected"))
    expect(frame).toContain(row("Account", "octocat"))
    expect(frame).toContain(row("Next step", "Nothing to do."))
    expect(frame).not.toContain("sign-in required")
  })

  test("integration, credential, agent and server.connected events refresh it", async () => {
    const view = await open()
    await answer(view, { status: needsAuth })
    for (const type of ["integration.updated", "credential.updated", "credential.switched", "agent.updated", "server.connected"]) view.emit(type)
    expect(view.calls).toHaveLength(6)
    // Each refresh replaces the one before it.
    expect(view.calls.slice(1, 5).map((call) => call.options.signal?.aborted)).toEqual([true, true, true, true])
    expect(view.calls[5]?.options.signal?.aborted).toBe(false)
  })

  test("renders write access, unknown tools, unguarded agents with their rules, then the host warning", async () => {
    const view = await open()
    const frame = await answer(view, {
      status: {
        ...connected,
        access: "all",
        tools: { visible: 27, unknown: ["github_new_a", "github_new_b"], mode: "ask" },
        unguardedAgents: ["reviewer"],
        permissionsBlock: [
          { action: "github_*", resource: "*", effect: "ask" },
          { action: "github_get_me", resource: "*", effect: "allow" },
        ],
        host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false },
        hostWarning: "OpenCode 2.3.0 is outside the tested range.",
      } satisfies Status,
    })
    expect(frame).toContain(row("Access", "every tool runs without asking, reads and new tools included"))
    expect(frame).toContain(row("Tools", "27 available, 2 unknown (allowed by github_*): github_new_a, github_new_b"))
    expect(frame).toContain(row("Agents without default rules", "reviewer"))
    expect(frame).not.toContain("rules below")
    expect(frame).toContain('{"action":"github_*","resource":"*","effect":"ask"},')
    expect(frame).toContain('{"action":"github_get_me","resource":"*","effect":"allow"}')
    expect(frame).toContain(row("OpenCode", "2.3.0 (untested: OpenCode 2.3.0 is outside the tested range.)"))
    const order = ["Connection", "Account", "Access", "Tools ", "Agents without default rules", "github_get_me", "OpenCode", "Next step"].map((text) => frame.indexOf(text))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(jargonIn(frame)).toEqual([])
  })

  test("on GitHub Enterprise Server, says only github_api works", async () => {
    const view = await open()
    const frame = await answer(view, { status: { ...connected, enterprise: "ghe.example.com", tools: { visible: 0, unknown: [], mode: "ask" } } satisfies Status })
    expect(frame).toContain(row("Host", "ghe.example.com (GitHub Enterprise Server)"))
    expect(frame).toContain(row("Tools", "github_api only. GitHub's hosted MCP tools do not support GitHub"))
  })

  test("says when unknown tools are hidden", async () => {
    const view = await open()
    const frame = await answer(view, { status: { ...connected, tools: { visible: 1, unknown: ["github_new_a"], mode: "hide" } } satisfies Status })
    expect(frame).toContain(row("Tools", "1 available, 1 unknown (hidden): github_new_a"))
  })

  test.each([
    ["a declared unavailable error", { type: "unavailable", message: "GitHub status is unavailable right now. secret-detail", data: { reason: "secret-detail" } }],
    ["a thrown error", new Error("fetch failed: ECONNREFUSED 127.0.0.1:4096 secret-detail")],
  ])("%s renders the generic unavailable text, never the error", async (_name, error) => {
    const view = await open()
    const frame = await answer(view, { error })
    expect(frame).toContain(UNAVAILABLE)
    expect(frame).not.toContain("secret-detail")
    expect(frame).not.toContain("ECONNREFUSED")
    expect(frame).not.toContain("Loading")
  })

  test("an answer that does not match the status contract renders as unavailable", async () => {
    const view = await open()
    const frame = await answer(view, { status: { ...connected, state: "busy", token: "secret-detail" } })
    expect(frame).toContain(UNAVAILABLE)
    expect(frame).not.toContain("secret-detail")
  })

  test("r sends a new request, keeps the last status while it loads and drops a superseded answer", async () => {
    const view = await open()
    await answer(view, { status: needsAuth })
    expect(view.layerOf("r")?.mode).toBe("modal")
    await view.command("r").run()
    expect(view.calls).toHaveLength(2)
    let frame = await view.frame()
    expect(frame).toContain("refreshing…")
    expect(frame).toContain("sign-in required")
    await view.command("r").run()
    expect(view.calls).toHaveLength(3)
    expect(view.calls[1]?.options.signal?.aborted).toBe(true)
    // A late answer to the superseded request is ignored.
    view.calls[1]?.resolve(connected)
    await settle()
    expect(await view.frame()).toContain("sign-in required")
    frame = await answer(view, { status: connected })
    expect(frame).toContain(row("Connection", "connected"))
    expect(frame).not.toContain("refreshing…")
  })

  test("a refresh that fails after a good answer shows the unavailable text", async () => {
    const view = await open()
    await answer(view, { status: connected })
    await view.command("r").run()
    const frame = await answer(view, { error: new Error("boom") })
    expect(frame).toContain(UNAVAILABLE)
    expect(frame).not.toContain("octocat")
    expect(frame).not.toContain("boom")
  })

  test("events while the view is closed send nothing", async () => {
    const view = await setUp()
    view.emit("mcp.status.changed", { server: "github" })
    view.emit("integration.updated")
    expect(view.calls).toHaveLength(0)
  })

  test("esc closes the view, aborts its request, removes its keys and stops refreshing", async () => {
    const view = await open()
    expect(view.hasCommand("r")).toBe(true)
    await view.command("escape").run()
    expect(view.dialog.open).toBeUndefined()
    expect(view.calls[0]?.options.signal?.aborted).toBe(true)
    expect(view.hasCommand("r")).toBe(false)
    expect(view.hasCommand("escape")).toBe(false)
    expect(view.hasCommand("github.status")).toBe(true)
    expect(view.subscribed()).toEqual([])
    view.emit("mcp.status.changed", { server: "github" })
    expect(view.calls).toHaveLength(1)
  })

  test("opening it again while it is open starts over with a fresh request", async () => {
    const view = await open()
    await answer(view, { status: connected })
    await view.command("github.status").run()
    expect(view.calls).toHaveLength(2)
    expect(await view.frame()).toContain("Loading GitHub status…")
    await answer(view, { status: needsAuth })
    view.emit("integration.updated")
    expect(view.calls).toHaveLength(3)
  })

  test("cleanup aborts the last request, unsubscribes and closes the view", async () => {
    const view = await open()
    await answer(view, { status: needsAuth })
    await view.command("r").run()
    await view.cleanup()
    expect(view.calls[1]?.options.signal?.aborted).toBe(true)
    expect(view.subscribed()).toEqual([])
    expect(view.dialog.open).toBeUndefined()
  })

  test("running the command after cleanup sends no request", async () => {
    const view = await setUp()
    await view.cleanup()
    await view.command("github.status").run()
    expect(view.dialog.open).toBeUndefined()
    expect(view.calls).toHaveLength(0)
  })
})
