// GitHub Enterprise Server. GitHub's hosted MCP server does not serve it, so the plugin
// registers no MCP server there and keeps the sign-in on an integration of its own, with the
// same two methods against the server's own endpoints. github_api uses that sign-in.
import type { Plugin } from "@opencode/plugin"
import { type SignInInput, signIn } from "./sign-in.js"

export const ENTERPRISE_INTEGRATION_ID = "github-enterprise"
/** The name /connect shows; status next steps say "choose GitHub Enterprise". */
export const ENTERPRISE_NAME = "GitHub Enterprise"

type EnterpriseContext = { readonly integration: Pick<Plugin.Context["integration"], "transform"> }

export async function registerEnterpriseAuth(
  ctx: EnterpriseContext,
  input: SignInInput,
): Promise<{ dispose(): Promise<void>; integrationID(): string }> {
  const stopped = new AbortController()
  const methods = signIn(input, stopped.signal)
  const registration = await ctx.integration.transform((editor) => {
    editor.update(ENTERPRISE_INTEGRATION_ID, (integration) => {
      integration.name = ENTERPRISE_NAME
    })
    methods.attach(editor, ENTERPRISE_INTEGRATION_ID)
  })
  return {
    integrationID: () => ENTERPRISE_INTEGRATION_ID,
    async dispose() {
      stopped.abort()
      await registration.dispose()
    },
  }
}
