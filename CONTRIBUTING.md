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

Build it, then add the clone's path to `plugins` in your OpenCode config instead of the release install:

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
| Build | `npm run build` | esbuild bundles `dist/index.js` (server part) and `dist/tui.js` (TUI part, JSX compiled by Babel with `babel-preset-solid`) as two self-contained files, with the RPC contract (plain JSON Schema) inlined into each and zod only in `dist/index.js`, and fails if anything else lands in `dist/`, `dist/tui.js` is minified, an output imports a module the host does not provide, or the root `NOTICE` no longer lists exactly the bundled packages' licences (`node scripts/build.mjs --notice` rewrites it). |
| Forbidden APIs | `npm run lint` | Proves with its self-test that every rule fires, then scans `src/`, `test/`, `scripts/` and `dist/` for the APIs listed in [AGENTS.md](AGENTS.md). |
| Pack and install | `npm run test:pack` | Packs the package, checks its file list and size, installs the tarball into a new project with scripts disabled, loads it in each tested stock OpenCode release (plugin active, `/connect` lists GitHub with its sign-in methods, default rules, status RPC), and imports the server and RPC entries. |
| TUI | `npm run test:tui` | Renders the built `dist/tui.js` with OpenTUI's test renderer under Bun. |
| Host | `npm run test:host` | Loads the built plugin into an embedded OpenCode host from the public `@opencode/sdk` under Bun, once per tested release, with GitHub replaced by a loopback fake. |
| Stock | `npm run test:stock` | Runs each tested stock `opencode serve` release with the built plugin and a test probe plugin (`test/stock/probe`) that points the `github` server at the loopback fake, and calls the tools RPC as a script: known reads, denies, refused asks, session rules, excluded tools, upstream errors and `api` refusals. |

The tested releases are `TESTED_HOSTS` in `src/host-version.ts`: 2.2.3, 2.2.4, 2.2.5 and 2.2.6. The host, pack and stock
stages, and so CI, all run on that one list. The pack check and the stock test take the stock OpenCode binaries from
`OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4`, `OPENCODE_BIN_2_2_5` and `OPENCODE_BIN_2_2_6`. When one is unset, each installs `@opencode/cli`
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
runtime, an unknown tool follows `access`: it runs at the default `"all"`, asks at `"ask-changes"` and is denied at
`"read-only"`.

The signed-in catalogue and the `jelly` declaration list different counts on purpose. The catalogue lists the tools of
the toolsets the `toolsets` option turns on: 69 with the defaults, which are the 72 names of the default toolsets, less
the hidden `ui_get` and the two `issue_artifact_*` tools behind a feature flag the plugin does not turn on. The
declaration lists every known tool: the 98 GitHub tools, `github_api` and `github_events_list`, so a toolset a user
turns on needs no change to the declaration.

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

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it. The release
workflow makes both, in GitHub Actions: nobody builds, commits or tags a release on their own machine, and no personal
key signs it.

While changes land, their notes go under `## [Unreleased]` at the top of `CHANGELOG.md`. Each earlier GitHub release is
a `## [x.y.z] - YYYY-MM-DD` heading below it, newest first, and the npm history stays last, under
`## Earlier releases on npm`.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. Start the release with that commit's full sha:
   `gh workflow run release.yml --ref master -f sha=<full sha>`, or from Actions → release →
   Run workflow, on `master`.
4. Read the run's summary, then approve the `release` environment. The summary is on the run page, under the `stage`
   job: the tag, the parent and its CI run, the release commit and its tree, the sha256 of `SHA256SUMS` and the staged
   artifact's id, `SHA256SUMS` itself, and the notes. Open the release commit on `release/v<version>` and read them
   before approving: the approval releases exactly those bytes. Only the owner approves a release. Agents never approve
   one, never call the deployment-approval API, and never bypass a ruleset or the environment; the kit's scripts make
   only their own GitHub calls and refuse every other.
5. Check the published Release: not a draft, its notes, and every asset against `SHA256SUMS`.

Before the approval, the workflow:
- **plans:** refuses a run that is not on `master`, a sha that is not `master`'s head, a sha without a successful `ci.yml`
  push run, a version that is not `x.y.z`, a CHANGELOG whose newest release is not this version, a release that does not
  move forward from the last published Release, a leftover `release/v<version>` branch, a native run that did not build
  this sha on `master`, by hand, with success, and a missing `native_run` (or one given to a plugin that is not native);
- **builds** `dist/` with `npm ci --ignore-scripts` and `npm run build`, with a read-only token, and writes the release
  files: `dist/`, `package.json` without its lifecycle scripts, and the vetted native manifest;
- **commits** them on a temporary branch `release/v<version>` at the parent, through GitHub's API with the workflow's token,
  so GitHub signs the commit (author `github-actions[bot]`, committer GitHub). This job runs no npm. It refuses a commit
  that GitHub does not verify, or whose parent or tree is not the one the files give;
- **verifies** on a fresh runner: the commit's identity, one parent on `master`, `package.json` exactly the parent's
  without the lifecycle scripts, only regular files in the allowed paths, no `package.json` under `dist/`, and a second,
  independent build of the parent (its own job) equal to the committed `dist/` byte for byte;
- **installs** the release commit with `plugin add` on each stock OpenCode host (2.2.3 to 2.2.6);
- **packs** the commit before installing anything and keeps that tarball, then runs the pack stage against a copy;
- **stages** the Release: verifies the attested native files, writes `SHA256SUMS` and the notes (the version's CHANGELOG
  section), and shows them all in the run summary with the sha256 of `SHA256SUMS`.

A job either runs repository or dependency code (`npm ci`, the build, the pack stage, a host install) and has no write
token, or uses the API and runs only the kit's scripts on a fresh checkout, after checking that the release commit's
`scripts/` and `.github/` are the parent's. The first kind is not token-free: `actions/checkout` fetches with the job's
read-only (`contents: read`) token, and its post step and the artifact uploads run after repository code on the same
runner, so that code could reach a read-only token for this public repository and the runner's artifact token. Jobs
pass files as artifacts downloaded by the id the uploading job gave, and each is checked again on arrival.

After the approval, it downloads the staged artifact by the id the summary names, and refuses unless `SHA256SUMS` has
the sha256 the summary shows and every staged file matches it, and every native file is the one the release commit's
`manifest/native.json` pins, size and sha256, with each gzip holding the pinned executable. Then it checks everything again, creates the annotated tag
`v<version>` on the release commit (tagger `github-actions[bot]`, unsigned), checks the tag, creates the Release with the
notes, the tarball, the native files and `SHA256SUMS`, and deletes `release/v<version>`. The tag keeps the commit.

GitHub's signature and the bot identity show only that GitHub made the commit through its API for the workflow; anyone
with write access can make such a commit. What ties the release to `master` is its content: one parent CI passed, the
exact `package.json`, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.

**A rejected, expired or failed run** leaves nothing behind: the `cleanup` job deletes `release/v<version>` when it points
at the parent or at that run's commit, and never touches another branch. No tag exists before the approval, so the
version is not burned: fix `master` and start again. If `cleanup` itself failed, the next run refuses until the branch
is deleted: `gh api -X DELETE repos/joe-broadhead/opencode-github/git/refs/heads/release/v<version>`.

**Resume.** If the run fails after creating the tag and before the Release is complete, start it again with the same `sha`. The plan finds the kit's tag on a release commit on that sha with no published Release, and resumes:
it makes no new commit, checks and installs the tagged commit, stages the files, and after a new approval reuses the tag
and adds what the Release lacks. Delete a draft Release a failed upload left first: the publish step refuses a draft.
Any other existing tag is refused: release the next version.

The repository's tag ruleset keeps a `v*` tag from being moved or deleted. A stray `v*` tag, one that never became a
Release, does not block later releases: only published Releases count, and drafts do not. Its version cannot be
released, so release the next one. To remove the tag anyway, an admin disables the `release tags` ruleset, deletes the
tag, and restores the ruleset exactly as it was.

**Known limit: a `v*` tag pushed by hand.** No ruleset limits who creates a `v*` tag, so anyone with write access can
push one by hand, pointing at any commit. Such a tag has no published Release, the forward-only check ignores it, and
Jelly installs only a published Release whose `SHA256SUMS` it verifies. But a user who installs
`github:joe-broadhead/opencode-github#v<x>` directly gets whatever that tag points at. Only the release workflow makes
release tags; never push one by hand.

The release kit is these files, the same in every plugin: `scripts/release-rules.mjs`, `scripts/release-commit.mjs`,
`scripts/release-github.mjs`, `scripts/check-release-shape.mjs`, `scripts/changelog.mjs`, `scripts/release-version.mjs`,
`scripts/release-pack.mjs`, `scripts/publish-release.mjs`, `scripts/attach-native.mjs`, `scripts/native-manifest.mjs`,
`scripts/tested-hosts.mjs`, `scripts/check-release-plugin-add.sh`, `scripts/release-kit.test.mjs` and
`.github/workflows/release.yml`. Do not re-run the older `apply-release-kit.mjs`: it writes back the kit that could
release only `v0.0.0`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-github#v<old version>`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-github#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-github#v0.0.0" }] }
```
