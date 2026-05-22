# opencode-triage — Agent Guide

## What this is

Deterministic skill router for OpenCode. Published as `opencode-triage` on npm.

## Entrypoints

- **Plugin** (`src/index.ts`) — exports `server`, consumed by OpenCode Bun runtime. No build step.
- **CLI** (`bin/opencode-triage.cjs`) — standalone Node.js script for user commands.
- **Postinstall** (`postinstall.cjs`) — auto-creates `/triage` command file on npm install.

## Commands

```sh
npm run check    # tsc --noEmit (only check, no build/compile)
```

No test runner, no linter, no formatter config. No tsconfig.json in repo.

## Architecture

- Scans 8 directories: `.agent/skills/`, `.agents/skills/`, `.claude/skills/`, `.opencode/skills/` (project) + `~/.agents/skills/`, `~/.claude/skills/`, `~/.config/opencode/skills/`, `~/.gemini/config/skills/` (global)
- Pure Bun plugin architecture — operates entirely dynamically using system prompt and tool transformation hooks; does not require or load any standalone fallback router skill.
- Reads `SKILL.md` files directly — `.disabled` suffix is fallback for older OpenCode
- Hides skills from LLM via 3-layer hook defense: `tool.definition` (modifies `skill` tool description) → `experimental.chat.system.transform` (strips `<available_skills>` from system prompt) → `tool.execute.before` (intercepts stray calls)
- CLI file rename (`SKILL.md` ↔ `SKILL.md.disabled`) remains as fallback when hooks unsupported
- Upgrade from older versions: plugin detects `.disabled` files left from old file-rename mode, auto-restores them to `SKILL.md` on first chat message
- Keyword scoring: `THRESHOLD=30`, `MIN_WORD_LENGTH=3`, `NAME_WEIGHT=3`, `DESC_WEIGHT=1`, `BIGRAM_BONUS=10`, `PHRASE_BONUS=50`, `POSITION_DECAY=0.9`, `SCOPE_BONUS=5`
- Stemming: `stem()` strips `ies→y` and `ing→""` (MIN stem length 4) — bridges morphological variants in desc matching
- Name tokenization: hyphens/underscores replaced with spaces for bigram/phrase matching in skill names
- "triage" directory is always excluded
- Frontmatter keys parsed: `name` (falls back to directory name), `description` (supports folded `>` syntax)

## CLI behavior

- Default scope is **global**. Use `--local` flag for project-level, `--both` for both.
- `/triage on` — hides global skills
- `/triage on --local` — hides project skills
- `/triage on --both` — hides skills in both global and local scopes
- `/triage off` — exposes global skills
- `/triage off --local` — exposes project skills
- `/triage off --both` — exposes skills in both global and local scopes
- `/triage status` — shows plugin state + all skills (project + global)
- Each scope is independent — 4 possible combinations (or use `--both` for atomic toggle)
- Always requires restart after toggle

## Postinstall

- Detects global vs local via `npm_config_global` env var
- Auto-creates command file: `~/.config/opencode/commands/triage.md` (global) or `.opencode/commands/triage.md` (local)
- Command template uses `npx -y opencode-triage $ARGUMENTS`

## Publishing

`npm publish` — files included via `"files": ["src/", "bin/", "postinstall.cjs", "README.md"]` in package.json. `.npmignore` excludes `*.tgz`, `.eslintrc*`, `tsconfig.json`.
