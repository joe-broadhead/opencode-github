# Repository rules

This repository builds `@joe-broadhead/opencode-github`, an unofficial OpenCode plugin that registers GitHub's
hosted MCP server (`https://api.githubcopilot.com/mcp/`) under the name `github` and uses GitHub's own tools. User
docs: `README.md`, `docs/configuration.md`; contributor docs: `docs/architecture.md`, `CONTRIBUTING.md`.

## Platform

- Use only public APIs of `@opencode/plugin` 2.2.3. The supported host range is exactly `>=2.2.3 <2.3.0`, in both
  `package.json` `opencode.host` and `HOST_RANGE` in `src/host-version.ts`. Never write it as `^2.2.3`.
- Test against stock OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6. `TESTED_HOSTS` in `src/host-version.ts` is the one list:
  the status's `host.tested`, the host, pack and stock tests and CI all take it from there. Inside the range a release
  that is not in it still starts; the untested example in tests is 2.2.99.
- Keep plugin ids `github.platform` (server and status RPC), `github.platform.tools` (tools RPC) and
  `github.platform.tui` (TUI), and the server name `github`.

## Forbidden

`npm run lint` (`scripts/check-forbidden.mjs`) runs its self-test, then scans `src/`, `test/`, `scripts/`
and `dist/`. Do not use:

- the V1 packages under `@opencode-ai/`;
- `ctx.generate.*` and `experimental.policies` (deprecated);
- `ctx.experimental.artifact` (experimental, new in 2.2.4);
- imports of `@opencode/ai` (it breaks between patch releases);
- imports of private OpenCode source (`packages/<name>/src`);
- machine-local home or temporary paths;
- a `.tsx` or relative import in `dist/`, or a `node:` import in `dist/tui.js`;
- `ctx.permission.hook` anywhere except exactly once in `src/host/tools-rpc.ts` and once in `dist/index.js`: the
  tools RPC's `evaluate` hook, which turns an ask on one of its own script calls in flight into a deny, because no one
  can answer a script's prompt. It only tightens and touches no other call.

When you add a rule here, add it to the scan and its self-test too.

## Design

- GitHub's own MCP tools are the tool surface. The plugin adds `github_events_list` (`src/source-events.ts`), Memory's
  source of GitHub events over the shared `events_list` contract (`src/host/events-list.ts`, carried unchanged and
  pinned by `scripts/check-copies.mjs`: change it in every source plugin at once); it makes only GETs through
  `github_api`'s spec, and its tests run the contract's conformance check on a synthetic GitHub. The plugin adds one
  more tool, `github_api` (`src/api/`), for what they
  cannot do. It classifies each call itself (GET and HEAD, `POST /markdown` and `/markdown/raw`, or one GraphQL query,
  read; everything else writes), asserts `github_api` on `METHOD /path` for writes, with exactly the path it sends
  (dot segments and needless percent-encoding are refused) and the names GitHub reads without regard to case in lower
  case (`src/api/names.ts`), never follows a redirect for a change, follows a read's redirect (and a `Link` page) only
  within the API base, with no assert, as reads never ask, and leaves the API only for a download's storage redirect, refuses writes while read-only, sends requests only to the
  configured API and uploads bases, and never forwards the token across origins. It and GitHub's MCP tools share the
  Code Mode namespace `github`, which it describes. Status lives in `/github-status`,
  the `/github` dialog and the status RPC, which all render one status model (`src/rpc.ts`).
- `KNOWN_TOOLS` in `src/tools.ts` lists the known reads and writes. Unknown tools ask, or are hidden with
  `unknownTools: "hide"`. `npm run drift` finds upstream changes; it never acts at runtime.
- Permission defaults go through `ctx.agent.transform`: the `access` option generates the block from the tool classes
  (`defaultRules(access)` in `src/permissions.ts`), inserted directly after each agent's base `* * allow` rule. At the
  default `"all"` every tool is allowed and so is the `github_*` pattern; `"ask-changes"` asks for every change and
  `"read-only"` denies it. No permission hook decides them. User rules and saved approvals keep winning, and a stricter
  agent is never weakened. `readOnly` is deprecated and maps onto `access`.
- **Tools RPC.** `github.platform.tools` (`src/host/tools-rpc.ts`) lets scripts call, with no model, `describe`, one
  method per known tool (`allReadTools()` and `allWriteTools()`, each with its class, through OpenCode's own executors
  from `ctx.tool.list()`, never an MCP client of the plugin's), and `api` (`src/api/script.ts`): `github_api`'s own
  spec, which asserts `github_api` on the exact resource for a change, a `download` and an `upload`, and refuses every
  change with `READ_ONLY` while `access` is `"read-only"`. For a script, `run` resolves that same resource against the
  agent's and the session's rules before it sends anything: only a prior explicit `allow` runs, so an allow scoped to
  GETs cannot POST and a saved approval is not a grant. `ui_get` and unknown tools are never methods. `describe` gives a
  tool GitHub does not list a `detail` naming its toolset and the `toolsets` option (`unavailableDetail` in
  `src/tools.ts`). A script runs as a session and its agent; its one permission hook only turns its own script calls'
  asks into denies. `src/host/tools-rpc.ts` is a copy of a module shared by several plugins: change only its block
  between the `PLUGIN-SPECIFIC` markers here, and the rest in the shared copy first.
- Agents defined only in the user's config get no rules. Status names them and gives the fix: the block **first** in
  **that agent's own** `permissions` list, followed by the user's top-level rules for `github_` tools. Never recommend the
  top-level `permissions` for the block.
- With `host` (GitHub Enterprise Server) no MCP server is registered: sign-in lives on the plugin's own
  `github-enterprise` integration and `github_api` is the tool.
- A server named `github` that the user configured is left alone: no headers, no sign-in methods, status `conflict`.
- Sign-in methods attach to the `github` server's integration. No client secret. No OAuth App or GitHub App client ID
  ships: token sign-in always, device sign-in only when the user or an organisation sets `clientId`, which may name an
  OAuth App or a GitHub App. Only the device method registers `refresh`: it renews a GitHub App's expiring token with
  its refresh token and returns every other credential unchanged, without a request (OpenCode calls it for
  `expires: 0` too). Tell a GitHub App from an OAuth App by the token GitHub returns (`ghu_` or `gho_`, then an empty
  `scope`), never by the client ID.
- The plugin's own errors are `GitHubPluginError(code, message, nextStep)`. Errors from OpenCode and GitHub pass
  through unchanged. No error, log or output contains a token, a device code or raw upstream content.
- `dist/` holds exactly two self-contained bundles, `index.js` and `tui.js` (esbuild, no splitting, no chunks, no
  relative imports), so an in-place update never pairs a new entry with a stale sibling module. The TUI part ships
  prebuilt in `dist/tui.js`. Register keymaps and palette commands from setup with a `global`
  layer. No `ctx.ui.slot`.

## Package

- No peer and no runtime dependencies: esbuild bundles zod into `dist/index.js` only (`import * as z from "zod"`). The RPC contract (`src/rpc.ts`) is
  plain JSON Schema with a hand-written type, never zod, so `dist/tui.js` stays small. `@opencode/*`
  (exactly 2.2.3), OpenTUI, Solid, TypeScript, Babel, esbuild and zod are dev dependencies. Do not add 2.2.4 to the lockfile.
- Ship prebuilt `dist/` and no `.d.ts` files. No install, `prepare` or `prepack` scripts.
- **The icons** `assets/icon.svg`, `assets/icon-128.png` and `assets/icon-256.png` are a neutral branch-and-node mark: no
  GitHub logo, shape or brand colour, because the plugin is unofficial. They are generated by the family icon kit and
  checked by `scripts/check-icons.mjs`, which is a byte-identical copy of the kit's. `opencode.icons` declares the three
  files, `opencode.vendor` declares GitHub as the vendor, and the three `exports` and three `files` entries ship them.
- **The workflows are linted** by `actionlint` (`scripts/actionlint.mjs`, and a CI job), because a `${{ }}` that exists
  in some contexts only makes GitHub reject the whole file and run nothing.
- Releases come only from `.github/workflows/release.yml` ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)). A
  release-prep PR sets `version` in `package.json` and the install specs and runs `node scripts/changelog.mjs release`;
  once it is on `master` and CI passed, start the release with
  `gh workflow run release.yml --ref master -f sha=<its full sha>`. The workflow builds `dist/`, makes the release
  commit on a temporary `release/v<version>` branch, checks and stages everything, and waits for the owner to approve
  the `release` environment; only then does it create the tag `v<version>` and the GitHub Release. Never push a tag or a
  `release/*` branch, and never commit, tag or publish a release by hand. Agents never approve a release, never call the
  deployment-approval API, and never bypass a ruleset or the environment.
- No personal email in anything we publish. Every commit is authored and committed as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`, except the release commit and tag, which the
  release workflow makes as `github-actions[bot]`. Before committing or tagging, check that
  `git config user.email` is that address: a fresh clone inherits the machine's global identity, which is not that
  address. Never commit, tag or publish with a work or personal address, or with a local hostname.

## Hygiene

- Greenfield: no legacy or dead code, exports, dependencies, docs, tests or fixtures.
- No tokens, client secrets, personal data or machine-local paths in the repository.
- Tests use narrow `Pick<Plugin.Context, …>` fakes. Host tests use the public `@opencode/sdk`, and the stock test
  (`test/stock`) stock `opencode serve` binaries; both isolate `HOME`, the XDG folders, `TMPDIR` and
  `OPENCODE_TEST_HOME` inside a temporary folder under the system's `/tmp` (`test/host/scratch.ts`), never under
  `$TMPDIR` or `$HOME`, and each stock host gets its own free port. Never touch the owner's real OpenCode.
- Run `npm run check` before every commit. Commit messages use `type(scope): summary`.
