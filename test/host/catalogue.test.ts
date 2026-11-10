// The Code Mode catalogue stock OpenCode renders for GitHub stays within 1,000 tokens (characters ÷ 4), signed out and
// signed in. A filler pin spends the engine's inline budget, so the github section is the namespace line plus any
// pinned signatures: what is sent even when other plugins fill the budget.
import "./isolate.js"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Model, Plugin, Provider } from "@opencode/plugin"
import * as z from "zod"
import { startFakeGitHub } from "./fake-github.js"
import { connected, type Host, router, signInWithToken } from "./harness.js"
import { ROOT as root, SDK_OVERRIDE } from "./isolate.js"

const SDK = join(SDK_OVERRIDE ?? fileURLToPath(new URL("../..", import.meta.url)), "node_modules", "@opencode", "sdk")
const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version
const OPENAI_COMPATIBLE = ["@opencode", "ai", "providers", "openai-compatible"].join("/")
setDefaultTimeout(120_000)
const tokens = (text: string) => Math.round(text.length / 4)

/** The part of the host client this test calls. */
interface Catalogue {
  close(): Promise<void>
  session: { create(input: unknown): Promise<{ id: string }>; prompt(input: unknown): Promise<unknown> }
}

function startMock() {
  let captured = ""
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model", owned_by: "mock" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = await request.json() as { messages?: { role: string; content?: unknown }[] }
      captured = (body.messages ?? []).filter(message => message.role === "system").map(message => typeof message.content === "string" ? message.content : "").join("\n\n")
      return new Response(new ReadableStream({
        start(controller) {
          const send = (line: string) => controller.enqueue(new TextEncoder().encode(line))
          send(chunk({ role: "assistant", content: "" }))
          send(chunk({ content: "ok" }))
          send(chunk({}, "stop"))
          send("data: [DONE]\n\n")
          controller.close()
        },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => void server.stop(true), text: () => captured }
}

/** The github section of a system prompt: its header line and the indented lines under it. */
function githubSection(prompt: string): string {
  const lines = prompt.split("\n")
  const start = lines.findIndex(line => line.startsWith("- github ("))
  const taken = start < 0 ? [] : [lines[start]!]
  for (let i = start + 1; i < lines.length && lines[i]!.startsWith("  "); i++) taken.push(lines[i]!)
  return taken.join("\n")
}

describe("the Code Mode catalogue", () => {
  /**
   * Starts a host with GitHub, a filler and a mock model, prompts it once, and returns the github section the model
   * received. Signed in, GitHub's MCP server is the fake, so the section lists the tools that sign-in reaches.
   */
  async function renderGithub(signedIn: boolean): Promise<{ text: string; prompt: string }> {
    // Another file's cleanup may have restored the native fetch in this process, so route again before any request.
    router.install()
    const mock = startMock()
    const fake = signedIn ? startFakeGitHub() : undefined
    const mockOrigin = new URL(mock.baseURL).origin
    router.target = fake?.origin ?? mockOrigin
    router.loopback = mockOrigin
    let host: Catalogue | undefined
    try {
      const pluginPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url))
      const github = (await import(pathToFileURL(pluginPath).href)).default as Plugin.Plugin
      const filler = Plugin.define({
        id: "github.catalogue.filler",
        async setup(ctx) {
          const providerID = Provider.ID.make("mock")
          await ctx.provider.transform(editor => {
            editor.add({
              info: { ...Provider.Info.empty(providerID), name: "Mock", activation: "enabled", package: OPENAI_COMPATIBLE, settings: { baseURL: mock.baseURL, apiKey: "mock" } } as never,
              models: [{ ...Model.Info.default(providerID, Model.ID.make("m1")), name: "Mock 1" }],
            })
          })
          await ctx.model.transform(editor => editor.default.set("mock", "m1"))
          await ctx.tool.transform(editor => {
            editor.namespace({ name: "filler", description: "Spends the catalogue budget." })
            editor.add({
              name: "pad",
              description: "pad",
              input: z.object({ note: z.string().describe("x".repeat(9000)) }),
              options: { namespace: "filler", permission: "filler_pad", pinned: true },
              execute: async () => ({ content: "ok" }),
            } as never)
          })
        },
      })
      const work = join(root, fake ? "catalogue-signed-in" : "catalogue-work")
      mkdirSync(work, { recursive: true })
      const { OpenCode } = await import(pathToFileURL(join(SDK, "dist", "index.js")).href) as typeof import("@opencode/sdk")
      host = (await OpenCode.create({
        plugins: [github, filler],
        app: { version: HOST_VERSION },
        config: {
          content: JSON.stringify({ providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } } }),
          directory: join(root, fake ? "catalogue-signed-in-config" : "catalogue-config"),
          project: false,
          claude: false,
        },
        database: { path: join(root, fake ? "catalogue-signed-in.db" : "catalogue.db") },
        models: { fetch: false },
        fs: { filewatcher: false },
        log: { level: "error" },
      } as never)) as unknown as Catalogue
      const location = { directory: work }
      if (fake) {
        // The sign-in helpers read only the client and the location.
        const handle = { client: host, location } as unknown as Host
        await signInWithToken(handle)
        await connected(handle)
      }
      const session = await host.session.create({ location, agent: "build" })
      await host.session.prompt({ sessionID: session.id, text: "Reply with ok." })
      const deadline = Date.now() + 30_000
      while (!mock.text().includes("- github (") && Date.now() < deadline) await Bun.sleep(50)
      return { text: githubSection(mock.text()), prompt: mock.text() }
    } finally {
      router.target = undefined
      router.loopback = undefined
      await host?.close().catch(() => undefined)
      await fake?.close()
      mock.stop()
    }
  }

  test("the github section is at most 1,000 tokens", async () => {
    const { text, prompt } = await renderGithub(false)
    expect(text.startsWith("- github ("), prompt.slice(0, 600)).toBe(true)
    expect(tokens(text)).toBeLessThanOrEqual(1000)
    expect(text).toContain("github-pr-review")
  })

  test("signed in, the github section is at most 1,000 tokens and its header counts the tools", async () => {
    const { text, prompt } = await renderGithub(true)
    expect(text, prompt.slice(0, 600)).toMatch(/^- github \(\d+ tools, none shown\)/)
    expect(tokens(text)).toBeLessThanOrEqual(1000)
    expect(text).toContain("github-pr-review")
  })
})
