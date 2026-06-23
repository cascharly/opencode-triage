/*
 * opencode-triage — Skill Router Plugin
 * ======================================
 * Version: 1.3.0
 * License: MIT
 *
 * Deterministic skill routing for OpenCode. Registers a `triage()` custom tool
 * that discovers SKILL.md files and routes LLM queries to matching skills via
 * keyword scoring.
 *
 * Layers of defense (no file renaming needed when hooks are available):
 *   1. tool.definition    — replaces built-in `skill` tool description
 *   2. system.transform   — strips <available_skills> from system prompt
 *   3. tool.execute.before — intercepts stray skill() calls
 *   4. File rename        — CLI fallback when hooks not supported
 *
 * Install:  { "plugin": ["opencode-triage"] }  in opencode.json
 * Toggle:   /triage on   |   /triage off
 * Docs:     https://github.com/cascharly/opencode-triage
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { join } from "node:path"
import { createRequire } from "node:module"
import { buildSkillLocations, discoverAllSkills, renameSkills } from "./discovery.ts"
import { scoreSkillsSemantic, scoreSkills } from "./scoring.ts"
import { suggestCorrections } from "./spellcheck.ts"
import { embed, getOrComputeEmbeddings, getLoadError, preloadModelIfCached } from "./embeddings.ts"
import type { loadModel } from "./embeddings.ts"
import { checkTriageState, resolveAmbientConfig, AMBIENT_MIN_SEMANTIC } from "./config.ts"
import type { SkillEntry, AmbientConfig } from "./config.ts"

const require = createRequire(import.meta.url)
const CURRENT_VERSION: string = (() => {
  try { return require("../package.json").version }
  catch { return "0.0.0" }
})()

function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na > nb) return true
    if (na < nb) return false
  }
  return false
}

async function checkForUpdate(tui: any): Promise<void> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const res = await fetch("https://registry.npmjs.org/opencode-triage/latest", {
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return
    const pkg = await res.json() as { version?: string }
    const latest = pkg.version
    if (latest && semverGt(latest, CURRENT_VERSION)) {
      await tui.showToast({
        body: {
          message: `Update available: ${CURRENT_VERSION} → ${latest} — npm install -g opencode-triage@latest`,
          variant: "warning",
        },
      })
    }
  } catch {
    // Silent fail — network errors are non-critical
  }
}

/**
 * Triage skill router plugin — main entry point.
 *
 * Registers the `triage` and `notify` custom tools, plus a layered
 * defense system that hides the native `skill` tool from the LLM:
 *
 *   Layer 1: `tool.definition` — replaces skill tool description
 *   Layer 2: `experimental.chat.system.transform` — strips skills XML
 *   Layer 3: `tool.execute.before` — intercepts stray skill() calls
 *   Fallback: CLI file rename — when hooks aren't supported
 *
 * Skills are discovered from SKILL.md (primary) with SKILL.md.disabled
 * as fallback for users on older OpenCode versions.
 */
export const server: Plugin = async ({ worktree, client }, options) => {
  // Cache: discovered skills, populated once on first call.
  // Only invalidated by explicit rescan.
  let cache: SkillEntry[] | null = null


  // Embedding — preload model in background if cached on disk.
  let embeddingModel: Awaited<ReturnType<typeof loadModel>> | null = null
  let embeddingCache: Map<string, number[]> | null = null
  const embeddingPreload: Promise<any | null> = preloadModelIfCached()
    .then(m => { embeddingModel = m; return m })
    .catch(() => null)

  // Rate limiting: track triage calls to prevent excessive LLM tool usage
  // Mitigates unbounded consumption attacks (LLM010)
  let triageCallCount = 0
  let triageCallWindowStart = Date.now()
  const TRIAGE_MAX_CALLS = 20
  const TRIAGE_WINDOW_MS = 60_000 // 60 seconds

  /**
   * Checks if the triage tool is within its rate limit.
   *
   * Resets the counter if the time window has elapsed. Returns false
   * if the maximum number of calls has been exceeded within the window.
   *
   * @returns true if the call is allowed, false if rate limited
   */
  function checkTriageRateLimit(): boolean {
    const now = Date.now()
    if (now - triageCallWindowStart > TRIAGE_WINDOW_MS) {
      triageCallCount = 0
      triageCallWindowStart = now
    }
    triageCallCount++
    return triageCallCount <= TRIAGE_MAX_CALLS
  }

  /**
   * Returns cached skills. Discovers once on first call — never rescans
   * automatically. Use the rescan tool after adding/modifying skill files.
   */
  async function getCachedSkills(): Promise<SkillEntry[]> {
    if (cache === null) {
      const locations = buildSkillLocations(worktree)
      cache = await discoverAllSkills(locations, getExcludedSkills)
    }
    return cache
  }

  /**
   * Returns pre-computed embeddings for the given skills.
   * Embedding cache matches skill cache lifetime — only refreshed on rescan.
   */
  async function ensureEmbeddings(skills: SkillEntry[]): Promise<Map<string, number[]> | null> {
    if (embeddingCache !== null) return embeddingCache

    await embeddingPreload
    if (!embeddingModel) return null

    embeddingCache = await getOrComputeEmbeddings(skills, embeddingModel)
    return embeddingCache
  }

  // Show semantic-unavailable toast at most once per session
  let semanticUnavailableToastShown = false

  /**
   * Rescans the filesystem to rediscover skills and recompute embeddings.
   * Call after adding/modifying/removing SKILL.md files.
   */
  async function rescanSkills(): Promise<{ discovered: number; embeddings: number }> {
    cache = null
    embeddingCache = null
    const locations = buildSkillLocations(worktree)
    const skills = await discoverAllSkills(locations, getExcludedSkills)
    cache = skills
    let embedCount = 0
    if (embeddingModel) {
      embeddingCache = await getOrComputeEmbeddings(skills, embeddingModel)
      embedCount = embeddingCache.size
    }
    return { discovered: skills.length, embeddings: embedCount }
  }

  let triageStateCache: "on" | "off" | "unknown" | null = null

  async function getTriageState(): Promise<"on" | "off" | "unknown"> {
    if (triageStateCache === null) {
      triageStateCache = await checkTriageState(worktree, options)
    }
    return triageStateCache
  }

  // Ambient suggestion config.
  // Computed once at startup — restart after editing opencode.json.
  let ambientConfigCache: AmbientConfig | null = null
  function getAmbientConfig(): AmbientConfig {
    if (ambientConfigCache === null) {
      ambientConfigCache = resolveAmbientConfig(worktree, options)
    }
    return ambientConfigCache
  }

  /**
   * Builds the ambient candidate block for a query, or null if nothing qualifies.
   *
   * Uses semantic embedding scoring when available. Falls back to keyword
   * scoring if @xenova/transformers or onnxruntime-node are not installed
   * or fail to initialize (e.g. sharp native binary can't install).
   */
  async function buildSuggestionBlock(query: string, skipNames?: Set<string>): Promise<{ block: string; names: string[] } | null> {
    const cfg = getAmbientConfig()
    const skills = await getCachedSkills()
    if (skills.length === 0) return null

    const embeddings = await ensureEmbeddings(skills)
    let allScored: ReturnType<typeof scoreSkillsSemantic> | ReturnType<typeof scoreSkills>
    if (embeddings && embeddingModel) {
      const queryEmbedding = await embed(embeddingModel, query)
      allScored = scoreSkillsSemantic(queryEmbedding, skills, embeddings)
    } else {
      if (!semanticUnavailableToastShown) {
        semanticUnavailableToastShown = true
        const err = getLoadError()
        await client.tui.showToast({
          body: { message: err
            ? `Semantic matching unavailable — falling back to keyword. Tip: run npm install in the triage plugin directory.`
            : `Semantic matching unavailable — install @xenova/transformers and onnxruntime-node for cross-lingual support.`,
            variant: "warning",
          },
        })
      }
      allScored = scoreSkills(query, skills)
    }

    const scored = allScored
      .filter(s => s.score >= cfg.ambientMinScore && !skipNames?.has(s.name))
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.ambientMaxCandidates)
    if (scored.length === 0) return null
    const names = scored.map(s => s.name)
    const block = [
      "<suggested_skills>",
      "The following installed skills may be relevant to the current message.",
      'If one fits, call skill({ name: "<skill name>" }) to load its full instructions, then follow them.',
      ...scored.map(s => {
        const desc = s.desc.length > 80 ? s.desc.slice(0, 77) + "..." : s.desc
        return `- ${s.name}: ${desc}`
      }),
      "</suggested_skills>",
    ].join("\n")
    return { block, names }
  }

  // Exclude the triage skill itself — self-referencing would create infinite loops
  // Can be overridden via OPENCODE_TRIAGE_EXCLUDED env var (comma-separated)
  // Fixes edge case #13: previously hardcoded, no way to allow a skill named "triage"
  const getExcludedSkills = (): Set<string> => {
    const env = process.env.OPENCODE_TRIAGE_EXCLUDED
    if (env) return new Set(env.split(",").map(s => s.trim()).filter(Boolean))
    return new Set(["triage"])
  }

  // Definition hook state tracking
  let definitionHookFired = false
  let migrationCompleted = false

  // Hook support detection: tool.definition fires before any tool execution.
  // If it hasn't fired by the first triage() call, hooks aren't supported.
  let hooksConfirmed = false
  let fallbackTriggered = false

  /**
   * Migrates any remaining .disabled files to .md when hooks are detected.
   *
   * Called once on first definition hook fire. Ensures users upgrading
   * from file-rename mode to hooks mode have their skills restored.
   */
  async function remigrateIfHooksDetected() {
    if (migrationCompleted) return
    migrationCompleted = true
    const count = await renameSkills(".md.disabled", getExcludedSkills)
    if (count > 0) {
      await client.tui.showToast({
        body: { message: `Migrated ${count} skill(s) from file-rename to hooks mode`, variant: "info" },
      })
    }
  }

  // Startup: show status toast based on current triage state.
  // Do NOT restore .disabled files here — wait for hooks to confirm support.
  // If hooks fire, remigrateIfHooksDetected() restores them.
  // If hooks don't fire, skills stay hidden via .disabled files (file-rename fallback).
  ;(async () => {
    const state = await getTriageState()
    if (state === "on") {
      const skills = await getCachedSkills()
      const projectN = skills.filter(s => s.scope === "project").length
      const globalN = skills.filter(s => s.scope === "global").length
      if (projectN > 0 || globalN > 0) {
        await client.tui.showToast({
          body: { message: `${projectN + globalN} skill(s) managed by triage`, variant: "info" },
        })
      }
    } else if (state === "unknown") {
      await client.tui.showToast({
        body: { message: `Triage installed — run /triage on to enable`, variant: "warning" },
      })
    }
    checkForUpdate(client.tui)
  })()

  // Context accumulation for ambient scoring. _contextText accumulates all
  // message text within a single user turn (reset on each user message).
  // _suggested tracks skill names already injected this turn for dedup.
  // _firstInsert controls inject position: prepend on first, append on later.
  let _contextText = ""
  let _suggested = new Set<string>()
  let _firstInsert = false

  return {
    tool: {
      /**
       * triage — Main skill routing tool.
       *
       * Takes a natural language query, discovers available skills, scores
       * them by relevance, and returns the best match or a list of candidates.
       *
       * Response paths:
       *   - No skills installed → instructions for adding skills
       *   - No matches → remote search fallback with spell correction hint
       *   - Single clear winner → skill content with routing metadata
       *   - Multiple close matches → candidate list for LLM to choose
       *
       * Spell correction hints are injected into all response paths when
       * unmatched query words are detected.
       *
       * Optional `toast` arg shows a TUI notification to the user.
       */
      triage: tool({
         description:
           "Discover installed skills. Call with query: a brief task description. " +
           "Example: triage({ query: \"backup my database\" }). " +
           "Returns matching skill names with descriptions and scores. " +
           "If a skill fits, call skill({ name: \"<name>\" }) to load its instructions.",
        args: {
          query: tool.schema.string().describe(
            "Brief description of what you need help with, e.g. 'backup my database'"
          ),
          toast: tool.schema.object({
            message: tool.schema.string().describe("Toast message to show to user"),
            variant: tool.schema.enum(["info", "success", "error", "warning"]).optional().default("info").describe("Toast style"),
          }).optional().describe("Optional: show a toast notification to the user"),
        },
        async execute(args, context) {
          // Show optional toast notification
          if (args.toast) {
            const validVariants = ["info", "success", "error", "warning"] as const
            const variant = validVariants.includes(args.toast.variant as typeof validVariants[number])
              ? (args.toast.variant as typeof validVariants[number])
              : "info"
            await client.tui.showToast({
              body: { message: args.toast.message, variant },
            })
          }

          // Detect hook support: tool.definition fires before any tool execution.
          // If it hasn't fired by now, hooks aren't supported — auto-fallback to file-rename mode.
          if (!hooksConfirmed && !fallbackTriggered) {
            fallbackTriggered = true
            const count = await renameSkills(".md", getExcludedSkills)
            if (count > 0) {
              await client.tui.showToast({
                body: { message: `Hooks not supported — ${count} skill(s) hidden via file-rename mode`, variant: "warning" },
              })
            }
          }

          if (!checkTriageRateLimit()) {
            return "Triage rate limit exceeded (20 calls/60s). Please wait before retrying."
          }

          const query = (args.query ?? "").trim()
          if (!query) {
            return "Call triage with a query, e.g. triage({ query: \"backup my database\" })"
          }

          if (context.abort.aborted) {
            return "Triage cancelled."
          }

          const skills = await getCachedSkills()

          // Spell correction: detect unmatched words and suggest fixes
          const corrections = suggestCorrections(query, skills)
          const hint = corrections.length > 0
            ? `Hint: Unmatched words corrected: ${corrections.join(", ")}`
            : ""

          if (skills.length === 0) {
            return [
              "No skills installed.",
              "",
              "To add a skill:",
              "",
              "  Project:",
              "    .opencode/skills/<name>/SKILL.md",
              "    .claude/skills/<name>/SKILL.md",
              "    .agent/skills/<name>/SKILL.md",
              "    .agents/skills/<name>/SKILL.md",
              "",
              "  Global:",
              "    ~/.config/opencode/skills/<name>/SKILL.md",
              "    ~/.claude/skills/<name>/SKILL.md",
              "    ~/.agents/skills/<name>/SKILL.md",
              "",
              "Use /triage status to verify your setup.",
            ].join("\n")
          }

          const embeddings = await ensureEmbeddings(skills)

          let scored: ReturnType<typeof scoreSkillsSemantic> | ReturnType<typeof scoreSkills>
          if (embeddings && embeddingModel) {
            const queryEmbedding = await embed(embeddingModel, query)
            scored = scoreSkillsSemantic(queryEmbedding, skills, embeddings)
          } else {
            scored = scoreSkills(query, skills)
          }

          scored = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)

          if (scored.length === 0) {
            const findSkills = skills.find(s => s.name.toLowerCase() === "find-skills")
            if (findSkills) {
              const lines = [
                `No local skill matches "${query}". Try calling skill({ name: "find-skills" }) to search remote skills.`,
              ]
              if (hint) lines.push(hint)
              return lines.join("\n")
            }
            const { searchRemoteSkills, searchSuperpowers } = await import("./remote.ts")
            const [skillsSh, superpowers] = await Promise.all([
              searchRemoteSkills(query),
              searchSuperpowers(),
            ])
            const combined = [skillsSh, superpowers].filter(Boolean).join("")
            return `No skill matches "${query}". Try different keywords.${hint ? "\n\n" + hint : ""}${combined}`
          }

          // Build candidate list with scores
          const top = scored.slice(0, 8)
          const lines = [
            scored.length === 1
              ? `Best match for "${query}". Use skill({ name: "${scored[0].name}" }) to load it.`
              : `Found ${scored.length} matching skill(s) for "${query}". Use skill({ name }) to load the one you need:`,
            ``,
          ]
          top.forEach((s, i) => {
            const desc = s.desc.length > 100 ? s.desc.slice(0, 97) + "..." : s.desc
            lines.push(`${i + 1}. ${s.name} (score: ${s.score}) — ${desc}`)
          })
          if (hint) {
            lines.push(``)
            lines.push(hint)
          }
          return lines.join("\n")
        },
      }),
      "list-skills": tool({
        description:
          "List all installed skills as an <available_skills> XML block. " +
          "Returns name and description for every skill so you can browse the full catalog. " +
          "Use triage instead when you have a specific task — it scores relevance.",
        args: {},
        async execute(_args, _context) {
      const skills = await getCachedSkills()
          if (skills.length === 0) {
            return [
              "Skills provide specialized instructions and workflows for specific tasks.",
              "Use the skill tool to load a skill when a task matches its description.",
              "<available_skills>",
              "  <!-- No skills installed -->",
              "</available_skills>",
            ].join("\n")
          }
          const lines = [
            "Skills provide specialized instructions and workflows for specific tasks.",
            "Use the skill tool to load a skill when a task matches its description.",
            "<available_skills>",
          ]
          for (const s of skills) {
            lines.push(`  <skill>`)
            lines.push(`    <name>${s.name}</name>`)
            lines.push(`    <description>${s.desc}</description>`)
            lines.push(`  </skill>`)
          }
          lines.push("</available_skills>")
          return lines.join("\n")
        },
      }),
      "rescan": tool({
        description:
          "Re-scan the filesystem to discover new, modified, or removed skills. " +
          "Call after adding or editing SKILL.md files.",
        args: {},
        async execute(_args, _context) {
          const result = await rescanSkills()
          const embedInfo = result.embeddings > 0
            ? `, ${result.embeddings} embedding(s) refreshed`
            : ""
          return `Rescan complete. ${result.discovered} skill(s) found${embedInfo}.`
        },
      }),
    },
    // ── Skill tool hook detection ────────────────────────
    // tool.definition fires once per tool at registration time.
    // We use it to detect hook support globally, and when the skill tool
    // is registered we also trigger remigration if triage is ON.
    // We do NOT override the native description — <available_skills> is
    // a system context source (not part of tool description), stripped by
    // system.transform independently.
    "tool.definition": async (input, _output) => {
      hooksConfirmed = true
      if (input.toolID !== "skill") return
      const wasHookFired = definitionHookFired
      definitionHookFired = true
      const state = await getTriageState()
      if (state !== "on") return
      if (!wasHookFired) await remigrateIfHooksDetected()
    },
    "chat.message": async (input, output) => {
      const cfg = getAmbientConfig()
      if (!cfg.autoSuggest) return
      const isUser = input.info?.type === "user" || input.info?.role === "user"
      if (isUser) { _contextText = ""; _suggested = new Set(); _firstInsert = false }
      const text = (output.parts ?? [])
        .filter((p: any) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
        .map((p: any) => p.text as string)
        .join(" ")
        .trim()
      if (text) _contextText += (_contextText ? " " : "") + text
    },
    // ── Ephemeral suggestion injection ──────────────────────
    // experimental.chat.messages.transform fires on every LLM request step.
    // Injected parts are visible to the LLM for this turn only — output.messages
    // is re-fetched from DB each iteration, so mutations never persist.
    "experimental.chat.messages.transform": async (_input, output) => {
      const cfg = getAmbientConfig()
      if (!cfg.autoSuggest || !_contextText) return
      let result = await buildSuggestionBlock(_contextText, _suggested)
      // Stale _suggested from a previous session (same process) can block all
      // candidates because buildSuggestionBlock filters out every name it contains.
      // When that happens, clear the stale dedup set and retry once.
      if (!result && _suggested.size > 0) {
        _suggested = new Set()
        result = await buildSuggestionBlock(_contextText, _suggested)
      }
      if (!result) return
      for (const n of result.names) _suggested.add(n)
      const msgs = output.messages ?? []
      const part = { type: "text", text: result.block, synthetic: true } as any
      if (!_firstInsert) {
        _firstInsert = true
        const lastUser = [...msgs].reverse().find((m: any) => m.info?.type === "user" || m.info?.role === "user")
        if (lastUser) {
          lastUser.parts.unshift(part)
          return
        }
      }
      msgs.push({ info: { type: "user", role: "user" }, parts: [part] } as any)
    },
    // ── System prompt cleanup ─────────────────────────────
    // Strips the <available_skills> XML block from the system prompt
    // as a belt-and-suspenders measure alongside tool.definition.
    "experimental.chat.system.transform": async (_input, output) => {
      const state = await getTriageState()
      if (state !== "on") return
      if (!migrationCompleted) await remigrateIfHooksDetected()
      const re = /<available_skills>[\s\S]*?<\/available_skills>/g
      for (let i = 0; i < output.system.length; i++) {
        output.system[i] = output.system[i].replace(re, "")
      }
    },
    // ── Skill call passthrough ───────────────────────────
    // Native skill() is now allowed — triage handles discovery,
    // skill() handles loading. No interception needed.
    // ── Notification routing ────────────────────────────
    // Catches triage results to show TUI toasts.
    "tool.execute.after": async (input, output) => {
      const result = output.output
      if (typeof result !== "string") return
      if (input.tool === "triage") {
        const first = result.split("\n")[0] ?? ""
        if (first.startsWith("Best match for")) {
          await client.tui.showToast({
            body: { message: "Skill found — load it with skill({ name })", variant: "success" },
          })
        } else if (first.startsWith("Found")) {
          await client.tui.showToast({
            body: { message: "Multiple skills matched — pick one", variant: "info" },
          })
        } else if (first.startsWith("No skill matches") || first.startsWith("No local skill matches")) {
          await client.tui.showToast({
            body: { message: "No matching skill found — try different keywords", variant: "error" },
          })
        } else if (first.startsWith("No skills installed")) {
          await client.tui.showToast({
            body: { message: "No skills installed — add SKILL.md files to get started", variant: "info" },
          })
        }
      }
    },
  }
}
