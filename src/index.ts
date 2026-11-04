// The server part: registers GitHub's MCP server, sign-in on its integration, default
// permission rules, the tool catalog filter, the github_api tool, status, the tools RPC for
// scripts and skills. With the host option (GitHub Enterprise Server) there is no MCP server:
// the sign-in moves to the plugin's own integration and github_api is the tool. Everything goes
// through public OpenCode plugin APIs; nothing is stored.
import { Plugin } from "@opencode/plugin"
import { scriptApi } from "./api/script.js"
import { registerApiTool } from "./api/tool.js"
import { registerAuth } from "./auth.js"
import { endpoints, loadOptions } from "./config.js"
import { ENTERPRISE_NAME, registerEnterpriseAuth } from "./enterprise.js"
import { checkHost } from "./host-version.js"
import { registerToolsRpc } from "./host/tools-rpc.js"
import { observeMcp, registerMcp } from "./mcp.js"
import { registerPermissionDefaults } from "./permissions.js"
import { SERVER_NAME } from "./rpc.js"
import { registerSignInStatus } from "./sign-in-status.js"
import { registerSkills } from "./skills.js"
import { type StatusDeps, registerStatus } from "./status.js"
import { registerToolFilter, unavailableDetail } from "./tools.js"

type Registration = { dispose(): Promise<void> }

export default Plugin.define({
  id: "github.platform",
  async setup(ctx) {
    const options = loadOptions(ctx.options)
    const hostWarning = checkHost(ctx.app.version, options.allowUntestedHost)
    const registrations: Registration[] = []
    const keep = <R extends Registration>(registration: R): R => {
      registrations.push(registration)
      return registration
    }
    const cleanup = async () => {
      for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    }
    try {
      keep(await registerPermissionDefaults(ctx))
      const api = endpoints(options)
      const signIn = { ...(options.clientId ? { clientId: options.clientId } : {}), scopes: options.scopes, endpoints: api }
      let source: Pick<StatusDeps, "conflict" | "integrationID" | "tools" | "enterprise">
      // Whether the github server is this plugin's, for the tools RPC.
      let managed: () => boolean
      if (options.host) {
        // GitHub Enterprise Server: no hosted MCP server, so the sign-in lives on the plugin's own integration.
        const auth = keep(await registerEnterpriseAuth(ctx, signIn))
        source = { conflict: () => false, integrationID: auth.integrationID, tools: () => ({ visible: 0, unknown: [] }), enterprise: options.host }
        // No server of its own: GitHub's MCP methods are unavailable, and another server named github is not called.
        const other = keep(await observeMcp(ctx))
        managed = () => other.conflict() === false
      } else {
        // The MCP registration comes later; its conflict state is read lazily.
        let conflict: () => boolean | undefined = () => undefined
        const tools = keep(await registerToolFilter(ctx, { unknownTools: options.unknownTools, owned: () => conflict() === false }))
        const mcp = keep(await registerMcp(ctx, options))
        conflict = mcp.conflict
        managed = () => mcp.conflict() === false
        const auth = keep(await registerAuth(ctx, { ...signIn, serverName: SERVER_NAME, conflict: mcp.conflict }))
        keep(await registerSignInStatus(ctx, { serverName: SERVER_NAME, integrationID: auth.integrationID }))
        source = { conflict: mcp.conflict, integrationID: auth.integrationID, tools: tools.tools }
      }
      const apiTool = keep(
        await registerApiTool(ctx, {
          readOnly: options.readOnly,
          endpoints: api,
          service: options.host ? ENTERPRISE_NAME : "GitHub",
          enterprise: options.host !== undefined,
          deviceSignIn: options.clientId !== undefined,
          root: ctx.location.directory,
          integrationID: source.integrationID,
        }),
      )
      keep(
        await registerStatus(ctx, {
          options,
          hostVersion: ctx.app.version,
          ...(hostWarning ? { hostWarning } : {}),
          ...source,
        }),
      )
      // Scripts call the known reads and github_api's reads with no model, as a session and its agent. A read GitHub
      // does not list gets describe's detail: its toolset, and whether the toolsets option turns that on.
      const stopTools = await registerToolsRpc(ctx, {
        mcp: {
          server: SERVER_NAME,
          managed: () => managed(),
          unavailableDetail: (method, code) => (code === "TOOL_UNAVAILABLE" ? unavailableDetail(method, options.toolsets) : undefined),
        },
        owned: [scriptApi(apiTool, api)],
      })
      keep({ dispose: stopTools })
      keep(await registerSkills(ctx))
    } catch (error) {
      await cleanup().catch(() => undefined)
      throw error
    }
    return cleanup
  },
})
