# Contributing

This repository is an OpenCode plugin on [plugin-contract](https://github.com/we-the-rebel-alliance/plugin-contract) v0.
The contract is [docs/contract.md](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/contract.md),
the bar for every plugin repository is
[docs/plugin-standard.md](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md),
and [AGENTS.md](AGENTS.md) is the working guide.

## Set up and check

You need Node 24.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` runs the whole gate:

| Step | What it proves |
|---|---|
| `npm run typecheck` | the sources and tests typecheck under strict settings |
| `npm run build` | `dist/index.js` is built from `src/index.ts` with esbuild |
| `npm test` | the options, accounts, manifest, provider, handlers and fixture tests pass |
| `npm run test:pack` | the tarball carries the built entry, the manifest, the skills and the icons, and nothing else |
| `plugin-kit check` | conformance T0 and T1, the doc file set, the forbidden patterns and no bundled kit |
| `plugin-kit docs --check` | every generated doc section matches the manifest |

CI runs the same steps in one job named `ci`. `dist/` is generated and is not committed, so CI builds it before
`plugin-kit check`.

## The contract pin

`package.json` pins the contract to a commit of `we-the-rebel-alliance/plugin-contract`; a released plugin pins the
release tag instead (`github:we-the-rebel-alliance/plugin-contract#v0.0.0`) and moves the pin with the contract's
release. Never copy a contract module into this repository.

The committed `package-lock.json` records the contract's repository over `git+https`, so a fresh `npm ci` needs no SSH
key. Keep it that way; CI also rewrites an `ssh://git@github.com/` URL to HTTPS for an older lockfile.

## Pull requests

One change per pull request, based on `master`, with a conventional commit (`feat:`, `fix:`, `docs:`, `chore:`). The
pull request says what changed and why, the contract section it implements, and the exact `npm run check` result.

A new method, source or action starts in `package.json` `capabilities`, then its handler in `src/handlers/`, then its
tests, then `npx plugin-kit docs`, then `npx plugin-kit check`. Every capability has tests, including its negative
cases.

## Fixtures

`fixtures/conformance.json` is the plugin's evidence to the conformance kit. The fake GitHub under `test/support/`
answers two invented accounts, and `test/conformance/fixture.test.ts` replays every recorded answer through the handlers
so the fixture cannot drift. Rebuild it with `npm run fixtures`, then run `npx plugin-kit record` to redact it.

Recording from a real account uses the kit:

```sh
npx plugin-kit record --account work
npx plugin-kit record --account personal
```

`plugin-kit record` redacts credentials, emails, phone numbers and home directories before it writes.

## Releases

Releases are tags, not npm packages. A release is prepared in one pull request,
`chore(release): prepare vX.Y.Z`: the version in `package.json` and `package-lock.json`, the `CHANGELOG.md` section, and
`npx plugin-kit docs` if the manifest changed. The owner pushes the tag after `master`'s CI passed; the release workflow
checks the tag, builds, and creates the GitHub release with the packed tarball, the conformance report and `SHA256SUMS`.
