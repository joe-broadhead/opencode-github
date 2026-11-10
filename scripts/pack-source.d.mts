// Types for scripts/pack-source.mjs, so the unit tests import it under strict TypeScript.
export interface PackEntry {
  /** The tarball's full path: set when PACK_TARBALL names it. */
  path?: string
  filename: string
  files: { path: string }[]
  size: number
  unpackedSize?: number
}

export function packSource(options: {
  env: Record<string, string | undefined>
  root: string
  scratch: string
  run: (command: string, args: string[], cwd: string) => string
}): PackEntry
