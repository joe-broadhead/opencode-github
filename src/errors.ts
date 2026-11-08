// The plugin's own errors. Errors from OpenCode and from GitHub propagate unchanged.
// Messages never carry upstream content, credentials or tokens. Each message starts with
// its code, because OpenCode shows only the message when a plugin fails to load.

type ErrorCode =
  | "OPTIONS_INVALID"
  | "HOST_UNTESTED"
  | "STATUS_UNAVAILABLE"
  | "SKILLS_INVALID"
  | "SIGN_IN_EXPIRED"
  | "SIGN_IN_CANCELLED"
  | "SIGN_IN_CODE_UNKNOWN"
  | "SIGN_IN_FAILED"
  | "SIGN_IN_UNREACHABLE"
  | "SIGN_IN_UNEXPECTED_RESPONSE"
  | "DEVICE_FLOW_DISABLED"
  | "CLIENT_ID_UNKNOWN"
  | "DEVICE_GRANT_REJECTED"
  | "TOKEN_FORMAT"
  | "TOKEN_REJECTED"
  | "TOKEN_FORBIDDEN"
  | "TOKEN_CHECK_TIMEOUT"
  | "TOKEN_CHECK_UNREACHABLE"
  | "TOKEN_CHECK_FAILED"
  | "READ_ONLY"
  | "AUTH_REQUIRED"
  | "API_INPUT_INVALID"
  | "API_PATH_INVALID"
  | "API_GRAPHQL_PATH"
  | "API_FILE_OUTSIDE_PROJECT"
  | "API_FILE_EXISTS"
  | "API_UPLOAD_TOO_LARGE"
  | "API_DOWNLOAD_TOO_LARGE"
  | "API_UNREACHABLE"
  | "API_REDIRECT_LOOP"
  | "API_REDIRECT_INSECURE"
  | "API_REDIRECT_OFF_HOST"
  | "API_REDIRECTED"
  | "SCRIPT_READ_ONLY"
  | "EVENTS_INVALID_INPUT"
  | "EVENTS_CURSOR_INVALID"
  | "EVENTS_OWNER_UNKNOWN"
  | "EVENTS_READ_FAILED"

export class GitHubPluginError extends Error {
  readonly code: ErrorCode
  /** What happened, without the code or the next step. */
  readonly detail: string
  readonly nextStep: string

  constructor(code: ErrorCode, message: string, nextStep: string) {
    super(`${code}: ${message} Next step: ${nextStep}`)
    this.name = "GitHubPluginError"
    this.code = code
    this.detail = message
    this.nextStep = nextStep
  }
}
