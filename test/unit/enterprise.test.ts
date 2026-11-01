import { describe, expect, it } from "vitest"
import { endpoints, loadOptions } from "../../src/config.js"
import { ENTERPRISE_INTEGRATION_ID, registerEnterpriseAuth } from "../../src/enterprise.js"
import { DEVICE_METHOD_ID, TOKEN_METHOD_ID } from "../../src/sign-in.js"

type Ctx = Parameters<typeof registerEnterpriseAuth>[0]
type Recorded = { name?: string; methods: Array<{ id?: string; type: string; label?: string }>; urls: Map<string, () => Promise<{ url: string }>> }

function fakeIntegrations() {
  const transforms: Array<(editor: unknown) => void> = []
  const ctx = {
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback)
        return { dispose: async () => void transforms.splice(transforms.indexOf(callback), 1) }
      },
    },
  } as unknown as Ctx
  const build = () => {
    const recorded = new Map<string, Recorded>()
    const entry = (id: string) => {
      const value: Recorded = recorded.get(id) ?? { methods: [], urls: new Map() }
      recorded.set(id, value)
      return value
    }
    const editor = {
      update: (id: string, update: (ref: { id: string; name: string }) => void) => {
        const ref = { id, name: id }
        update(ref)
        entry(id).name = ref.name
      },
      method: {
        update: (input: { integrationID: string; method: { id?: string; type: string; label?: string }; authorize?: () => Promise<{ url: string }> }) => {
          entry(input.integrationID).methods.push(input.method)
          if (input.method.id && input.authorize) entry(input.integrationID).urls.set(input.method.id, input.authorize)
        },
      },
    }
    for (const transform of transforms) transform(editor)
    return recorded
  }
  return { ctx, build, transforms }
}

describe("registerEnterpriseAuth", () => {
  it("creates the GitHub Enterprise integration with token sign-in on the server", async () => {
    const host = fakeIntegrations()
    const options = loadOptions({ host: "ghe.example.com" })
    const auth = await registerEnterpriseAuth(host.ctx, { scopes: options.scopes, endpoints: endpoints(options) })
    const integration = host.build().get(ENTERPRISE_INTEGRATION_ID)!
    expect(auth.integrationID()).toBe("github-enterprise")
    expect(integration.name).toBe("GitHub Enterprise")
    expect(integration.methods.map((method) => method.id)).toEqual([TOKEN_METHOD_ID])
    expect((await integration.urls.get(TOKEN_METHOD_ID)!()).url).toMatch(/^https:\/\/ghe\.example\.com\/settings\/personal-access-tokens\/new\?/)
    await auth.dispose()
    expect(host.transforms).toEqual([])
  })

  it("adds device sign-in with the server's client ID", async () => {
    const host = fakeIntegrations()
    const options = loadOptions({ host: "ghe.example.com", clientId: "Iv1.enterprise" })
    const auth = await registerEnterpriseAuth(host.ctx, { clientId: options.clientId!, scopes: options.scopes, endpoints: endpoints(options) })
    expect(host.build().get(ENTERPRISE_INTEGRATION_ID)!.methods.map((method) => method.id)).toEqual([DEVICE_METHOD_ID, TOKEN_METHOD_ID])
    await auth.dispose()
  })
})
