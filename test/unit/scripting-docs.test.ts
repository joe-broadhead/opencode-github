// docs/scripting.md and the README's scripting example are the contract a script author copies. Every example must use
// an RPC id and a method this plugin registers, carry the location header and the strict envelope, and name only
// fields that method accepts, so a doc example cannot drift from the code.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ApiInput } from "../../src/api/contract.js"
import { SCRIPT_API_METHOD } from "../../src/api/script.js"
import { METHODS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const FILES = ["docs/scripting.md", "README.md"]
const STATUS_RPC_ID = "github.platform"
const METHODS_BY_NAME = new Map(METHODS.map((method) => [method.name, method]))

type Example = { file: string; line: number; id: string; method: string; body: unknown; statement: string }

/** Every `opencode api post /api/rpc/<id>/<method>` call in a file, as its RPC id, method and parsed body. */
function calls(text: string): Example[] {
  const out: Example[] = []
  for (const match of text.matchAll(/opencode api post \/api\/rpc\/([A-Za-z0-9.]+)\/([A-Za-z0-9_]+)/g)) {
    const start = match.index!
    // A statement runs to the end of its fenced block or the next blank line.
    const rest = text.slice(start)
    const end = rest.search(/\n\s*\n|\n```/)
    const statement = (end === -1 ? rest : rest.slice(0, end)).trim()
    out.push({ file: "", line: text.slice(0, start).split("\n").length, id: match[1]!, method: match[2]!, body: bodyOf(statement), statement })
  }
  return out
}

/** The `-d '{…}'` body of a statement, by matching braces. */
function bodyOf(statement: string): unknown {
  const at = statement.indexOf("-d '{")
  if (at === -1) return undefined
  let depth = 0
  let inString = false
  for (let i = at + 4; i < statement.length; i++) {
    const char = statement[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(statement.slice(at + 4, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** The method's input, from the envelope's inner `input`. */
function toolInput(body: unknown): unknown {
  const envelope = (body as { input?: { input?: unknown } } | undefined)?.input
  return envelope !== undefined && "input" in envelope ? envelope.input : undefined
}

const examples = FILES.flatMap((file) => calls(readFileSync(join(ROOT, file), "utf8")).map((call) => ({ ...call, file })))
const tools = examples.filter((example) => example.id === TOOLS_RPC_ID)

describe("the scripting examples", () => {
  it("there are examples to check", () => {
    expect(tools.length).toBeGreaterThan(2)
    expect(TOOLS_RPC_ID).toBe("github.platform.tools")
  })

  it.each(examples)("$file:$line calls a registered RPC id", (example) => {
    expect([TOOLS_RPC_ID, STATUS_RPC_ID]).toContain(example.id)
  })

  it.each(tools)("$file:$line calls $method with this plugin's RPC id and a real method", (example) => {
    expect(example.statement).toContain(`/api/rpc/${TOOLS_RPC_ID}/`)
    expect(example.method === "describe" || METHODS_BY_NAME.has(example.method) || example.method === SCRIPT_API_METHOD).toBe(true)
  })

  it.each(examples)("$file:$line sends the location header", (example) => {
    expect(example.statement).toContain('-H "x-opencode-directory:$PWD"')
  })

  it.each(tools)("$file:$line sends the strict envelope", (example) => {
    const envelope = (example.body as { input?: Record<string, unknown> } | undefined)?.input
    expect(envelope).toBeDefined()
    // `describe` takes nothing, or a session; every other method takes the session and the tool's input.
    const keys = Object.keys(envelope!).sort()
    expect(example.method === "describe" ? [["sessionID"], []] : [["input", "sessionID"]]).toContainEqual(keys)
    if (example.method !== "describe") expect(typeof envelope!["sessionID"]).toBe("string")
  })

  // `api` is the plugin's own tool, so its whole schema is here to check against. An MCP method's input is GitHub's,
  // which the plugin does not hold: the test proves the method is one it registers, and that the example is an object.
  it.each(tools.filter((example) => example.method !== "describe"))("$file:$line names only fields $method accepts", (example) => {
    const input = toolInput(example.body)
    expect(typeof input).toBe("object")
    if (example.method !== SCRIPT_API_METHOD) return
    const parsed = ApiInput.safeParse(input)
    expect(parsed.success ? null : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toBeNull()
  })
})
