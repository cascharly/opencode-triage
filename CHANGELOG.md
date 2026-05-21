# Changelog

All notable changes to opencode-triage are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.4] — 2026-05-20

### Added

- **Shared skill directories module** — introduced a central source of truth (`bin/skill-dirs.cjs`) containing standard skill directory subpaths and a resolver function, shared between the CLI and the plugin.

### Changed

- **Skill discovery optimized** — reduced disk I/O by caching and retrieving file sizes during the initial discovery scan, cutting filesystem reads in half.
- **Test suite cleanup** — deduplicated `stripJsoncComments` unit test code in `test/cli-utils.test.ts` by importing directly from `src/config.ts`.

### Fixed

- **CLI-plugin discovery synchronization** — resolved a discovery discrepancy where the `/triage status` command missed skills located in the `~/.gemini/config/skills/` directory by aligning the CLI scan paths with the runtime plugin router via the shared locations module.
- **YAML folded description parser** — resolved a bug in multi-line frontmatter parser (`>`) to successfully extract complete multi-line descriptions instead of truncating them.
- **UTF-8 safe size enforcement** — replaced character length checks with strict buffer byte-length checks for the 1MB single-file size ceiling.
- **Simulation script imports** — restored correct imports in `scripts/simulate.ts` that previously pointed to non-existent paths.

## [1.3.3] — 2026-05-16

### Added

- **Spell correction hints** — when a query contains unmatched words (length ≥ 4), the plugin computes Levenshtein distance against all skill names and descriptions, and injects a hint into the tool result for the LLM to self-correct silently. Transparent to the user. Examples: `scurity` → `security`, `broweser` → `browser`, `devop` → `devops`. Zero false positives on short words, gibberish, or niche terms.

### Changed

- **Scoring pipeline overhauled** — auto-route rate improved. No user-facing behavior change; routing accuracy increases transparently.
- **Code modularized** — split `index.ts` (650 lines) and `utils.ts` (482 lines) into 7 focused files: `index.ts` (plugin + hooks), `discovery.ts` (file scanning, reading, rename migration), `scoring.ts` (scoring pipeline, IDF, stemming), `spellcheck.ts` (Levenshtein, suggestion engine), `config.ts` (constants, types, triage state, JSONC parsing), `remote.ts` (remote skill search), `utils.ts` (shared utilities). Easier to maintain and test.

## [1.3.2] — 2026-05-15

### Added
- `/triage dedupe` command — removes project-level duplicates when a skill exists in both project and global scopes; supports `--dry-run` preview
- Duplicate detection in `status`: `[dup]` badge on cross-scope duplicates in text output; `duplicate: true/false` in JSON output; summary line with hint to run `/triage dedupe`

## [1.3.1] — 2026-05-15

### Changed
- `compare` token model corrected: now measures `name+description` XML (what OpenCode injects per-message in the native `skill` tool) vs the triage tool definition — not full skill bodies, which are loaded on-demand in both modes and cost the same either way.
- `compare` table relabelled: columns renamed to `WITH triage` / `WITHOUT (native)`, rows clarified as "Tool definition" and "Skill list XML". Dim footer note explains on-demand parity.
- `compare` JSON output updated: `without_triage` now includes `tool_base` and `skill_list_xml` breakdown; `with_triage` adds `skill_list_xml: 0`; `time` field removed; `top_skills` now reports `name_desc_tokens` and `body_tokens` separately.
- `compare` top-skills list now sorted by name+desc size (actual per-prompt cost) rather than full body size.

### Fixed
- `showCompare` deduplication: added `seen` Set keyed on `scope:name` to prevent a skill discovered in multiple directories from being counted and displayed more than once.

## [1.3.0] — 2026-05-15

### Changed
- Simplified CLI to a 2-command mental model: `/triage on` and `/triage off` toggle both local and global scopes by default.
- CLI now persists ON/OFF state to plugin config, ensuring the setting is respected across OpenCode sessions.
- `status` command UI simplified: labels show ON/OFF/MIXED based on actual skill file state rather than plugin config.
- Output formats unified and polished.

### Fixed
- Addressed issue where `/triage off` would leave command files behind.
- Plugin startup now correctly ignores `autoHide` if explicitly disabled by `/triage off`.

## [1.2.9] — 2026-05-13

### Added
- `--json` flag on all commands for machine-readable output
- `--quiet` flag on toggle commands to suppress non-error output
- `--dry-run` flag on on/off commands to preview changes without renaming
- `--all` flag on status to show full skill list without truncation
- Levenshtein-based command suggestions on typo (e.g. `stats` → `status`)
- Out-of-sync warning when plugin is ACTIVE but skills remain exposed
- `status` grouped by scope with compact header bar and `[hidden]`/`[exposed]` colored badges
- `compare` shows top 5 hidden skills by token size and monthly savings estimate
- Toggle diff view showing each renamed skill inline
- Plugin skill cache TTL (5s) — auto-refreshes after CLI toggles without restart
- `OPENCODE_TRIAGE_EXCLUDED` env var to override the hardcoded `triage` skill exclusion
- 15 new tests for `stripJsoncComments`, Levenshtein distance, and command suggestion

### Changed
- `status` layout: compact one-line scope rows with `│` separators
- `status` uses `[hidden]`/`[exposed]` terminology consistently (was `active`)
- `toggle` only shows "Restart opencode" when files actually changed
- `safeRenameSync` deletes target before rename to handle crash recovery / git merge conflicts
- `postinstall` now always writes the command file (catches template updates on upgrade)
- Config writes are now no-op when nothing changed (avoids unnecessary disk I/O and watcher triggers)
- `findProjectRoot` checks 4 config variants (`.json` / `.jsonc`, nested / root-level)
- `sanitizeName` now strips all C0/C1 control characters, not just ANSI escape codes

### Fixed
- JSONC comment stripper corrupts URLs with `//` — replaced naive regex with state-machine parser
- `updateLocalConfig` crashes on JSONC configs, wiping all settings on parse failure
- `showStatus` reports false ACTIVE when plugin name appears in a JSONC comment
- `showCompare` overestimates savings by counting hidden skills in the "without" baseline
- `showCompare` shows 0 tokens for "without" when all skills are hidden
- Toggle output prints "removed" even when plugin wasn't in config
- `safeRenameSync` crashes on Windows when both `SKILL.md` and `SKILL.md.disabled` exist (EEXIST)

## [1.2.8] — 2026-05-13

### Changed
- Minor text updates

## [1.2.7] — 2026-05-12

### Added
- `--both` flag for `/triage on` and `/triage off` to toggle both scopes simultaneously
- `/triage on --both` — hides skills in both global and local scopes
- `/triage off --both` — exposes skills in both global and local scopes
- `--both` documentation in README, AGENTS.md, and CLI help text

### Changed
- `toggle()` function now supports a third scope value (`"both"`) that iterates both global and local scopes
- Help text updated with `--both` examples and scope descriptions
- `readSkillContent()` returns `{ content, filePath }` object for benchmark accuracy
- `CMD_TEMPLATE` uses `npx -y opencode-triage` for cross-platform compatibility (was hardcoded Windows path)
- `updateGlobalConfig()` now scopes plugin removal to `"plugin"` array context only

### Fixed
- `showCompare` estimate benchmark (`indexOf` → real `fs.readFileSync`)
- `showCompare` benchmark loop missing symlink guard
- `extractFrontmatter` key param not escaped in regex (latent ReDoS)
- `safeRenameSync` redundant symlink check removed (caller already guards)

## [1.2.6] — 2026-05-12

### Added
- `notify` tool accessible by the LLM to show TUI toast notifications
- Toast notifications for "no skills installed", content truncation, and content unreadable cases in triage results
- Body-start content detection to prevent false positives when skill body text mentions error strings
- `typeof` guard on `output.output` to harden against non-string tool results
- `test/notifications.test.ts` — 21 tests covering first-line pattern matching, body extraction, false positive prevention, and edge cases

### Changed
- Consolidated duplicated constants and utility functions from `index.ts` into `utils.ts` imports
- Moved `notify.ts` into `src/` directory for correct npm packaging (`files` glob covers it now)
- Replaced inline path-traversal check with exported `isValidSkillName()` from `utils.ts`
- Updated JSDoc on all source files (`server`, `buildSkillLocations`, `discoverAllSkills`, `tryReadSkill`, `readSkillContent`)
- Synced version header comment (1.0.0 → 1.2.5)

### Removed
- `triage-notify.ts` — redundant standalone plugin; notification logic now lives in `src/index.ts`

### Fixed
- `notify.ts` missing from published npm package (was outside `src/`, not matched by `files` glob)
- Potential false positive toast when skill body text contained `(skill content truncated` or `(skill content unavailable)`


## [1.2.5] — 2026-05-12

### Changed
- Clarified cross-tool impact wording in documentation

## [1.2.4] — 2026-05-09

### Changed
- Added `.agents/`, `.claude/`, `skills-lock.json` to `.gitignore`

## [1.2.3] — 2026-04-07

### Changed
- Polished README, improved source comments, fixed directory listings

## [1.2.2] — 2026-04-05

### Changed
- Clarified token savings apply to skills only

## [1.2.1] — 2026-04-04

### Added
- Configuration combinations table to README

## [1.2.0] — 2026-04-02

### Added
- Scope-aware CLI (`--local` / `--global` flags)
- Postinstall auto-setup for command file creation
- README rewrite

## [1.1.0] — 2026-03-28

### Changed
- Restructured for npm publishing

## [1.0.3] — 2026-03-26

### Added
- Cross-tool impact documentation warning
- `.agents/skills/` directory support (vercel.sh install target)
- README user flow examples and SEO keywords

### Fixed
- Security fixes and bug fixes
- CRLF regex handling

## [1.0.0] — 2026-03-24

### Added
- Initial release: deterministic skill router for OpenCode
- Keyword-based scoring with configurable weights
- SKILL.md / SKILL.md.disabled discovery from 6 directory locations
- `/triage on|off|status` CLI
- Confidence-gap auto-routing
