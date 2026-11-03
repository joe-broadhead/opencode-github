// Registers GitHub's hosted MCP server under the stable name `github`. GitHub's own
// headers select the toolsets, read-only mode and lockdown. The server keeps OpenCode's
// default OAuth handling, so OpenCode registers it as an integration that the sign-in
// methods attach to. If a server named github already exists when the transform runs
// (the user's config is applied first), it is left untouched and reported as a conflict.
import type { Plugin } from "@opencode/plugin"
import { MCP_URL, type Options } from "./config.js"
import { SERVER_NAME } from "./rpc.js"

type McpContext = { readonly mcp: Pick<Plugin.Context["mcp"], "transform"> }

function serverConfig(options: Pick<Options, "toolsets" | "readOnly" | "lockdown">) {
  return {
    type: "remote" as const,
    url: MCP_URL,
    headers: {
      "X-MCP-Toolsets": options.toolsets.join(","),
      "X-MCP-Readonly": String(options.readOnly),
      ...(options.lockdown ? { "X-MCP-Lockdown": "true" } : {}),
    },
  }
}

/**
 * `conflict()` is undefined until OpenCode has applied the MCP config (after plugin setup),
 * then true while another server named github exists and false while this plugin's is used.
 */
export async function registerMcp(
  ctx: McpContext,
  options: Pick<Options, "toolsets" | "readOnly" | "lockdown">,
): Promise<{ dispose(): Promise<void>; conflict(): boolean | undefined }> {
  const config = serverConfig(options)
  let conflict: boolean | undefined
  const registration = await ctx.mcp.transform((editor) => {
    conflict = editor.get(SERVER_NAME) !== undefined
    if (!conflict) editor.set(SERVER_NAME, { ...config, headers: { ...config.headers } })
  })
  return { dispose: registration.dispose, conflict: () => conflict }
}

/**
 * With `host` (GitHub Enterprise Server) the plugin registers no server. This only records whether
 * another server named github exists, so the tools RPC never calls a server the plugin does not manage.
 */
export async function observeMcp(ctx: McpContext): Promise<{ dispose(): Promise<void>; conflict(): boolean | undefined }> {
  let conflict: boolean | undefined
  const registration = await ctx.mcp.transform((editor) => {
    conflict = editor.get(SERVER_NAME) !== undefined
  })
  return { dispose: registration.dispose, conflict: () => conflict }
}
