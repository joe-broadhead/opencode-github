// The Code Mode catalogue stock OpenCode renders for GitHub stays within 1,000 tokens (characters ÷ 4).
// A filler pin spends the engine's inline budget, so the github section is the namespace line plus any
// pinned signatures: what is sent even when other plugins fill the budget.
import "./isolate.js"
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Model, Plugin, Provider } from "@opencode/plugin"
import * as z from "zod"
import { router } from "./harness.js"
import { ROOT as root, SDK_OVERRIDE } from "./isolate.js"

const SDK = join(SDK_OVERRIDE ?? fileURLToPath(new URL("../..", import.meta.url)), "node_modules", "@opencode", "sdk")
const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version
const OPENAI_COMPATIBLE = ["@opencode", "ai", "providers", "openai-compatible"].join("/")
setDefaultTimeout(120_000)
const tokens = (text: string) => Math.round(text.length / 4)

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

describe("the Code Mode catalogue", () => {
  const mock = startMock()
  let client: { close: () => Promise<void> } | undefined

  afterAll(async () => {
    router.target = undefined
    await client?.close().catch(() => undefined)
    mock.stop()
  })

  test("the github section is at most 1,000 tokens", async () => {
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
    const work = join(root, "catalogue-work")
    mkdirSync(work, { recursive: true })
    router.target = new URL(mock.baseURL).origin
    const { OpenCode } = await import(pathToFileURL(join(SDK, "dist", "index.js")).href) as typeof import("@opencode/sdk")
    const host = await OpenCode.create({
      plugins: [github, filler],
      app: { version: HOST_VERSION },
      config: {
        content: JSON.stringify({ providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } } }),
        directory: join(root, "catalogue-config"),
        project: false,
        claude: false,
      },
      database: { path: join(root, "catalogue.db") },
      models: { fetch: false },
      fs: { filewatcher: false },
      log: { level: "error" },
    } as never)
    client = host as { close: () => Promise<void> }
    const session = await (host as { session: { create: (input: unknown) => Promise<{ id: string }>; prompt: (input: unknown) => Promise<unknown> } }).session.create({ location: { directory: work }, agent: "build" })
    await (host as { session: { prompt: (input: unknown) => Promise<unknown> } }).session.prompt({ sessionID: session.id, text: "Reply with ok." })
    const deadline = Date.now() + 30_000
    while (!mock.text().includes("- github (") && Date.now() < deadline) await Bun.sleep(50)
    const lines = mock.text().split("\n")
    const start = lines.findIndex(line => line.startsWith("- github ("))
    const taken = start < 0 ? [] : [lines[start]!]
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith("  "); i++) taken.push(lines[i]!)
    const text = taken.join("\n")
    expect(text.startsWith("- github ("), mock.text().slice(0, 600)).toBe(true)
    expect(tokens(text)).toBeLessThanOrEqual(1000)
    expect(text).toContain("github-pr-review")
  }, 120_000)
})
