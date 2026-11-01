// GitHub OAuth device flow (RFC 8628) for an OAuth App, plus the token identity check.
// No client secret is used. Errors are written for the person signing in and never
// contain a token, a device code or a raw response body.
import { type Endpoints, GITHUB_COM } from "./config.js"
import { GitHubPluginError } from "./errors.js"

const deviceCodeUrl = (endpoints: Endpoints) => `${endpoints.web}/login/device/code`
const accessTokenUrl = (endpoints: Endpoints) => `${endpoints.web}/login/oauth/access_token`
const userUrl = (endpoints: Endpoints) => `${endpoints.api}/user`

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const SLOW_DOWN_SECONDS = 5
const LOGIN_TIMEOUT_MS = 10_000
const RESTART = "Start the sign-in again."
const expired = () => new GitHubPluginError("SIGN_IN_EXPIRED", "The GitHub sign-in code expired before it was entered.", RESTART)

export type Fetch = (url: string, init: RequestInit) => Promise<Response>
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

interface DeviceCode {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
  /** Seconds between polls. */
  readonly interval: number
}

interface AccessToken {
  readonly accessToken: string
  readonly scope: string
  readonly refreshToken?: string
  readonly expiresIn?: number
}

export async function requestDeviceCode(input: {
  readonly clientId: string
  readonly scopes: readonly string[]
  readonly signal?: AbortSignal
  readonly fetch: Fetch
  /** Where to sign in; github.com unless set. */
  readonly endpoints?: Endpoints
  readonly now?: () => number
}): Promise<DeviceCode> {
  const now = input.now ?? Date.now
  const endpoints = input.endpoints ?? GITHUB_COM
  const body = await postForm(input.fetch, deviceCodeUrl(endpoints), { client_id: input.clientId, scope: input.scopes.join(" ") }, input.signal)
  if (typeof body.error === "string") throw oauthError(body.error)
  const deviceCode = text(body.device_code)
  const userCode = text(body.user_code)
  const verificationUri = text(body.verification_uri)
  if (!deviceCode || !userCode || !verificationUri || !isHttps(verificationUri)) {
    throw new GitHubPluginError("SIGN_IN_UNEXPECTED_RESPONSE", "GitHub returned an incomplete sign-in code.", RESTART)
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: now() + seconds(body.expires_in, 900) * 1000,
    interval: seconds(body.interval, 5),
  }
}

export async function pollAccessToken(input: {
  readonly clientId: string
  readonly deviceCode: string
  readonly interval: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
  readonly fetch: Fetch
  readonly sleep?: Sleep
  readonly endpoints?: Endpoints
  readonly now?: () => number
}): Promise<AccessToken> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? abortableSleep
  let interval = input.interval
  while (true) {
    const remaining = input.expiresAt - now()
    if (remaining <= 0) throw expired()
    await sleep(Math.min(interval * 1000, remaining), input.signal)
    input.signal?.throwIfAborted()
    if (now() >= input.expiresAt) throw expired()

    const body = await postForm(
      input.fetch,
      accessTokenUrl(input.endpoints ?? GITHUB_COM),
      { client_id: input.clientId, device_code: input.deviceCode, grant_type: DEVICE_GRANT },
      input.signal,
    )
    const accessToken = text(body.access_token)
    if (accessToken) {
      const refreshToken = text(body.refresh_token)
      const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : undefined
      return {
        accessToken,
        scope: text(body.scope) ?? "",
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresIn ? { expiresIn } : {}),
      }
    }
    if (body.error === "authorization_pending") continue
    if (body.error === "slow_down") {
      interval = Math.max(interval + SLOW_DOWN_SECONDS, seconds(body.interval, 0))
      continue
    }
    throw oauthError(typeof body.error === "string" ? body.error : undefined)
  }
}

/** Returns the GitHub login that owns `token`. Times out after 10 seconds. */
export async function fetchLogin(token: string, input: { readonly signal?: AbortSignal; readonly fetch: Fetch; readonly endpoints?: Endpoints }): Promise<string> {
  const url = userUrl(input.endpoints ?? GITHUB_COM)
  const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  let response: Response
  try {
    response = await input.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencode-github",
      },
      redirect: "error",
      signal,
    })
  } catch (error) {
    input.signal?.throwIfAborted()
    if (timeout.aborted || (error as { name?: unknown } | undefined)?.name === "TimeoutError") {
      throw new GitHubPluginError("TOKEN_CHECK_TIMEOUT", "GitHub did not answer within 10 seconds while checking the token.", "Try again.")
    }
    throw new GitHubPluginError("TOKEN_CHECK_UNREACHABLE", `Could not reach ${new URL(url).host} to check the token.`, "Check your network, then try again.")
  }
  if (response.status === 401) {
    throw new GitHubPluginError("TOKEN_REJECTED", "GitHub rejected the token: it is invalid, expired or revoked.", "Create a new token and try again.")
  }
  if (response.status === 403) {
    throw new GitHubPluginError("TOKEN_FORBIDDEN", "GitHub refused the token (HTTP 403).", "Check that it is allowed for your account or organization, then try again.")
  }
  if (!response.ok) throw new GitHubPluginError("TOKEN_CHECK_FAILED", `GitHub could not check the token (HTTP ${response.status}).`, "Try again later.")
  const login = text(((await response.json().catch(() => ({}))) as Record<string, unknown>).login)
  if (!login) throw new GitHubPluginError("TOKEN_CHECK_FAILED", "GitHub accepted the token but did not return an account name.", "Try again later.")
  return login
}

async function postForm(fetch: Fetch, url: string, form: Record<string, string>, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted && (signal.reason as { name?: unknown } | undefined)?.name !== "TimeoutError") throw signal.reason
    throw new GitHubPluginError("SIGN_IN_UNREACHABLE", `Could not reach ${new URL(url).host} to sign in.`, "Check your network, then start the sign-in again.")
  }
  const body = await response.json().catch(() => undefined)
  if (body && typeof body === "object" && !Array.isArray(body)) {
    // GitHub reports OAuth errors in a JSON body, sometimes with a 4xx status.
    if (response.ok || typeof (body as Record<string, unknown>).error === "string") return body as Record<string, unknown>
  }
  throw new GitHubPluginError("SIGN_IN_UNEXPECTED_RESPONSE", `GitHub returned an unexpected response (HTTP ${response.status}).`, RESTART)
}

function oauthError(code: string | undefined): GitHubPluginError {
  switch (code) {
    case "expired_token":
      return expired()
    case "access_denied":
      return new GitHubPluginError("SIGN_IN_CANCELLED", "Sign-in was cancelled on GitHub.", RESTART)
    case "incorrect_device_code":
      return new GitHubPluginError("SIGN_IN_CODE_UNKNOWN", "GitHub did not recognise the sign-in code.", RESTART)
    case "device_flow_disabled":
      return new GitHubPluginError(
        "DEVICE_FLOW_DISABLED",
        "Device sign-in is turned off for this GitHub OAuth App.",
        "Enable Device Flow in the app settings, or use a fine-grained personal access token.",
      )
    case "incorrect_client_credentials":
      return new GitHubPluginError(
        "CLIENT_ID_UNKNOWN",
        "GitHub does not recognise the OAuth client ID.",
        "Check the plugin option clientId, or use a fine-grained personal access token.",
      )
    case "unsupported_grant_type":
      return new GitHubPluginError(
        "DEVICE_GRANT_REJECTED",
        "GitHub rejected the device sign-in request.",
        "Update the plugin, or use a fine-grained personal access token.",
      )
    default:
      return new GitHubPluginError("SIGN_IN_FAILED", `GitHub sign-in failed${code && /^[a-z_]{1,64}$/.test(code) ? ` (${code})` : ""}.`, RESTART)
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
