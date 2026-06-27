# opencode-triage

> OpenCode already lazy-loads full skill bodies — but it still injects every skill's name and description (from `SKILL.md` frontmatter) into the prompt on every message. With a growing skill library and verbose descriptions, that can mean hundreds of tokens burned before you type a word. opencode-triage eliminates that XML list entirely, replacing it with a compact tool definition and routing on-demand via keyword matching.

## Quick Start

```bash
npm install -g opencode-triage
```

Restart OpenCode, then type `/triage on`. That's it.

## What It Does

OpenCode lists every skill's name and description in the prompt on every message. With many skills, that burns hundreds of tokens before you type a word.

Triage hides all skills from the prompt. When you need one, the LLM calls `triage()` — the plugin finds the best match by keyword scoring and loads only that skill's instructions.

```
No triage:   [name+desc of A] [name+desc of B] [name+desc of C] ...  ← every message
With triage: triage({ query }) → keyword match → loads one skill body when needed
```

**The more skills you install, the more triage saves.** Each new skill adds tokens to the native prompt, but zero tokens when triage is on.

## LLM Quick-Install

Copy-paste this into any LLM:

```text
Install opencode-triage (https://github.com/cascharly/opencode-triage) — a deterministic skill router for OpenCode.

1. Run: npm install -g opencode-triage
2. If any errors occur, visit the repo link above and resolve them.
3. Tell me to restart OpenCode.
```

## Commands

| Command | What it does |
|---|---|
| `/triage on` | Enable hooks to hide skills from the LLM prompt (global + local) |
| `/triage off` | Disable hooks, restore skills to the LLM prompt (global + local) |
| `/triage status` | See hook state and skill visibility |
| `/triage dedupe` | Remove project-level duplicates of global skills |
| `/triage compare` | Token savings estimate for your skills |

> **Note:** Skills are hidden via hooks at the LLM prompt level — `SKILL.md` files stay intact on disk, so other AI tools (Cursor, Claude Code, Windsurf) still see them. File renaming (`SKILL.md` ↔ `SKILL.md.disabled`) is only used as a fallback for older OpenCode versions without hook support. When files are renamed to `.disabled`, they will also be hidden from other AI tools that scan the same directories.

### Flags

| Flag | Where | What it does |
|------|-------|--------------|
| `--json` | All commands | Machine-readable JSON output |
| `--quiet` | on/off | Suppress non-error output |
| `--dry-run` | dedupe | Preview changes without renaming |
| `--all` | status | Show full skill list without truncation |

All commands also work in your terminal: `npx opencode-triage <command>`. No OpenCode session needed.

For automation, call `npx opencode-triage <command> --json` directly and ensure any wrapper writes its own warnings to stderr, not stdout. A wrapper that prepends text to stdout will make otherwise-valid JSON unparseable.

### Configuration Combinations

| State | Global | Project | How to configure |
|---|---|---|---|
| Full exposure | exposed | exposed | `/triage off` (default) |
| Full triage | hidden | hidden | `/triage on` |
| Triage globally only | hidden | exposed | `/triage on --global` |
| Triage in project only | exposed | hidden | `/triage on --local` |

Global affects `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/`.
Local affects `.opencode/skills/`, `.claude/skills/`, `.agent/skills/`, `.agents/skills/` in the current project.

## How It Works

The LLM calls `triage()` when it encounters a task it can't handle with general knowledge. The plugin scores all hidden skills against the query and returns the best match.

```
User: "backup my database"
  │
  ▼
LLM: triage({ query: "backup my database" })
  │
  ▼
Plugin: scans filesystem → scores skills → returns best match
  backup-restore     score=60  (matched: backup, database)
  database-sync      score=25  (matched: database)
  gap=35 ≥ threshold(30) → HIGH CONFIDENCE
```

No LLM reasoning overhead. No extra API calls. Just fast deterministic matching.

### Spell Correction

If a query word doesn't match any skill, the plugin suggests the closest correction (e.g., `scurity` → `security`) and passes it to the LLM as a hint. The LLM can retry silently — no user-facing error.

### Why "Triage"?

In emergency medicine, a triage nurse quickly assesses each patient and routes them to the right specialist — never loading every patient into every doctor's office at once. Same idea here.

## Install

### Global (recommended)

Same as Quick Start above. `/triage` is available in **every** project.

### Per-project

```bash
npm install opencode-triage
```

Restart OpenCode. `/triage` is available only in this project. Type `/triage on --local` to enable.

## Token Savings

Example data from this project (19 skills). Numbers will vary based on your skill library and description verbosity. Run `/triage compare` for live numbers.

```
Cost Comparison Global + Local

Skills: 19 hidden · 0 exposed · 19 total

                        WITH triage           WITHOUT (native)
──────────────────      ────────────────────  ────────────────────
Prompt per call         59 tokens             1226 tokens
  Tool definition       59 tokens             32 tokens
  Skill list XML        0 tokens              1194 tokens
  (skill body*)         same for both →       loaded on-demand
──────────────────      ────────────────────  ────────────────────
Saved per call          1167 tokens (95%)

* Skill body is fetched on-demand in both modes — equal cost, not counted above.

Top skills by name+desc size (what actually costs per-prompt):
  llm-security                   ~167 tokens  (full body: ~1299)
  semgrep                        ~150 tokens  (full body: ~2419)
  vercel-react-best-practices    ~104 tokens  (full body: ~1576)
  context7-mcp                   ~84 tokens   (full body: ~641)
```

Run `/triage compare` for live numbers based on your skill inventory.

## Cross-Tool Impact

Triage hides skills from the LLM prompt using hooks — `SKILL.md` files stay intact on disk. Other AI tools that scan the same directories (Claude Code, Cursor, Windsurf) will still see them normally. Run `/triage off` to restore the native skill tool for OpenCode.

Use `/triage on --local` to isolate triage to one project without affecting global skills.

## Uninstall

**Expose skills** (reversible — plugin and command stay):

```
/triage off
```

**Remove the package:**

```bash
npm uninstall -g opencode-triage
```

Delete the command file if present:

```shell
rm ~/.config/opencode/commands/triage.md           # macOS / Linux
del %USERPROFILE%\.config\opencode\commands\triage.md  # Windows (cmd)
```

Restart OpenCode. Clean.

For per-project installs, remove `"opencode-triage"` from `.opencode/opencode.json` and run `npm uninstall opencode-triage`.

## Under the Hood

### Plugin Activation

`opencode-triage` is a standard OpenCode plugin registered in the `"plugin"` array of `opencode.json` (both `~/.config/opencode/opencode.jsonc` globally and `.opencode/opencode.json` per-project). On startup, OpenCode loads all listed plugins, making their tools and commands available. The plugin registers the `triage` tool in the system prompt alongside `read`, `write`, `bash`, etc.

### How Hiding Skills Works

Skills live in up to seven directories:

| Path | Scope |
|------|-------|
| `.opencode/skills/<name>/` | Project |
| `.claude/skills/<name>/` | Project |
| `.agent/skills/<name>/` | Project |
| `.agents/skills/<name>/` | Project |
| `~/.config/opencode/skills/<name>/` | Global |
| `~/.claude/skills/<name>/` | Global |
| `~/.agents/skills/<name>/` | Global |

When triage is ON, skills are hidden from the LLM using three layers of hooks — no file renaming needed:

1. **`tool.definition`** — Replaces the built-in `skill` tool description with "Use `triage` instead"
2. **`system.transform`** — Strips the `<available_skills>` XML block from the system prompt
3. **`tool.execute.before`** — Intercepts any stray `skill()` calls and blocks them

`SKILL.md` files stay intact on disk. Other AI tools (Claude Code, Cursor, Windsurf) scanning the same directories still see them normally.

The CLI can still rename files (`SKILL.md` ↔ `SKILL.md.disabled`) as a fallback for older OpenCode versions without hook support, and to migrate users upgrading from the old file-rename mode. On startup, any remaining `.disabled` files are restored to `.md` since hooks handle hiding.

The `/triage status` command shows skills grouped by scope with `[hidden]`/`[exposed]` badges, detecting state from both hook config and file extensions. It warns when the plugin is ACTIVE but some skills remain exposed (out-of-sync state).

`/triage status --json` reports both file-level state (`fileHidden`, `fileExposed`) and prompt-level effective state (`promptHidden`, `promptExposed`, `hideMode`). On Windows, if both `~/.config/opencode/opencode.json*` and `%APPDATA%/opencode/opencode.json*` exist, status also reports whether each contains the plugin plus redacted config hashes and differing top-level sections.

### How Routing Works

The triage router is a registered plugin tool. When called, it runs a deterministic routing process:

1. **Discover** — Scans directories for skill files, extracts name and description from frontmatter. Results are cached in memory (5s TTL) so CLI toggles are picked up without restart. The cache stores only skill metadata (name, description, path) — minimal RAM usage, typically a few KB even with dozens of skills.

2. **Match** — Scores query keywords against each skill — exact word match = 15pts, partial = 10pts. Found in name → ×3, found in description → ×1. Name matches dominate. IDF weighting downweights common words and boosts rare, discriminating terms. Bigram and exact phrase bonuses reward skills whose descriptions match query phrasing. Position decay weights earlier query words more heavily. Lightweight stemming normalizes inflected forms (`vulnerabilities` → `vulnerability`). Project-scoped skills get a small tiebreaker bonus (+5) over equally-matched global skills.

3. **Spell Correction** — If a query word (length ≥ 4) has no exact match in any skill name or description, the plugin computes Levenshtein distance against all skill vocabulary and suggests the closest match (distance ≤ 2). The hint is injected into the tool result for the LLM to self-correct silently.

4. **Route** — Auto-selects the clear winner (gap ≥ 30) or returns a top-5 shortlist for manual pick. Spell correction hints are included in all response paths so the LLM can retry with the corrected term if needed.

5. **Load** — Reads the matched file, strips frontmatter, returns the instructions.

6. **Notify** — Shows a TUI toast confirming the routing result.

### Code Structure

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point, tool registration, hook setup |
| `discovery.ts` | File scanning, skill reading, rename migration |
| `scoring.ts` | Scoring pipeline: IDF, bigram/phrase bonuses, stemming, position decay |
| `spellcheck.ts` | Levenshtein distance, spell correction suggestions |
| `config.ts` | Constants, types, triage state, JSONC parsing |
| `remote.ts` | Remote skill search (registry, superpowers) |
| `utils.ts` | Shared utilities: stripBOM, frontmatter extraction, regex helpers, security |

## Compatibility

- OpenCode 1.14+
- Bun runtime (bundled with OpenCode)
- Node.js 18+ (for CLI script)

## License

MIT
