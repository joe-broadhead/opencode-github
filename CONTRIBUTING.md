# Contributing

## Setup

- Node.js 22.12 or later, with npm. CI uses Node.js 24.
- Bun 1.4 (CI uses 1.4.4). The TUI and host tests, including OpenCode's embedded SDK, run with `bun test`, and
  OpenTUI 0.8 needs Bun 1.3.14 or later.
- macOS or Linux.

```sh
git clone https://github.com/joe-broadhead/opencode-github.git
cd opencode-github
npm ci --ignore-scripts
npm run check
```

No dependency needs install scripts, and OpenCode installs plugins without them, so always pass `--ignore-scripts`.

### Run your checkout in OpenCode

Build it, then add the clone's path to `plugins` in your OpenCode config instead of the npm package:

```sh
npm run build
```

```json
{
  "plugins": [{ "package": "/path/to/opencode-github", "options": { "toolsets": ["context", "repos", "issues"] } }]
}
```

Restart OpenCode. `opencode mcp list` shows `github  needs authentication` until you sign in.

## `npm run check`

One command runs every local check, in this order. It must pass before every commit.

| Stage | Script | What it does |
| --- | --- | --- |
| Types | `npm run typecheck` | `tsc` over `src/`, the TUI and the whole `test/` tree. |
| Unit tests | `npm test` | Vitest over `test/unit/`. |
| Build | `npm run build` | esbuild bundles `dist/index.js` (server part) and `dist/tui.js` (TUI part, JSX compiled by Babel with `babel-preset-solid`) as two self-contained files, with the RPC contract (plain JSON Schema) inlined into each and zod only in `dist/index.js`, and fails if anything else lands in `dist/`, an output imports a module the host does not provide, or the root `NOTICE` no longer lists exactly the bundled packages' licences (`node scripts/build.mjs --notice` rewrites it). |
| Forbidden APIs | `npm run lint` | Proves with its self-test that every rule fires, then scans `src/`, `test/`, `scripts/` and `dist/` for the APIs listed in [AGENTS.md](AGENTS.md). |
| Pack and install | `npm run test:pack` | Packs the package, checks its file list and size, installs the tarball into a new project with scripts disabled, loads it in each tested stock OpenCode release (plugin active, `/connect` lists GitHub with its sign-in methods, default rules, status RPC), and imports the server and RPC entries. |
| TUI | `npm run test:tui` | Renders the built `dist/tui.js` with OpenTUI's test renderer under Bun. |
| Host | `npm run test:host` | Loads the built plugin into an embedded OpenCode host from the public `@opencode/sdk` under Bun, once per tested release, with GitHub replaced by a loopback fake. |
| Stock | `npm run test:stock` | Runs each tested stock `opencode serve` release with the built plugin and a test probe plugin (`test/stock/probe`) that points the `github` server at the loopback fake, and calls the tools RPC as a script: known reads, denies, refused asks, session rules, excluded tools, upstream errors and `api` refusals. |

The tested releases are `TESTED_HOSTS` in `src/host-version.ts`: 2.2.3, 2.2.4, 2.2.5 and 2.2.6. The host, pack and stock
stages, and so CI, all run on that one list. The pack check and the stock test take the stock OpenCode binaries from
`OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4` and `OPENCODE_BIN_2_2_5`. When one is unset, each installs `@opencode/cli`
at that version into a temporary folder, once per run. The host tests (`scripts/host-tests.mjs`) run 2.2.3 on the
lockfile's SDK, and each other release on `HOST_SDK_DIR_2_2_4` or `HOST_SDK_DIR_2_2_5`, a folder whose
`node_modules` holds that `@opencode/sdk`; when one is unset, they install it into a temporary folder, once per run.

The host tests, the stock test and the pack check run OpenCode in a temporary profile: `HOME`, the XDG folders, `TMPDIR` and
`OPENCODE_TEST_HOME` all point inside a temporary folder, because Bun's `os.homedir()` ignores a changed `HOME`.
That folder is under the system's `/tmp`, never under `$TMPDIR` or `$HOME`, because OpenCode searches upward for
`.opencode` folders and `opencode.json` files; a test stops if one is above it. Each stock host listens on its own
free port. Every request outside the loopback fake fails the test.

### Another OpenCode release

The lockfile pins `@opencode/sdk` and `@opencode/plugin` at 2.2.3, the lowest supported release. To run the host
tests on one other 2.2.x release only, install its SDK in a separate folder, outside the lockfile, and point
`HOST_SDK_DIR` at it:

```sh
dir=$(mktemp -d /tmp/github-sdk-XXXXXX)
(cd "$dir" && echo '{"private":true}' > package.json && npm install --ignore-scripts --no-audit --no-fund @opencode/sdk@2.2.99)
npm run build
HOST_SDK_DIR="$dir" node scripts/host-tests.mjs
```

To add a tested release, add it to `TESTED_HOSTS`, the README Requirements and the CHANGELOG.

Do not add a newer release to `package.json` or the lockfile.

### Checks against a stock OpenCode

For a manual check on a real OpenCode, use an isolated profile, never your own:

- Run the CLI from npm, for example `npx -p @opencode/cli@2.2.3 opencode …`.
- Set `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `TMPDIR` and
  `OPENCODE_TEST_HOME` to folders inside one temporary folder. `opencode debug paths` must show only that folder.
- Plain `opencode mcp …`, `opencode auth …` and `opencode reload` talk to the shared background service. Start your
  own `opencode serve --port <port>` in the isolated profile and pass `--server http://127.0.0.1:<port>` to every
  other command.
- Do not type a prompt in the TUI or `opencode run`: a fresh profile answers with OpenCode's default hosted model.
  Use slash commands, the palette and keys.

## Maintainer tools with a GitHub token

These scripts call GitHub and need a token. They are not part of `npm run check`.

### `npm run e2e`

```sh
GITHUB_E2E_TOKEN=<token> npm run e2e
```

It loads the built plugin into an embedded OpenCode host in a temporary profile, signs in with the token method,
waits for `github` to connect, and runs every case in `test/e2e/cases.json`: one per known read tool of the default
toolsets. It prints a pass or fail table without response content and never prints the token. It never calls a
write tool.

- Before the first run, set `values.org` and `values.team` in `test/e2e/cases.json` to an organisation and team the
  token can read, and `values.writable_owner` and `values.writable_repo` to a repository the token can push to
  (`list_repository_collaborators` needs push access). The other values (a public repository, issue, pull request,
  label, branch, commit, path and tag) must still exist on GitHub.
- Exit codes: `0` every case passed, `1` a case failed, `2` `GITHUB_E2E_TOKEN` is not set.

### `npm run drift`

```sh
GITHUB_DRIFT_TOKEN=<token> npm run drift
```

It compares GitHub's live tools, toolset by toolset, with `KNOWN_TOOLS` in `src/tools.ts`, and warns about new tools,
catalogued tools that are missing, and tools whose read or write classification differs. It changes nothing; at
runtime, unknown tools ask by default whatever it reports.

- Exit codes: `0` the comparison ran, with or without warnings; `2` no token, or GitHub could not be reached or
  refused the token.
- When it warns, update `KNOWN_TOOLS`, the toolset table in `docs/configuration.md`, and `test/e2e/cases.json` for
  the default toolsets, then run it again.

## Code rules

[AGENTS.md](AGENTS.md) holds the rules for this repository, including the forbidden APIs. Commit messages use
`type(scope): summary`, for example `fix(status): explain a disabled server`.

## Releases

### Versioning

Versions follow semantic versioning on the plugin's contract: its options, the server name `github`, the
`/github-status` command, the `/github` dialog, the status RPC method, the skill names and the default rules. Until
the first major release, a breaking change raises the minor version.

Each release supports one OpenCode line. `opencode.host` in `package.json` states it, and `HOST_RANGE`
in `src/host-version.ts` enforces it. Both must change together, and a unit test checks that they match. Write the
range as `>=2.2.3 <2.3.0`, never `^2.2.3`, which would accept an untested 2.3.

### Releasing

1. Update `version` in `package.json` and add its `CHANGELOG.md` section.
2. Tag the release commit on `master` as `v<version>` and push the tag.
3. The tag starts `.github/workflows/release.yml` in the GitHub environment `release`, which waits for a reviewer's
   approval.
4. CI then runs the guard (the tag equals the version and the package is not private), `npm ci`, `npm run check`,
   `npm run release:check` (the CHANGELOG has a section for the version), one pack and the pack check against that
   exact tarball, and publishes it with npm trusted publishing and provenance. A rerun skips a version that is already
   on npm.
