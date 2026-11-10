// The plugin's own errors. Errors from OpenCode and from GitHub propagate unchanged.
// Messages never carry upstream content, credentials or tokens. Each message starts with
// its code, because OpenCode shows only the message when a plugin fails to load.

/**
 * Every code this plugin's own code raises. The README's Troubleshooting table and the Errors table in
 * docs/configuration.md name each one, and a test fails when they differ either way.
 */
type PluginCode =
  | "API_DOWNLOAD_TOO_LARGE"
  | "API_FILE_EXISTS"
  | "API_FILE_OUTSIDE_PROJECT"
  | "API_GRAPHQL_PATH"
  | "API_INPUT_INVALID"
  | "API_PATH_INVALID"
  | "API_REDIRECT_INSECURE"
  | "API_REDIRECT_LOOP"
  | "API_REDIRECT_OFF_HOST"
  | "API_REDIRECTED"
  | "API_UNREACHABLE"
  | "API_UPLOAD_TOO_LARGE"
  | "AUTH_REQUIRED"
  | "CLIENT_ID_UNKNOWN"
  | "DEVICE_FLOW_DISABLED"
  | "DEVICE_GRANT_REJECTED"
  | "EVENTS_CURSOR_INVALID"
  | "EVENTS_INVALID_INPUT"
  | "EVENTS_OWNER_UNKNOWN"
  | "EVENTS_READ_FAILED"
  | "HOST_UNTESTED"
  | "OPTIONS_INVALID"
  | "PERMISSION_DENIED"
  | "READ_ONLY"
  | "SIGN_IN_CANCELLED"
  | "SIGN_IN_CODE_UNKNOWN"
  | "SIGN_IN_EXPIRED"
  | "SIGN_IN_FAILED"
  | "SIGN_IN_UNEXPECTED_RESPONSE"
  | "SIGN_IN_UNREACHABLE"
  | "SKILLS_INVALID"
  | "STATUS_UNAVAILABLE"
  | "TOKEN_CHECK_FAILED"
  | "TOKEN_CHECK_TIMEOUT"
  | "TOKEN_CHECK_UNREACHABLE"
  | "TOKEN_FORBIDDEN"
  | "TOKEN_FORMAT"
  | "TOKEN_REJECTED"

export const PLUGIN_CODES: readonly PluginCode[] = [
  "API_DOWNLOAD_TOO_LARGE",
  "API_FILE_EXISTS",
  "API_FILE_OUTSIDE_PROJECT",
  "API_GRAPHQL_PATH",
  "API_INPUT_INVALID",
  "API_PATH_INVALID",
  "API_REDIRECT_INSECURE",
  "API_REDIRECT_LOOP",
  "API_REDIRECT_OFF_HOST",
  "API_REDIRECTED",
  "API_UNREACHABLE",
  "API_UPLOAD_TOO_LARGE",
  "AUTH_REQUIRED",
  "CLIENT_ID_UNKNOWN",
  "DEVICE_FLOW_DISABLED",
  "DEVICE_GRANT_REJECTED",
  "EVENTS_CURSOR_INVALID",
  "EVENTS_INVALID_INPUT",
  "EVENTS_OWNER_UNKNOWN",
  "EVENTS_READ_FAILED",
  "HOST_UNTESTED",
  "OPTIONS_INVALID",
  "PERMISSION_DENIED",
  "READ_ONLY",
  "SIGN_IN_CANCELLED",
  "SIGN_IN_CODE_UNKNOWN",
  "SIGN_IN_EXPIRED",
  "SIGN_IN_FAILED",
  "SIGN_IN_UNEXPECTED_RESPONSE",
  "SIGN_IN_UNREACHABLE",
  "SKILLS_INVALID",
  "STATUS_UNAVAILABLE",
  "TOKEN_CHECK_FAILED",
  "TOKEN_CHECK_TIMEOUT",
  "TOKEN_CHECK_UNREACHABLE",
  "TOKEN_FORBIDDEN",
  "TOKEN_FORMAT",
  "TOKEN_REJECTED",
]

/**
 * The codes the tools RPC shares with every plugin of this family, listed in docs/scripting.md beside this plugin's
 * own. They come from the shared tools RPC module and from OpenCode, not from this plugin's code.
 */
type RpcCode =
  | "AUTH_REQUIRED"
  | "CANCELLED"
  | "CONNECTING"
  | "CONNECTION_FAILED"
  | "DISABLED"
  | "NOT_REGISTERED"
  | "PERMISSION_DENIED"
  | "SERVER_CONFLICT"
  | "SESSION_AGENT_REQUIRED"
  | "SESSION_UNKNOWN"
  | "TOOL_UNAVAILABLE"
  | "UPSTREAM_ERROR"

export const RPC_CODES: readonly RpcCode[] = [
  "AUTH_REQUIRED",
  "CANCELLED",
  "CONNECTING",
  "CONNECTION_FAILED",
  "DISABLED",
  "NOT_REGISTERED",
  "PERMISSION_DENIED",
  "SERVER_CONFLICT",
  "SESSION_AGENT_REQUIRED",
  "SESSION_UNKNOWN",
  "TOOL_UNAVAILABLE",
  "UPSTREAM_ERROR",
]

export class GitHubPluginError extends Error {
  readonly code: PluginCode
  /** What happened, without the code or the next step. */
  readonly detail: string
  readonly nextStep: string

  constructor(code: PluginCode, message: string, nextStep: string) {
    super(`${code}: ${message} Next step: ${nextStep}`)
    this.name = "GitHubPluginError"
    this.code = code
    this.detail = message
    this.nextStep = nextStep
  }
}
