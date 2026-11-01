// Preloaded into a script run by a test (node --import or bun --preload), so the script runs
// unchanged: GitHub's URLs go to the loopback fake named by GITHUB_FAKE_ORIGIN, and every other
// request fails with EXTERNAL_FETCH_BLOCKED, which is also written to stderr for the test.
const origin = process.env.GITHUB_FAKE_ORIGIN
const original = globalThis.fetch
const routed = (url) =>
  url.protocol === "https:" &&
  (url.hostname === "api.githubcopilot.com" ||
    (url.hostname === "github.com" && url.pathname.startsWith("/login/")) ||
    (url.hostname === "api.github.com" && url.pathname === "/user"))

globalThis.fetch = Object.assign(
  async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (origin && routed(url)) return original(new Request(`${origin}${url.pathname}${url.search}`, request), { redirect: "error" })
    if (origin && url.origin === origin) return original(request, { redirect: "error" })
    process.stderr.write(`EXTERNAL_FETCH_BLOCKED ${url.origin}\n`)
    throw new Error(`EXTERNAL_FETCH_BLOCKED: the test does not allow requests to ${url.origin}`)
  },
  { preconnect: () => undefined },
)
