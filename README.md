# opencode-triage

> OpenCode lists every installed skill in the prompt. Triage hides that full catalog, suggests relevant skills for the current message, and lets the model load only the instructions it needs. Matching uses keywords or optional local multilingual embeddings.

## Quick Start

```bash
npm install -g opencode-triage
```

Restart OpenCode, then type `/triage on`. For multilingual matching, optionally run `npx opencode-triage download-model` and restart again.

## What It Does

OpenCode lists every skill's name and description in the prompt on every message. With many skills, that burns hundreds of tokens before you type a word.

Triage hides all skills from the prompt. When you need one, the LLM calls `triage()` — the plugin returns matching skills by keyword scoring. The LLM then loads the chosen instructions with `skill` or the legacy `load-skill` fallback.

```
No triage:   [name+desc of A] [name+desc of B] [name+desc of C] ...  ← every message
With triage: relevant suggestions or triage({ query }) -> skill({ name }) loads chosen instructions
```

Prompt savings depend on the catalog size, tool definitions, and suggested candidates. Use `/triage compare` for a catalog estimate; per-message suggestions add a small variable cost.

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
| `/triage compare` | Catalog token savings estimate (excludes variable suggestions) |
| `/triage download-model` | Download the optional multilingual models once, then restart OpenCode |

> **Note:** Skills are hidden via hooks at the LLM prompt level — `SKILL.md` files stay intact on disk, so other AI tools (Cursor, Claude Code, Windsurf) still see them. File renaming (`SKILL.md` ↔ `SKILL.md.disabled`) is only used as a fallback for older OpenCode versions without hook support. When files are renamed to `.disabled`, they will also be hidden from other AI tools that scan the same directories.

### Flags

| Flag | Where | What it does |
|------|-------|--------------|
| `--json` | status, compare, version, help, download-model, dedupe preview | Machine-readable JSON output |
| `--quiet` | on/off | Suppress non-error output |
| `--dry-run` | dedupe | Preview changes without renaming |
| `--all` | status | Show full skill list without truncation |
| `--no-second-pass` | download-model | Download only the smaller first-pass model |

All commands also work in your terminal: `npx opencode-triage <command>`. No OpenCode session needed.

For automation, call `npx opencode-triage <command> --json` directly and ensure any wrapper writes its own warnings to stderr, not stdout. A wrapper that prepends text to stdout will make otherwise-valid JSON unparseable.

### Configuration Combinations

| State | Global | Project | How to configure |
|---|---|---|---|
| Full exposure | exposed | exposed | `/triage off` (default) |
| Full triage | hidden | hidden | `/triage on` |
| Triage globally only | hidden | exposed | `/triage on --global` |
| Triage in project only | exposed | hidden | `/triage on --local` |

Global affects `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, and `~/.gemini/config/skills/`.
Local affects `.opencode/skills/`, `.claude/skills/`, `.agent/skills/`, `.agents/skills/` in the current project.

## How It Works

Triage suggests up to three relevant skills for each user message. The LLM can also call `triage()` to search explicitly, then load a chosen skill with `skill({ name })` or the legacy `load-skill` fallback.

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
  Returns a scored shortlist; the model chooses which skill to load.
```

Matching requires no extra LLM API calls. Optional semantic matching runs cached models locally in two consecutive evaluations; keyword matching is used when no model is available.

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

Skills are discovered from project and global skill directories:

| Path | Scope |
|------|-------|
| `.opencode/skills/<name>/` | Project |
| `.claude/skills/<name>/` | Project |
| `.agent/skills/<name>/` | Project |
| `.agents/skills/<name>/` | Project |
| `~/.config/opencode/skills/<name>/` | Global |
| `~/.claude/skills/<name>/` | Global |
| `~/.agents/skills/<name>/` | Global |
| `~/.gemini/config/skills/<name>/` | Global |

When triage is ON, hooks hide the full skill catalog while keeping loading available:

1. **`tool.definition`** replaces the native skill description with compact loading instructions.
2. **`system.transform`** strips the `<available_skills>` XML block from the system prompt.
3. Native `skill()` calls load discovered skills. `load-skill()` handles legacy `.disabled` files.

`SKILL.md` files stay intact on disk. Other AI tools (Claude Code, Cursor, Windsurf) scanning the same directories still see them normally.

The CLI can still rename files (`SKILL.md` ↔ `SKILL.md.disabled`) as a fallback for older OpenCode versions without hook support, and to migrate users upgrading from the old file-rename mode. On startup, any remaining `.disabled` files are restored to `.md` since hooks handle hiding.

The `/triage status` command shows skills grouped by scope with `[hidden]`/`[exposed]` badges, detecting state from both hook config and file extensions. It warns when the plugin is ACTIVE but some skills remain exposed (out-of-sync state).

`/triage status --json` reports both file-level state (`fileHidden`, `fileExposed`) and prompt-level effective state (`promptHidden`, `promptExposed`, `hideMode`). On Windows, if both `~/.config/opencode/opencode.json*` and `%APPDATA%/opencode/opencode.json*` exist, status also reports whether each contains the plugin plus redacted config hashes and differing top-level sections.

### How Routing Works

The triage router is a registered plugin tool. When called, it runs a deterministic routing process:

1. **Discover** — Scans directories for skill files, extracts name and description from frontmatter. Results are cached in memory (5s TTL) so CLI toggles are picked up without restart. The cache stores only skill metadata (name, description, path) — minimal RAM usage, typically a few KB even with dozens of skills.

2. **Match** — With the optional models cached, matching uses multilingual embeddings in two consecutive evaluations (see [Optional multilingual semantic matching](#optional-multilingual-semantic-matching)). Otherwise it scores query keywords against each skill — exact word match = 15pts, partial = 10pts. Found in name → ×3, found in description → ×1. Name matches dominate. IDF weighting downweights common words and boosts rare, discriminating terms. Bigram and exact phrase bonuses reward skills whose descriptions match query phrasing. Position decay weights earlier query words more heavily. Lightweight stemming normalizes inflected forms (`vulnerabilities` → `vulnerability`). Project-scoped skills get a small tiebreaker bonus (+5) over equally-matched global skills.

3. **Spell Correction** — If a query word (length ≥ 4) has no exact match in any skill name or description, the plugin computes Levenshtein distance against all skill vocabulary and suggests the closest match (distance ≤ 2). The hint is injected into the tool result for the LLM to self-correct silently.

4. **Search** returns up to eight scored candidates and spell correction hints without loading skill instructions.

5. **Load** uses native `skill({ name })` for active files, or `load-skill({ name })` for file-hidden results.

6. **Notify** — Shows a TUI toast confirming the routing result.

### Code Structure

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry point, tool registration, hook setup |
| `discovery.ts` | File scanning, skill reading, rename migration |
| `scoring.ts` | Scoring pipeline: IDF, bigram/phrase bonuses, stemming, position decay, two-pass semantic scores |
| `embeddings.ts` | Optional local embedding models and on-disk vector caches |
| `spellcheck.ts` | Levenshtein distance, spell correction suggestions |
| `config.ts` | Constants, types, triage state, JSONC parsing |
| `remote.ts` | Remote skill search (registry, superpowers) |
| `utils.ts` | Shared utilities: stripBOM, frontmatter extraction, regex helpers, security |

## Compatibility

The same package selects the supported API automatically:

| OpenCode host | Loaded package entry | Configuration |
|---|---|---|
| V1 | `.` / `src/index.ts` | Existing `plugin` strings or tuples |
| V2 | `./server` / `src/server.ts` | `plugins` strings or package/options objects |

OpenCode V2's official loader resolves `./server` first. Older V1 loaders continue loading the package root, which exports only the callable `server` function. This does not require the V1 object-entrypoint support introduced in 1.18.29 and does not change the existing V1 peer dependency range. An internal V2 setup error is reported instead of silently retrying initialization as V1.

V1 config remains valid and is never rewritten into V2 syntax by the CLI. Existing V2 configs retain their `plugins` format. Toggles preserve other plugin options and version pins.

- V1 installed-package execution tested with SDK 1.14.17 and 1.19.5 under Bun.
- V2 registration and request hooks tested against SDK 2.3.0; the installed package is also loaded with its official host resolver.
- The V2 SDK is a development-only dependency. V1 consumers do not need to install it.
- V2 routes native loads through `skill({ id })`; V1 retains `skill({ name })`. Legacy loads in V2 enforce the host's skill permission rules.
- V2 status notifications currently go to the server log; V1 TUI toasts remain available.
- Basic CLI commands require Node.js 18+. Development tests require Node.js 22+.

Run `npm run check`, `npm test`, and `npm run check:compat` before changing the adapters. The compatibility script requires Bun on PATH, or `BUN_BIN` set to its executable path. It installs the packed artifact in isolated temporary projects rather than relying on workspace links.

## License

MIT

### Search and load tools

`triage` searches installed skills without loading their instructions. Use native `skill({ name })` to load a result, or `load-skill({ name })` for results marked file-hidden. `list-skills` lists the installed catalog on demand. The fallback loader supports legacy `SKILL.md.disabled` files.

Automatic suggestions use only the current user message and expose at most three candidates by default. Configure `autoSuggest`, `ambientMinScore` (default 30), and `ambientMaxCandidates` (default 3, capped at 10) in plugin options. English scoring retains its minimum word length and position decay; Chinese queries use word segmentation.

### Optional multilingual semantic matching

Run `npx opencode-triage download-model` once to download the local multilingual embedding models, then restart OpenCode. The plugin uses only cached model files and never downloads a model during a chat. If optional dependencies, the model, or inference are unavailable, routing falls back to keyword matching. Set the plugin option `semanticMatching: false` to use keyword matching explicitly. Skill discovery retains automatic cache invalidation; `rescan` also refreshes it on demand.

Semantic matching runs two consecutive evaluations:

1. `paraphrase-multilingual-MiniLM-L12-v2` (q8, about 118 MB) compares the message with each skill's `name: description`.
2. When `paraphrase-multilingual-mpnet-base-v2` (q8, about 280 MB) is also cached, it compares the message with three views of each skill: the description, the name as words, and both together. A skill's score is the average of the first similarity and the best second-pass view. The usual thresholds apply (`ambientMinScore`, default 30).

Second-pass skill vectors are built in the background the first time, about a minute for 500 skills on a four-thread laptop CPU. Until then, and whenever the second model is absent or fails, the first model scores alone. Afterwards the second pass adds roughly 30 ms per message and about 540 MiB of resident memory. Use `download-model --no-second-pass` to download only the first model, or set the plugin option `secondPassMatching: false` to disable the second pass.

The model cache is `~/.cache/opencode-triage/models/`. Skill vectors are cached in `~/.cache/opencode-triage/embeddings.json`, with second-pass vectors in a separate `embeddings-<model>.json` file. To run the optional real-model integration test after downloading, set `TRIAGE_TEST_SEMANTIC_MODEL=1` and run `npm test`. The optional model runtime is `@huggingface/transformers`; a modern Node.js runtime (22+ recommended) is needed for model downloads. Basic CLI commands retain Node.js 18+ support.

`dedupe --json` requires `--dry-run` when duplicates exist; omit `--json` to choose interactively which copy to remove.
