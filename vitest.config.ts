import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

// The build replaces __PLUGIN_VERSION__ (src/version.ts) the same way.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }

export default defineConfig({ define: { __PLUGIN_VERSION__: JSON.stringify(version) }, test: { include: ["test/unit/**/*.test.ts"] } })
