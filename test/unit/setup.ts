// Bun's toStartWith, which the shared tools RPC tests (a copy of ~/opencode-release-rpc/shared/tools-rpc.test.ts) use
// and Vitest lacks. The copy changes only its two imports, so the matcher comes from here.
import { expect } from "vitest"

declare module "vitest" {
  interface Assertion {
    toStartWith(prefix: string): void
  }
}

expect.extend({
  toStartWith(received: unknown, prefix: string) {
    const pass = typeof received === "string" && received.startsWith(prefix)
    return { pass, message: () => `expected ${JSON.stringify(received)} ${pass ? "not " : ""}to start with ${JSON.stringify(prefix)}` }
  },
})
