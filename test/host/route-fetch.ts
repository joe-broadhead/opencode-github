// Replaces globalThis.fetch for this test process. OpenCode's MCP transport and the plugin
// both call the global fetch at request time, so GitHub's fixed URLs can be served by the
// loopback fake: api.githubcopilot.com (the MCP server and OAuth discovery), the device-flow
// endpoints on github.com, GitHub's REST and GraphQL API on api.github.com, and the test's
// GitHub Enterprise Server ghe.example.com. Loopback is allowed only to the fake.
// Every other request fails with EXTERNAL_FETCH_BLOCKED and is recorded, so a test can
// assert that the host never tried to leave the machine.

const ROUTED = [
  (url: URL) => url.hostname === "api.githubcopilot.com",
  (url: URL) => url.hostname === "github.com" && url.pathname.startsWith("/login/"),
  (url: URL) => url.hostname === "api.github.com",
  (url: URL) => url.hostname === "ghe.example.com",
]

export interface FetchRouter {
  /** The fake's origin while a host runs; undefined blocks GitHub too. */
  target: string | undefined
  /** A loopback origin the host may reach besides the fake, such as a mock model; undefined by default. */
  loopback: string | undefined
  /** Origins of fakes that have closed. */
  readonly retired: Set<string>
  /** The origin and path of every blocked request. */
  readonly blocked: string[]
  /** Blocked requests to a closed fake: retries a closed host had already scheduled. */
  readonly stale: string[]
  /** Puts the routing back after restore(). Another file's cleanup restores the native fetch for the whole process. */
  install(): void
  restore(): void
}

export function routeFetch(): FetchRouter {
  const original = globalThis.fetch
  const router: FetchRouter = {
    target: undefined,
    loopback: undefined,
    retired: new Set(),
    blocked: [],
    stale: [],
    install: () => {
      globalThis.fetch = installed
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
  const routed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const target = router.target
    let destination: string | undefined
    if (target && ROUTED.some((matches) => url.protocol === "https:" && matches(url))) destination = `${target}${url.pathname}${url.search}`
    else if (target && url.origin === target) destination = url.href
    else if (router.loopback !== undefined && url.origin === router.loopback) destination = url.href
    if (!destination) {
      ;(router.retired.has(url.origin) ? router.stale : router.blocked).push(`${url.origin}${url.pathname}`)
      throw new Error(`EXTERNAL_FETCH_BLOCKED: the host test does not allow requests to ${url.origin}`)
    }
    // No second hop: a redirect would leave the routed origin.
    return original(new Request(destination, request), { redirect: "error" })
  }
  const installed = Object.assign(routed, { preconnect: () => undefined }) as typeof fetch
  globalThis.fetch = installed
  return router
}
