# Repository rules

This repository builds `@we-the-rebel-alliance/github-plugin`, an unofficial OpenCode plugin that registers GitHub's
hosted MCP server under the name `github` and adds `github_api` and `events_list`. User docs: `README.md`,
`docs/configuration.md`; contributor docs: `docs/architecture.md`, `CONTRIBUTING.md`.

Phase 4a is the current state: the plugin is renamed, on OpenCode 2.4.1, and stripped of legacy paths. Phase 4b
replaces the `sources` and `jelly` package keys, the copied kit scripts under `scripts/` and `test/support/`, and the
tools RPC with plugin-contract v0 (`contract.register`, `capabilities`, `accounts`). Do not build on the old keys.

## Platform

- Use only public APIs of `@opencode/plugin` 2.4.1. The supported host range is exactly `>=2.4.1 <2.5.0`, in both
  `package.json` `opencode.host` and `HOST_RANGE` in `src/host-version.ts`. Never write it as `^2.4.1`.
- Test against stock OpenCode 2.4.1. `TESTED_HOSTS` in `src/host-version.ts` is the one list: the status's
  `host.tested`, the host, pack and stock tests and CI all take it from there. A release inside the range that is not
  in it still starts; the untested example in tests is 2.4.99.
- Plugin ids are `github.platform` (server and status RPC), `github.platform.tools` (tools RPC) and `github.platform.tui`
  (TUI); the server name is `github`. Phase 4b moves the id to `github`.

## Forbidden

`npm run lint` (`scripts/check-forbidden.mjs`) runs its self-test, then scans `src/`, `test/`, `scripts/` and `dist/`.
Do not use:

- the V1 packages under `@opencode-ai/`;
- `ctx.generate.*` and `experimental.policies` (deprecated);
- imports of `@opencode/ai` (it breaks between patch releases);
- imports of private OpenCode source (`packages/<name>/src`);
- machine-local home or temporary paths;
- a `.tsx` or relative import in `dist/`, or a `node:` import in `dist/tui.js`;
- a permission hook of our own: the tools RPC's `evaluate` hook, from the source contract, is the only one, and it
  only turns an ask on one of its own script calls in flight into a deny.

When you add a rule here, add it to the scan and its self-test too.

## Design

- GitHub's own MCP tools are the tool surface. The plugin adds `github_events_list` (`src/source-events.ts`), its
  source `github.activity` under the source contract, and the contract's `probe` tools RPC method; both make only GETs
  through `github_api`'s spec, as a script call, so each asserts its own action (`github_events_list`, `github_probe`)
  on its own `GET /path` first. The account and owner are the sign-in's recorded login. The plugin adds one more tool,
  `github_api` (`src/api/`), for what GitHub's tools cannot do.
- `github_api` classifies each call itself (GET and HEAD, `POST /markdown` and `/markdown/raw`, or one GraphQL query,
  read; everything else writes), asserts `github_api` on `METHOD /path` for every request before it is sent, reads
  included, with the names GitHub reads without regard to case in lower case (`src/api/names.ts`). It follows a read's
  redirect and a `Link` page only within the API base, asserting the new path first, and leaves the API only for a
  download's storage redirect. It refuses writes while read-only and never forwards the token across origins.
- `KNOWN_TOOLS` in `src/tools.ts` lists the known reads and writes. Unknown tools are listed, or hidden with
  `unknownTools: "hide"`. `npm run drift` finds upstream changes; it never acts at runtime. Nothing is pinned.
- Permission defaults go through `ctx.agent.transform`: the `access` option generates the block from the tool classes
  (`defaultRules(access)` in `src/permissions.ts`), inserted directly after each agent's base `* * allow` rule. No
  permission hook decides them. User rules and saved approvals keep winning, and a stricter agent is never weakened.
- **Tools RPC.** `github.platform.tools` lets scripts call every known tool and `github_api` with no model, as a
  session and its agent. A change asserts `github_api` on its exact resource and needs a prior explicit allow; a saved
  approval is not a grant. The transport is the source contract's, shared by the family: GitHub's part is
  `src/tools-rpc.ts`. A change to the transport goes to the package first. Phase 4b replaces this with `register`.
- Agents defined only in the user's config get no rules. Status names them and gives the fix: the block **first** in
  **that agent's own** `permissions` list, followed by the user's top-level rules for `github_` tools.
- With `host` (GitHub Enterprise Server) no MCP server is registered: sign-in lives on the plugin's own
  `github-enterprise` integration and `github_api` is the tool. A server named `github` that the user configured is
  left alone, and status reports `conflict`.
- The plugin's own errors are `GitHubPluginError(code, message, nextStep)`. Errors from OpenCode and GitHub pass
  through unchanged. No error, log or output contains a token, a device code or raw upstream content.
- `dist/` holds exactly two self-contained bundles, `index.js` and `tui.js` (esbuild, no splitting, no chunks, no
  relative imports), so an in-place update never pairs a new entry with a stale sibling module.

## Package

- No peer and no runtime dependencies: esbuild bundles zod into `dist/index.js` only. `@opencode/*`, `effect`, OpenTUI,
  Solid, TypeScript, Babel, esbuild and zod are dev dependencies, at the versions in `package.json`.
- Ship prebuilt `dist/` and no `.d.ts` files. No install, `prepare` or `prepack` scripts.
- The icons are GitHub's own Invertocat from GitHub's logo kit; `opencode.vendor.mark` is `true`. Do not recolour,
  redraw or combine it.
- Releases come only from `.github/workflows/release.yml` ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)). Never
  push a tag or a `release/*` branch, and never commit, tag or publish a release by hand. Phase 4b cuts `v0.0.0`.
- No personal email in anything we publish. Check `git config user.email` before committing.

## Hygiene

- Greenfield: no legacy or dead code, exports, dependencies, docs, tests or fixtures.
- No tokens, client secrets, personal data or machine-local paths in the repository.
- Tests use narrow `Pick<Plugin.Context, …>` fakes. Host tests use the public `@opencode/sdk` and isolate `HOME`, the
  XDG folders, `TMPDIR` and `OPENCODE_TEST_HOME` inside a temporary folder under the system's `/tmp`
  (`test/host/scratch.ts`), never under `$TMPDIR` or `$HOME`; each stock host gets its own free port. Never touch the
  owner's real OpenCode.
- Run `npm run check` before every commit. Commit messages use `type(scope): summary`.
