// Test-only plugin for the stock host test, configured after github.platform so its MCP transform runs later. GitHub's
// MCP URL is fixed, and a stock binary cannot have its fetch routed, so the probe points the github server the plugin
// registered at the loopback fake, keeping the plugin's own X-MCP headers and adding the fixture token. The plugin
// has already seen no other server named github, so it still owns the server: its tool filter and the tools RPC treat
// the server as theirs, as they do GitHub's.
import { Plugin } from "@opencode/plugin"

interface ProbeOptions {
  /** The fake's MCP endpoint. */
  readonly url: string
  /** The fixture token the fake accepts. */
  readonly token: string
}

export default Plugin.define({
  id: "github.test.stock-probe",
  async setup(ctx) {
    const options = ctx.options as unknown as ProbeOptions
    await ctx.mcp.transform((editor) => {
      const registered = editor.get("github") as { readonly headers?: Record<string, string> } | undefined
      if (registered === undefined) return
      editor.set("github", { type: "remote", url: options.url, oauth: false, headers: { ...registered.headers, Authorization: `Bearer ${options.token}` } })
    })
  },
})
