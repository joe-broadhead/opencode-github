// The two GitHub sign-in methods: device flow with an OAuth App (no client secret) and a
// pasted personal access token. Both store an oauth-type credential labelled with the
// GitHub login. They attach to the github MCP server's integration (src/auth.ts) or, on
// GitHub Enterprise Server, to the plugin's own integration (src/enterprise.ts).
import type { Credential, Plugin } from "@opencode/plugin"
import type { Endpoints } from "./config.js"
import { type Fetch, fetchLogin, pollAccessToken, requestDeviceCode } from "./device-flow.js"
import { GitHubPluginError } from "./errors.js"
import { TOKEN_PERMISSIONS } from "./token-permissions.js"

export const DEVICE_METHOD_ID = "github-device"
export const TOKEN_METHOD_ID = "github-token"

const TOKEN_PATTERN = /^(github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{36,255})$/
const DEVICE_CODE_TIMEOUT_MS = 10_000

export type IntegrationEditor = Parameters<Parameters<Plugin.Context["integration"]["transform"]>[0]>[0]
type Authorization = Awaited<ReturnType<Extract<Parameters<IntegrationEditor["method"]["update"]>[0], { authorize: unknown }>["authorize"]>>

export type SignInInput = {
  /** The OAuth App for device sign-in; without it only the token method is offered. */
  readonly clientId?: string
  readonly scopes: readonly string[]
  readonly endpoints: Endpoints
}

export function isOwnMethod(id: string): boolean {
  return id === DEVICE_METHOD_ID || id === TOKEN_METHOD_ID
}

/** The sign-in methods; `stopped` ends every attempt still running. */
export function signIn(input: SignInInput, stopped: AbortSignal): { attach(editor: IntegrationEditor, id: string): void } {
  // Late-bound so the host's fetch is used, as it is at call time.
  const send: Fetch = (url, init) => fetch(url, init)
  const endpoints = input.endpoints
  const tokenPage = `${endpoints.web}/settings/personal-access-tokens/new?${new URLSearchParams({
    name: "OpenCode GitHub",
    description: "Used by the OpenCode GitHub plugin.",
    ...Object.fromEntries(Object.keys(TOKEN_PERMISSIONS).map((key) => [key, "read"])),
  })}`
  let devicePoll: AbortController | undefined

  const deviceAuthorize = async (clientId: string): Promise<Authorization> => {
    const code = await requestDeviceCode({
      clientId,
      scopes: input.scopes,
      signal: AbortSignal.any([stopped, AbortSignal.timeout(DEVICE_CODE_TIMEOUT_MS)]),
      fetch: send,
      endpoints,
    })
    // One device sign-in at a time: a new attempt stops polling for the previous code.
    devicePoll?.abort()
    const poll = new AbortController()
    devicePoll = poll
    const signal = AbortSignal.any([stopped, poll.signal])
    const callback = (async (): Promise<Credential.OAuth> => {
      const token = await pollAccessToken({
        clientId,
        deviceCode: code.deviceCode,
        interval: code.interval,
        expiresAt: code.expiresAt,
        signal,
        fetch: send,
        endpoints,
      })
      const login = await fetchLogin(token.accessToken, { signal, fetch: send, endpoints })
      return oauthCredential(DEVICE_METHOD_ID, token.accessToken, {
        refresh: token.refreshToken ?? "",
        expires: token.expiresIn ? Date.now() + token.expiresIn * 1000 : 0,
        metadata: { tokenType: "Bearer", scope: token.scope, login },
      })
    })()
    // The host may stop waiting (cancel, expiry); a superseded or disposed poll must not reject unobserved.
    callback.catch(() => undefined)
    return {
      url: code.verificationUri,
      instructions: `Enter code ${code.userCode} on GitHub to finish signing in.`,
      expiresAt: code.expiresAt,
      mode: "auto",
      callback,
    }
  }

  const tokenAuthorize = async (): Promise<Authorization> => ({
    url: tokenPage,
    instructions:
      `Create a fine-grained token for the repositories you want, with read access to ${Object.values(TOKEN_PERMISSIONS).join(", ")} (the page fills these in), then paste it here.`,
    mode: "code",
    callback: async (code: string) => {
      const token = code.trim()
      if (!TOKEN_PATTERN.test(token)) {
        throw new GitHubPluginError("TOKEN_FORMAT", "That does not look like a GitHub personal access token.", "Paste a token that starts with github_pat_ or ghp_.")
      }
      const login = await fetchLogin(token, { signal: stopped, fetch: send, endpoints })
      return oauthCredential(TOKEN_METHOD_ID, token, { refresh: "", expires: 0, metadata: { tokenType: "Bearer", login } })
    },
  })

  const label = (credential: Credential.OAuth) => {
    const login = credential.metadata?.login
    return typeof login === "string" ? login : undefined
  }

  return {
    attach(editor, id) {
      const clientId = input.clientId
      if (clientId) {
        editor.method.update({
          integrationID: id,
          method: { id: DEVICE_METHOD_ID, type: "oauth", label: "Sign in with GitHub" },
          authorize: () => deviceAuthorize(clientId),
          label,
        })
      }
      editor.method.update({
        integrationID: id,
        method: { id: TOKEN_METHOD_ID, type: "oauth", label: "Use a fine-grained personal access token" },
        authorize: tokenAuthorize,
        label,
      })
    },
  }
}

function oauthCredential(
  methodID: string,
  access: string,
  rest: { refresh: string; expires: number; metadata: Record<string, unknown> },
): Credential.OAuth {
  // The host brands methodID when it stores the credential.
  return { type: "oauth", methodID: methodID as Credential.OAuth["methodID"], access, ...rest }
}
