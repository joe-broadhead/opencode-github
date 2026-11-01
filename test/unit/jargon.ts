// Words from the old implementation and the delivery process that must never reach the
// model or the user. Returns the words found.
const WORDS =
  /\b(manifest|attest\w*|digest|fingerprint|quarantine\w*|fail(?:s|ed)? closed|capabilit\w*|dispatch\w*|lease|acceptance|evidence|fork|github_internal_\w*|integrationID|transform|placeholder|reviewed|imported)\b/gi
const CODES = /\b(BUSY|RPC|WS-[A-Z]|V\d{1,2})\b/g

export function jargonIn(text: string): string[] {
  return [...text.matchAll(WORDS), ...text.matchAll(CODES)].map((match) => match[0])
}
