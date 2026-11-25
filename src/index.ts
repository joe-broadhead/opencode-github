/**
 * The plugin's one entry: `Plugin.define({ id, setup })`, the host gate, the accounts, and one `register` call.
 *
 * `register` wires doors 1–3 from `handlers`, resolves accounts and generates the access rules. This file never calls
 * `ctx.tool`, `ctx.rpc` or `ctx.permission` itself.
 */
import { Plugin } from "@opencode/plugin"
import { redactReason } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register"
import { loadOptions, registerGithubAccounts } from "./accounts.ts"
import { handlersFor, type HandlerRuntime } from "./handlers/index.ts"
import { readSkills, registerSkills } from "./skills.ts"
import { manifest, version } from "./manifest.ts"
import { createProvider } from "./provider/client.ts"

export default Plugin.define({
  id: manifest.plugin.name,
  async setup(context) {
    assertHost(context, manifest)
    // Check every skill before anything registers, so a malformed file fails setup with one clear error.
    const skills = readSkills()

    const options = loadOptions(context.options)

    // One vendor MCP server per github.com alias, an integration of its own for an Enterprise alias, and GitHub's
    // sign-in methods on each. A failure is recorded for status, never thrown from here.
    const accounts = await registerGithubAccounts(context, { manifest, options })

    const runtime: HandlerRuntime = {
      plugin: manifest.plugin.name,
      manifest,
      version,
      hostVersion: context.app.version,
      accounts,
      provider: createProvider({
        deviceSignIn: options.clientId !== undefined,
        ...(options.appSlug === undefined ? {} : { appSlug: options.appSlug }),
      }),
      root: context.location.directory,
      clock: Date.now,
      nextStep: () => {
        const problem = accounts.problems()[0]
        return problem === undefined ? null : redactReason(problem)
      },
      statusState: { last: undefined, lastAccounts: new Map() },
    }

    try {
      const registration = await register(context, manifest, handlersFor(runtime))
      const skillRegistration = await registerSkills(context, skills)
      return async () => {
        await skillRegistration.dispose()
        await registration.dispose()
        await accounts.dispose()
      }
    } catch (error) {
      await accounts.dispose()
      throw error
    }
  },
})
