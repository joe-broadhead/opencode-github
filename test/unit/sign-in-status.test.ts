import { describe, expect, it } from "vitest"
import { REJECTED_MESSAGE, registerSignInStatus } from "../../src/sign-in-status.js"

type Ctx = Parameters<typeof registerSignInStatus>[0]
type ServerStatus = "connected" | "needs_auth" | "failed"
type Report = { integrationID: string; connection: { id: string }; status: unknown }

const ID = "mcp_0123456789abcdef"
const LOCATION = { directory: "/workspace" }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeHost(input: { server: ServerStatus; credential?: boolean }) {
  let server = input.server
  let reported: unknown
  const reports: Report[] = []
  const listeners = new Set<(server: string) => void>()
  const ctx = {
    mcp: { list: async () => ({ location: LOCATION, data: [{ name: "github", status: { status: server }, integrationID: ID }] }) },
    integration: {
      // `active` returns the credential alone; the status the plugin sets is projected by `get`, as on the host.
      get: async () => ({
        data: {
          id: ID,
          name: "GitHub",
          connections: [{ type: "credential" as const, id: "cred_1", label: "octocat", method: "oauth" as const, ...(reported ? { status: reported } : {}) }],
        },
      }),
      connection: {
        active: async (integrationID: string) =>
          integrationID === ID && input.credential !== false
            ? { type: "credential" as const, id: "cred_1", label: "octocat", method: "oauth" as const }
            : undefined,
        status: async (report: Report) => {
          reports.push(report)
          reported = report.status
        },
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]() {
          const queue: string[] = []
          let wake: (() => void) | undefined
          const listener = (name: string) => {
            queue.push(name)
            wake?.()
          }
          listeners.add(listener)
          signal.addEventListener("abort", () => wake?.())
          return {
            next: async () => {
              while (queue.length === 0 && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve))
              if (signal.aborted) return { done: true, value: undefined }
              return { done: false, value: { type: "mcp.status.changed", data: { server: queue.shift() } } }
            },
            return: async () => {
              listeners.delete(listener)
              return { done: true, value: undefined }
            },
          }
        },
      }),
    },
  } as unknown as Ctx
  return {
    ctx,
    reports,
    listeners,
    async change(next: ServerStatus, name = "github") {
      server = next
      for (const listener of listeners) listener(name)
      await settle()
      await settle()
    },
  }
}

describe("registerSignInStatus", () => {
  it("marks the active account when GitHub rejects it, and clears the mark once github connects", async () => {
    const host = fakeHost({ server: "connected" })
    const reporter = await registerSignInStatus(host.ctx, { serverName: "github", integrationID: () => ID })
    await host.change("needs_auth")
    expect(host.reports).toEqual([
      { integrationID: ID, connection: expect.objectContaining({ id: "cred_1" }), status: { status: "needs_auth", message: REJECTED_MESSAGE } },
    ])
    await host.change("needs_auth")
    expect(host.reports).toHaveLength(1)
    await host.change("connected")
    expect(host.reports.at(-1)).toMatchObject({ integrationID: ID, status: undefined })
    expect(host.reports).toHaveLength(2)
    await reporter.dispose()
    expect(host.listeners.size).toBe(0)
  })

  it("ignores other servers, a failed connection, no account, and a server that is not this plugin's", async () => {
    const host = fakeHost({ server: "connected" })
    let owned: string | undefined = ID
    const reporter = await registerSignInStatus(host.ctx, { serverName: "github", integrationID: () => owned })
    await host.change("needs_auth", "slack")
    await host.change("failed")
    expect(host.reports).toEqual([])
    owned = undefined
    await host.change("needs_auth")
    expect(host.reports).toEqual([])
    await reporter.dispose()

    const signedOut = fakeHost({ server: "connected", credential: false })
    const other = await registerSignInStatus(signedOut.ctx, { serverName: "github", integrationID: () => ID })
    await signedOut.change("needs_auth")
    expect(signedOut.reports).toEqual([])
    await other.dispose()
  })
})
