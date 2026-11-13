# opencode-triage - Agent Guide

Skill discovery and routing plugin for OpenCode, published as `opencode-triage` on npm.

## Entrypoints

- `src/index.ts`: backward-compatible V1 export `server`.
- `src/server.ts`: V2 default plugin definition, selected through `./server` by the native host resolver.
- `src/router.ts`: shared routing engine and V1 hook adapter. No compilation step.
- `bin/opencode-triage.cjs`: Node CLI; commands live in `bin/commands/`.
- `postinstall.cjs`: creates the `/triage` command for local or global installs.

## Validation

- `npm run check`: TypeScript type checking.
- `npm run check:compat`: installed-package checks under Bun with V1 SDKs 1.14.17/1.19.5 and the V2 SDK 2.3.0 resolver; set `BUN_BIN` if needed.
- `npm test`: Node test runner with TypeScript stripping (Node 22+ for development).
- `TRIAGE_TEST_SEMANTIC_MODEL=1 npm test`: optional cached-model integration test.
- `TRIAGE_TEST_MISSING_EMBEDDINGS=1 npm test`: optional fallback test, run with the embedding dependency absent.
- No linter or formatter is configured.

## Architecture

- Shared skill directories: `bin/skill-dirs.cjs` resolves four project and four global paths.
- Keep the root module callable-only for pre-1.18.29 V1 loaders. V2 SDK imports must remain type-only in the V2 adapter; host capabilities select the entry, not package availability.
- CLI/config helpers support both `plugin` and `plugins`, preserving options and format. Never silently overwrite invalid configs.
- Hooks hide the full native catalog. Request-specific suggestions expose at most three candidates by default, without sharing state between sessions.
- `triage` searches metadata; native `skill` loads active instructions; `load-skill` supports legacy `SKILL.md.disabled` files. `list-skills` lists the catalog and `rescan` refreshes discovery.
- Filesystem watchers plus a five-second TTL invalidate discovery; watchers close on plugin disposal.
- English keyword scoring retains minimum word length 3, position decay, IDF, stemming, name/description weights, and scope bonuses. Chinese queries use `jieba-wasm` segmentation.
- Optional `@huggingface/transformers` embeddings enable multilingual matching. Model download is explicit, chats use local cached model files, and failures fall back to keywords. Never rewrite installed dependencies.
- Model and embedding caches live under `~/.cache/opencode-triage/`.
- The `triage` skill is always excluded; environment exclusions can only add names.

## CLI

- `on` and `off` target both global and local scopes by default; `--global`, `--local`, and `--both` override scope.
- Restart OpenCode after toggles or downloading the model.
- `status --json` distinguishes file visibility from effective prompt visibility and includes redacted Windows config diagnostics when both config locations exist.
- `dedupe --dry-run --json` previews duplicates; removal requires interactive selection.
- `download-model` downloads the optional local model; it does not run during a chat.

## Publishing

- Bump `package.json` and `package-lock.json`, update `CHANGELOG.md` and release documentation.
- `prepublishOnly` runs type checking and tests.
- Check `npm pack --dry-run --json` before publishing; publish only source, CLI modules, postinstall, README, and changelog. Never include local configs, credentials, skills, caches, or models.
- Publish with `npm publish`, create the matching Git tag and GitHub release, and verify npm metadata and the installed CLI version.
