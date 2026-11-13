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
import { watch } from "node:fs"
import { createRequire } from "node:module"
import { buildSkillLocations, discoverAllSkills, renameSkills, readSkillContent } from "./discovery.ts"
import { scoreSkills, scoreSkillsSemantic } from "./scoring.ts"
import { loadModel, embed, getOrComputeEmbeddings } from "./embeddings.ts"
import { suggestCorrections } from "./spellcheck.ts"
import { AMBIENT_MIN_SEMANTIC, ALWAYS_EXCLUDED_SKILLS, checkTriageState, resolveAmbientConfig } from "./config.ts"
import type { SkillEntry, AmbientConfig } from "./config.ts"

const require = createRequire(import.meta.url)
const CURRENT_VERSION: string = (() => {
  try { return require("../package.json").version }
  catch { return "0.0.0" }
})()

const { semverGt } = require("../bin/shared.cjs") as { semverGt: (a: string, b: string) => boolean }

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const TOAST_VARIANTS = ["info", "success", "error", "warning"] as const

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
let _lastUpdateCheck = 0
let _lastUpdateResult: string | null = null

async function checkForUpdate(tui: any): Promise<void> {
  const now = Date.now()
  if (now - _lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) {
    if (_lastUpdateResult) {
      await tui.showToast({
        body: {
          message: `Update available: ${CURRENT_VERSION} → ${_lastUpdateResult} — npm install -g opencode-triage@latest`,
          variant: "warning",
        },
      })
    }
    return
  }
  _lastUpdateCheck = now
  _lastUpdateResult = null
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
      _lastUpdateResult = latest
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
  // Cache: discovered skills per worktree, with timestamp for TTL-based invalidation.
  // Augmented with fs.watch directory watchers (set up below) that invalidate
  // immediately when skill files change on disk, so most triage calls hit the
  // in-memory cache without any filesystem polling overhead.
  // The 5s TTL is retained as safe fallback for environments where fs.watch
  // is unavailable or returns incomplete events (e.g. network drives, WSL).
  // Mutex prevents concurrent discovery when multiple triage calls arrive before
  // discovery completes — subsequent calls await the in-flight promise.
  let cache: { skills: SkillEntry[]; timestamp: number } | null = null
  let cacheMutex: Promise<void> | null = null
  const CACHE_TTL_MS = 5_000

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
   * Returns cached skills, re-discovering if the cache has expired or was
   * invalidated by a fs.watch event.
   *
   * Primary invalidation: fs.watch fires synchronously on file changes and
   * sets cache to null. Fallback: 5s TTL for environments where watchers
   * may not fire reliably (network filesystems, WSL, some CI containers).
   * Mutex serializes concurrent calls — only one discovery runs at a time.
   *
   * @returns Array of discovered skill entries
   */
  async function getCachedSkills(): Promise<SkillEntry[]> {
    const now = Date.now()
    if (cache !== null && now - cache.timestamp <= CACHE_TTL_MS) {
      return cache.skills
    }
    if (cacheMutex) {
      await cacheMutex
      return cache!.skills
    }
    cacheMutex = (async () => {
      const locations = buildSkillLocations(worktree)
      const skills = await discoverAllSkills(locations, getExcludedSkills)
      cache = { skills, timestamp: Date.now() }
    })()
    try {
      await cacheMutex
    } finally {
      cacheMutex = null
    }
    return cache!.skills
  }

  // Watch all skill base directories for changes so the cache is
  // invalidated the moment a skill file is added, removed, or renamed — rather
  // than waiting up to 5s for the TTL. Watchers are best-effort: errors and
  // unsupported paths are silently swallowed since the TTL covers the fallback.
  // Close previously created watchers before setting up new ones to prevent
  // resource leaks on hot-reload or worktree change.
  let watchers: ReturnType<typeof watch>[] = []
  const setupWatchers = async () => {
    for (const w of watchers) {
      try { w.close() } catch { /* ignore close errors */ }
    }
    watchers = []
    try {
      const locations = buildSkillLocations(worktree)
      for (const { base } of locations) {
        try {
          watchers.push(watch(base, { recursive: true }, () => { cache = null }).unref())
        } catch {
          // Directory may not exist yet — watcher will not be set up for it.
          // The 5s TTL fallback handles this case.
        }
      }
    } catch {
      // Ignore errors in watcher setup — TTL fallback is always present.
    }
  }
  setupWatchers()

  // Cache triage state so hooks don't re-read config files on every call
  let triageStateCache: { state: "on" | "off" | "unknown"; ts: number } | null = null

  /**
   * Returns the cached triage state, re-checking if the cache has expired.
   *
   * @returns Current triage state: "on", "off", or "unknown"
   */
  async function getTriageState(): Promise<"on" | "off" | "unknown"> {
    const now = Date.now()
    if (triageStateCache === null || now - triageStateCache.ts > CACHE_TTL_MS) {
      triageStateCache = { state: await checkTriageState(worktree, options), ts: now }
    }
    return triageStateCache.state
  }

  // ALWAYS_EXCLUDED_SKILLS is the immutable invariant — "triage" can never be routed to.
  // OPENCODE_TRIAGE_EXCLUDED can add additional exclusions on top, but cannot remove
  // entries from ALWAYS_EXCLUDED_SKILLS. This guarantees no infinite self-referencing loops
  // regardless of user configuration.
  let semanticCache: { skills: SkillEntry[]; vectors: Map<string, number[]> } | null = null
  async function scoreAvailableSkills(query: string, skills: SkillEntry[]) {
    if (options?.semanticMatching === false) return scoreSkills(query, skills)
    try {
      const model = await loadModel()
      if (!model) return scoreSkills(query, skills)
      if (!semanticCache || semanticCache.skills !== skills) {
        semanticCache = { skills, vectors: await getOrComputeEmbeddings(skills, model) }
      }
      if (semanticCache.vectors.size !== skills.length) return scoreSkills(query, skills)
      const queryVector = await embed(model, query)
      return scoreSkillsSemantic(queryVector, skills, semanticCache.vectors)
        .map(skill => skill.descScore >= AMBIENT_MIN_SEMANTIC ? skill : { ...skill, score: 0 })
    } catch {
      return scoreSkills(query, skills)
    }
  }

  let ambientConfigCache: { cfg: AmbientConfig; ts: number } | null = null
  function getAmbientConfig(): AmbientConfig {
    const now = Date.now()
    if (ambientConfigCache === null || now - ambientConfigCache.ts > CACHE_TTL_MS) {
      ambientConfigCache = { cfg: resolveAmbientConfig(worktree, options), ts: now }
    }
    return ambientConfigCache.cfg
  }

  /**
   * Builds the ambient candidate block for a query, or null if nothing qualifies.
   *
   * Scores all discovered skills, keeps those at/above the configured floor,
   * takes the top-K, and renders a compact name+desc list that tells the model
   * to call triage() to load the full instructions. Only name+desc is injected
   * (never full content) to keep per-turn token cost minimal.
   */
  async function buildSuggestionBlock(query: string): Promise<{ block: string; names: string[] } | null> {
    const cfg = getAmbientConfig()
    const skills = await getCachedSkills()
    if (skills.length === 0) return null
    const allScored = await scoreAvailableSkills(query, skills)
    const scored = allScored
      .filter(s => s.score >= cfg.ambientMinScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.ambientMaxCandidates)
    if (scored.length === 0) return null
    const names = scored.map(s => s.name)
    const block = [
      "<suggested_skills>",
      "The following installed skills may be relevant to the current message.",
      'If one fits, call skill({ name: "<skill name>" }) (or load-skill for file-hidden skills) to load its full instructions, then follow them.',
      ...scored.map(s => {
        const desc = s.desc.length > 80 ? s.desc.slice(0, 77) + "..." : s.desc
        return `- ${s.name}${s.path.endsWith(".disabled") ? " [file-hidden]" : ""}: ${desc}`
      }),
      "</suggested_skills>",
    ].join("\n")
    return { block, names }
  }

  const getExcludedSkills = (): Set<string> => {
    const env = process.env.OPENCODE_TRIAGE_EXCLUDED
    if (!env) return ALWAYS_EXCLUDED_SKILLS
    const extra = env.split(",").map(s => s.trim()).filter(Boolean)
    return new Set([...ALWAYS_EXCLUDED_SKILLS, ...extra])
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
  // Wrapped in try/catch to prevent unhandled promise rejection from crashing
  // the plugin host if getTriageState() or getCachedSkills() throws on startup
  ;(async () => {
    try {
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
    } catch (err) {
      console.error("[opencode-triage] Startup error:", err)
    }
  })()

  return {
    dispose: async () => {
      for (const watcher of watchers) watcher.close()
      watchers = []
    },
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
           "Discover installed skills by keyword search. " +
           "Call this FIRST before any task to check if a specialized skill exists. " +
           "Returns matching skill names with descriptions and relevance scores. " +
           "To load instructions, call skill({ name }) or load-skill({ name }) for file-hidden skills. " +
           "Pass a brief description of your task as the query.",
        args: {
          query: tool.schema.string().optional().describe(
            "Brief description of what you need help with, e.g. 'backup my database'"
          ),
          toast: tool.schema.object({
            message: tool.schema.string().describe("Toast message to show to user"),
            variant: tool.schema.enum(["info", "success", "error", "warning"]).optional().default("info").describe("Toast style"),
          }).optional().describe("Optional: show a toast notification to the user"),
        },
        async execute(args, context) {
          if (args.toast) {
            const variant = TOAST_VARIANTS.includes(args.toast.variant as typeof TOAST_VARIANTS[number])
              ? (args.toast.variant as typeof TOAST_VARIANTS[number])
              : "info"
            await client.tui.showToast({
              body: { message: args.toast.message, variant },
            })
          }

          // Detect hook support: tool.definition fires before any tool execution.
          // If it hasn't fired by now, hooks aren't supported — auto-fallback to file-rename mode.
          if (!hooksConfirmed && !fallbackTriggered && await getTriageState() === "on") {
            fallbackTriggered = true
            const count = await renameSkills(".md", getExcludedSkills)
            if (count > 0) {
              await client.tui.showToast({
                body: { message: `Hooks not supported — ${count} skill(s) hidden via file-rename mode`, variant: "warning" },
              })
            }
          }

          if (!checkTriageRateLimit()) {
            await client.tui.showToast({
              body: { message: "Triage rate limit exceeded (20 calls/60s). Please wait before retrying.", variant: "error" },
            })
            return "Triage rate limit exceeded. Please wait before retrying."
          }

          const query = (args.query ?? "").trim()
          if (!query) {
            return "Describe what you need -- triage will find the best matching skill."
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

          const scored = (await scoreAvailableSkills(query, skills))
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)

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
            const urls = [
              "https://skills.sh/",
              "https://github.com/obra/superpowers",
            ].join("\n  ")
            return `No skill matches "${query}". Try different keywords.${hint ? "\n\n" + hint : ""}${combined}\n\nResources:\n  ${urls}`
          }

          // Build candidate list with scores
          const top = scored.slice(0, 8)
          const lines = [
            scored.length === 1
              ? `Best match for "${query}". Use ${scored[0].path.endsWith(".disabled") ? "load-skill" : "skill"}({ name: "${scored[0].name}" }) to load it.`
              : `Found ${scored.length} matching skill(s) for "${query}". Use skill({ name }) to load the one you need:`,
            ``,
          ]
          top.forEach((s, i) => {
            const desc = s.desc.length > 100 ? s.desc.slice(0, 97) + "..." : s.desc
            lines.push(`${i + 1}. ${s.name} (score: ${s.score}${s.path.endsWith(".disabled") ? ", file-hidden: use load-skill" : ""}) — ${desc}`)
          })
          if (hint) {
            lines.push(``)
            lines.push(hint)
          }
          return lines.join("\n")
        },
      }),
      "load-skill": tool({
        description: "Load instructions for a discovered file-hidden skill that the native skill tool cannot read.",
        args: { name: tool.schema.string().describe("Exact installed skill name returned by triage") },
        async execute(args, context) {
          if (context.abort.aborted) return "Skill loading cancelled."
          const skill = (await getCachedSkills()).find(s => s.name === args.name)
          if (!skill) return `No installed skill named "${args.name}".`
          return readSkillContent(skill.path)
        },
      }),
      rescan: tool({
        description: "Refresh installed skills and semantic embeddings after modifying skill files.",
        args: {},
        async execute() {
          cache = null
          semanticCache = null
          const skills = await getCachedSkills()
          return `Rescan complete. ${skills.length} skill(s) found.`
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
            lines.push(`    <name>${escapeXml(s.name)}</name>`)
            lines.push(`    <description>${escapeXml(s.desc)}</description>`)
            lines.push(`  </skill>`)
          }
          lines.push("</available_skills>")
          return lines.join("\n")
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
    "tool.definition": async (input, output) => {
      hooksConfirmed = true
      if (input.toolID !== "skill") return
      const wasHookFired = definitionHookFired
      definitionHookFired = true
      const state = await getTriageState()
      if (state !== "on") return
      output.description = "Load instructions for a discovered skill by name. Use triage to search or list-skills to browse."
      if (!wasHookFired) await remigrateIfHooksDetected()
    },
    // ── System prompt cleanup + triage directive injection ────────
    // Strips the <available_skills> XML block from the system prompt
    // as a belt-and-suspenders measure alongside tool.definition.
    // Falls back silently if the experimental hook is not available.
    // Also handles mid-session state changes: if triage toggled ON
    // after startup, restore .disabled files here.
    // Injects a directive that mandates calling the `triage` tool first,
    // so the LLM has an explicit, hard-to-ignore instruction instead of
    // relying on the tool description alone.
    "experimental.chat.messages.transform": async (_input, output) => {
      const cfg = getAmbientConfig()
      if (!cfg.autoSuggest || await getTriageState() !== "on") return
      const lastUser = [...output.messages].reverse().find(m => m.info.role === "user")
      if (!lastUser) return
      const text = lastUser.parts
        .filter(p => p.type === "text" && !p.synthetic)
        .map(p => p.type === "text" ? p.text : "")
        .join(" ").trim()
      if (!text) return
      const result = await buildSuggestionBlock(text)
      if (!result) return
      // Context is derived from this request, so sessions and tool steps cannot
      // share stale suggestions. Mutations are ephemeral and never persisted.
      lastUser.parts = lastUser.parts.filter(p => !(p.type === "text" && p.synthetic && p.text.startsWith("<suggested_skills>")))
      lastUser.parts.unshift({
        type: "text", id: `prt_triage_${lastUser.info.id}`,
        sessionID: lastUser.info.sessionID, messageID: lastUser.info.id,
        text: result.block, synthetic: true,
      })
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const state = await getTriageState()
      if (state !== "on") return
      if (!migrationCompleted) await remigrateIfHooksDetected()
      const re = /<available_skills>[\s\S]*?<\/available_skills>/g
      const directive = "\n\nBefore any task, call the `triage` tool to discover specialized skills. Pass a brief query. Load the matched skill's content and follow its instructions.\n"
      for (let i = 0; i < output.system.length; i++) {
        output.system[i] = output.system[i].replace(re, "").trimEnd() + directive
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
