// The two GitHub sign-in methods: device flow with an OAuth App or a GitHub App (no client
// secret) and a pasted personal access token. Both store an oauth-type credential labelled
// with the GitHub login. They attach to the github MCP server's integration (src/auth.ts) or,
// on GitHub Enterprise Server, to the plugin's own integration (src/enterprise.ts).
//
// A GitHub App with expiring user tokens returns an 8-hour access token and a 6-month refresh
// token. OpenCode renews an oauth credential only through its method's `refresh`, which it calls
// whenever the credential's `expires` is within five minutes, and always for `expires: 0`. So the
// device method registers `refresh`: it renews a credential that has a refresh token and an
// expiry, and returns every other credential (an OAuth App's, which never expires) unchanged,
// without a request.
import type { Credential, Plugin } from "@opencode/plugin"
import type { Endpoints } from "./config.js"
import { type Fetch, fetchInstallationCount, fetchLogin, pollAccessToken, refreshAccessToken, requestDeviceCode, signInAgain } from "./device-flow.js"
import { GitHubPluginError } from "./errors.js"
import { installStep, isAppToken } from "./github-app.js"
import { TOKEN_PERMISSIONS } from "./token-permissions.js"

export const DEVICE_METHOD_ID = "github-device"
export const TOKEN_METHOD_ID = "github-token"

const TOKEN_PATTERN = /^(github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{36,255})$/
const DEVICE_CODE_TIMEOUT_MS = 10_000

export type IntegrationEditor = Parameters<Parameters<Plugin.Context["integration"]["transform"]>[0]>[0]
type Authorization = Awaited<ReturnType<Extract<Parameters<IntegrationEditor["method"]["update"]>[0], { authorize: unknown }>["authorize"]>>

export type SignInInput = {
  /** The OAuth App or GitHub App for device sign-in; without it only the token method is offered. */
  readonly clientId?: string
  readonly scopes: readonly string[]
  readonly endpoints: Endpoints
  /** The GitHub App's URL name, for its install link. */
  readonly appSlug?: string
  /** The name /connect shows for the sign-in: GitHub unless set. */
  readonly service?: string
}

/** What a GitHub App sign-in adds to the credential's metadata. An OAuth App's metadata has none of it. */
type AppMetadata = {
  /** Set for a GitHub App user token. */
  readonly githubApp?: true
  /** The installations the token reaches, when GitHub said; 0 means it sees no repository yet. */
  readonly installations?: number
  /** Epoch milliseconds when the refresh token expires. */
  readonly refreshExpires?: number
}

/** The installation count a credential holds, when it is a GitHub App's and GitHub said. */
export function installationsOf(credential: Pick<Credential.OAuth, "metadata">): number | undefined {
  const value = (credential.metadata as AppMetadata | undefined)?.installations
  return typeof value === "number" ? value : undefined
}

/** The note for a GitHub App sign-in that reaches no installation. */
export function notInstalledNote(endpoints: Endpoints, appSlug: string | undefined): string {
  return `The GitHub App is not installed on any account this sign-in reaches, so it sees no repositories. ${installStep(endpoints, appSlug)}.`
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
  const service = input.service ?? "GitHub"
  let devicePoll: AbortController | undefined

  /** A GitHub App's additions to the metadata: the flag, the installation count and the refresh token's expiry. */
  const appMetadata = async (token: { accessToken: string; scope: string; refreshTokenExpiresIn?: number }, signal: AbortSignal): Promise<AppMetadata> => {
    if (!isAppToken(token.accessToken, token.scope)) return {}
    const installations = await fetchInstallationCount(token.accessToken, { signal, fetch: send, endpoints })
    return {
      githubApp: true,
      ...(installations !== undefined ? { installations } : {}),
      ...(token.refreshTokenExpiresIn ? { refreshExpires: Date.now() + token.refreshTokenExpiresIn * 1000 } : {}),
    }
  }

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
        metadata: { tokenType: "Bearer", scope: token.scope, login, ...(await appMetadata(token, signal)) },
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

  // Renews a GitHub App's expiring token; every other credential comes back unchanged, without a request.
  const deviceRefresh = async (clientId: string, credential: Credential.OAuth): Promise<Credential.OAuth> => {
    if (!credential.refresh || !credential.expires) return credential
    const metadata = (credential.metadata ?? {}) as Record<string, unknown> & AppMetadata
    if (metadata.refreshExpires !== undefined && metadata.refreshExpires <= Date.now()) throw signInAgain(service)
    const token = await refreshAccessToken({ clientId, refreshToken: credential.refresh, service, signal: stopped, fetch: send, endpoints })
    // An App that reached no installation is checked again, so the install note goes once the App is installed.
    const installations = metadata.installations === 0 ? await fetchInstallationCount(token.accessToken, { signal: stopped, fetch: send, endpoints }) : undefined
    return oauthCredential(DEVICE_METHOD_ID, token.accessToken, {
      refresh: token.refreshToken ?? "",
      expires: token.expiresIn ? Date.now() + token.expiresIn * 1000 : 0,
      metadata: {
        ...metadata,
        scope: token.scope,
        ...(installations !== undefined ? { installations } : {}),
        ...(token.refreshTokenExpiresIn ? { refreshExpires: Date.now() + token.refreshTokenExpiresIn * 1000 } : {}),
      },
    })
  }

  const label = (credential: Credential.OAuth) => {
    const login = credential.metadata?.login
    if (typeof login !== "string") return undefined
    if (installationsOf(credential) !== 0) return login
    return `${login} (GitHub App not installed: ${input.appSlug ? `${endpoints.web}/apps/${input.appSlug}/installations/new` : "install it on an account or organization"})`
  }

  return {
    attach(editor, id) {
      const clientId = input.clientId
      if (clientId) {
        editor.method.update({
          integrationID: id,
          method: { id: DEVICE_METHOD_ID, type: "oauth", label: "Sign in with GitHub" },
          authorize: () => deviceAuthorize(clientId),
          refresh: (credential) => deviceRefresh(clientId, credential),
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
