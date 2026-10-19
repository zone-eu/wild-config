# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                  # node --test test/wild-config-test.js
npm run test:coverage     # c8 npm test
npm run typecheck         # tsc -p tsconfig.json (JSDoc types in the JS sources, no emit)
npm run lint              # npm run typecheck && eslint .
npm run lint:fix          # eslint . --fix
npm run format            # prettier --write .
npm run format:check      # prettier --check .
npm run update            # rm -rf node_modules package-lock.json && ncu -u && npm install
```

Run a single test by name (Node's built-in test runner):

```bash
node --test --test-name-pattern="maps APPCONF_ variables" test/wild-config-test.js
```

## Critical constraints

- **CommonJS only, never ESM.** The package is consumed by EmailEngine, which ships as a single-file binary built with [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg), and by the Zone services (WildDuck, ZoneMTA and others). pkg snapshots a CommonJS module graph and cannot reliably load pure-ESM packages, so this package and every dependency it pulls in must stay CommonJS-compatible. `.ncurc.js` (`upgrade: true`) holds the `reject` list with a reason per entry; `npm run update` honors it.
- **Engines floor is Node 20.** `expandWildcard()` is hand-written instead of `fs.globSync` because the latter needs Node 22. Do not reach for newer built-ins without checking the floor.
- **Releases are automated via release-please** (`release-please-config.json`, `.github/workflows/release.yaml`, npm trusted publishing with provenance). The version in `package.json` and `CHANGELOG.md` are owned by the bot, do not bump them by hand.
- **Types are hand-written.** `index.d.ts` is the published declaration file (`export =` of a `WildConfig` object type), and `tsconfig.json` only exists to type-check the JS sources against JSDoc annotations (`allowJs`, `checkJs`, `noEmit`, `strict`). The typecheck runs as part of `npm run lint`, so CI enforces it. TypeScript is held at 6.x in `.ncurc.js`: 7.x reports TS2309 on `index.js` (it reads the `Object.defineProperty(module.exports, 'on', ...)` as an extra export next to the `module.exports =` assignment). `types: ["node"]` is set explicitly because TypeScript 6 no longer loads every `@types` package by default.
- **ESLint uses the shared flat config** (`eslint.config.js`, ESLint 10). It is the CommonJS template shared across the Postal Systems / Nodemailer packages (eslint:recommended plus the retired eslint-config-nodemailer rules, eslint-config-prettier last); keep it identical to the other repos except for the "Repo-specific" block at the end, where each override carries a one-line reason. There are currently no overrides. CI (`.github/workflows/test.yml`) runs lint, `format:check` and the tests on Node 20, 22 and 24.

## Architecture

The whole library is `index.js`. Requiring it loads the configuration synchronously at require time and the module's exports object _is_ the config: `require('@zone-eu/wild-config')` returns an object whose own keys are the merged configuration, plus `configDirectory` and a non-enumerable, read-only `on(event, listener)` (the only event is `reload`). Setting `DISABLE_WILD_CONFIG=true` makes the module return before loading anything.

Loading order in `loadConfig()`, each later source merged over the earlier ones with `deep-extend`:

1. `default.*` and `<NODE_ENV>.*` files (`.toml`, `.json`, `.js`) from `NODE_CONFIG_DIR` (default `./config`), defaults first.
2. The explicit file from `NODE_CONFIG_PATH`, `--config` or `APPCONF_config`. A parse error here or in any loaded file prints the file name and exits the process with status 1.
3. `APPCONF_*` environment variables, mapped to config paths by `resolveEnvKey()` (case-insensitive key match against the loaded config, underscores rejoined when an existing key contains them, otherwise every underscore is a dot).
4. Command-line arguments (`--a.b=value`), which win over an `APPCONF_` variable for the same key.

Overrides from steps 3 and 4 go through `parseArgs()`, which keeps every given value as a raw string (minimist would turn `"0012"` into 12), and `walkConfig()` then converts toward the type of the existing config value: numbers (a non-numeric value stays a string, never `NaN`), booleans (a fixed list of "no" spellings is false, anything else true), arrays (comma separated). Keys missing from the config are taken as strings.

TOML files support `# @include "path"` directives (relative to the including file, `{ENV}` substituted, `*` and `**/` wildcards expanded in sorted order). `extendToml()` rewrites each directive into a `__include_file_path_N` key holding the file list, and `tomlParser()` replaces those keys with the parsed contents after `toml.parse`. Nesting is capped at 100 levels.

`.js` config files run through `vm.Script` with the real `require`, so a config file is trusted code with full access, not a sandbox. Config directories must be operator-controlled.

There is no exported `reload()`: `loadConfig` is attached to the internal EventEmitter as `reload`, and `config.on(...)` returns that emitter, so a consumer reloads with `config.on('reload', fn).reload()` (the test suite relies on this). Every load after the first emits `reload`. On every load, top-level keys the previous load set and the new one does not are deleted from the exports object (`loadedKeys`); a key the application assigned itself, such as ZoneMTA plugins setting `config.pools`, survives a reload, and a config key named `on` is skipped so it cannot overwrite the method.

### Testing notes

`test/wild-config-test.js` loads the module in a fresh child process per test (`spawnSync(process.execPath, ['-e', ...])`), because configuration is read once at require time. The helper strips `APPCONF_*`, `NODE_CONFIG_*`, `NODE_ENV` and `DISABLE_WILD_CONFIG` from the parent environment, so the suite is not affected by the shell it runs in. Fixtures live in `test/fixtures/` (one directory per scenario); `c8` collects coverage from the child processes too.

## Conventions

These mirror the conventions used across Postal Systems projects (see `../emailengine`). The repo is co-maintained with Zone (github.com/zone-eu); their commits reference ticket ids (`fix: ZMS-63: ...`) and land through pull requests.

**Git commits**

- Use Conventional Commits: `fix:` (patch release), `feat:` (minor release), and `chore:`/`build:`/`ci:`/`docs:`/`refactor:`/`style:`/`test:` for changes that should not trigger a release. release-please derives the version and changelog from these prefixes.
- Do **not** list Claude or any AI assistant as a co-author / co-contributor in commit messages or PR descriptions (no `Co-Authored-By` trailer).
- Append `[skip ci]` to commits that do not change runtime behavior (docs, comments, CI/workflow tweaks, formatting) to avoid spending CI minutes. Exception: never add `[skip ci]` to a `fix:` or `feat:` commit, those must run so the release workflow triggers. GitHub reads the marker off the HEAD commit of a push, so a `[skip ci]` commit pushed on top of a `fix:` commit silences both; push the release-triggering commit last.

**Code & docs style**

- No emojis anywhere in code or documentation, printable ASCII only.
- Use a single hyphen-minus (`-`) as a dash in user-facing strings and docs. Never use double hyphens (`--`), em dashes, or en dashes.

**Before committing code changes**

1. `npm run format` and `npm run lint` (lint includes the typecheck)
2. `npm test`
3. For non-trivial changes, consider `/simplify` (quality cleanup) and `/security-review`. Keep `index.d.ts` in sync with any change to the exported shape.

**After pushing**

- Check the workflow runs for the push (`gh run list --branch <branch>`) and report their status. If a run fails for an unrelated/infrastructure reason (checkout reporting "account suspended", HTTP 403, other auth errors), check <https://www.githubstatus.com/> for an active GitHub incident before assuming the change caused it.
