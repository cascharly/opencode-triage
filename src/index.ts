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
import { buildSkillLocations, discoverAllSkills, renameSkills, readSkillContent } from "./discovery.ts"
import { scoreSkills } from "./scoring.ts"
import { suggestCorrections } from "./spellcheck.ts"
import { THRESHOLD, checkTriageState, resolveAmbientConfig } from "./config.ts"
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
  // Cache: discovered skills per worktree, with timestamp for invalidation
  // Fixes edge case #4: previously cache was never invalidated after CLI toggle,
  // causing "skill content unavailable" errors until OpenCode restart
  let cache: { skills: SkillEntry[]; timestamp: number } | null = null
  const CACHE_TTL_MS = 5_000 // Re-discover every 5s to catch CLI toggles

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
   * Returns cached skills, re-discovering if the cache has expired.
   *
   * Uses a time-based cache (5s TTL) to balance performance with
   * responsiveness to file system changes (e.g., CLI toggles).
   *
   * @returns Array of discovered skill entries
   */
  async function getCachedSkills(): Promise<SkillEntry[]> {
    const now = Date.now()
    if (cache === null || now - cache.timestamp > CACHE_TTL_MS) {
      const locations = buildSkillLocations(worktree)
      cache = { skills: await discoverAllSkills(locations, getExcludedSkills), timestamp: now }
    }
    return cache.skills
  }

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

  // Ambient suggestion config, cached with the same TTL so config/env edits
  // are picked up without restart-on-every-call overhead.
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
  async function buildSuggestionBlock(query: string, skipNames?: Set<string>): Promise<{ block: string; names: string[] } | null> {
    const cfg = getAmbientConfig()
    const skills = await getCachedSkills()
    if (skills.length === 0) return null
    const allScored = scoreSkills(query, skills)
    const scored = allScored
      .filter(s => s.score >= cfg.ambientMinScore && !skipNames?.has(s.name))
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.ambientMaxCandidates)
    if (scored.length === 0) return null
    const names = scored.map(s => s.name)
    const block = [
      "<suggested_skills>",
      "The following installed skills may be relevant to the current message.",
      'If one fits, call triage({ query: "<skill name>" }) to load its full instructions, then follow them.',
      "If none are relevant, ignore this block.",
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
           "Discover and route to the right specialized skill. " +
           "ALWAYS call this FIRST before attempting any task — check if a specialized skill exists. " +
           "If a skill matches, read its content and check if it's scoped to a specific project (look for project names in the description or instructions). " +
           "If the skill is project-specific and doesn't match the current project, warn the user before proceeding. " +
           "Follow the skill's instructions when applicable, or proceed with general knowledge if not. " +
           "Pass a brief description. Returns the best match or a list of candidates.",
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

          const scored = scoreSkills(query, skills)
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)

          if (scored.length === 0) {
            const findSkills = skills.find(s => s.name.toLowerCase() === "find-skills")
            if (findSkills) {
              const content = await readSkillContent(findSkills.path)
              const lines = [
                `SKILL ROUTED: ${findSkills.name}`,
                `Matched by: remote search fallback`,
              ]
              if (hint) lines.push(hint)
              lines.push("")
              lines.push(content)
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

          // Confidence gap: top match vs runner-up. Large gap = clear winner
          const gap = scored[0].score - (scored[1]?.score ?? 0)

          if (gap >= THRESHOLD || scored.length === 1) {
            const match = scored[0]
            const content = await readSkillContent(match.path)
            const lines = [
              `SKILL ROUTED: ${match.name}`,
              `Matched by: ${match.matchedBy}`,
            ]
            if (hint) lines.push(hint)
            lines.push("")
            lines.push(content)
            return lines.join("\n")
          }

          const top = scored.slice(0, 5)
          const lines = [
            `Multiple matches for "${query}". Pick one and call triage with the skill name:`,
            ``,
          ]
          top.forEach((s, i) => {
            lines.push(`${i + 1}. ${s.name} -- ${s.desc}`)
          })
          if (hint) {
            lines.push(``)
            lines.push(hint)
          }
          lines.push(``)
          lines.push(`Example: triage({ query: "${top[0].name}" })`)
          return lines.join("\n")
        },
      }),
    },
    // ── Skill tool override ──────────────────────────────
    // Uses tool.definition hook to replace the built-in `skill`
    // tool's description when triage is ON, hiding the <available_skills>
    // block and preventing the LLM from calling it directly.
    "tool.definition": async (input, output) => {
      const wasHookFired = definitionHookFired
      definitionHookFired = true
      hooksConfirmed = true
      if (input.toolID !== "skill") return
      const state = await getTriageState()
      if (state !== "on") return
      output.description =
        "This tool is disabled. Use `triage` to discover and load specialized skills."
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
    // ── Skill call interception ───────────────────────────
    // Safety net: if the LLM ignores the disabled description and
    // calls the native `skill` tool anyway, redirect by setting the
    // skill name to a sentinel that forces a clean "not found" error.
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "skill") return
      const state = await getTriageState()
      if (state !== "on") return
      output.args = { name: "__TRIAGE_DISABLED__" }
    },
    // ── Notification routing ────────────────────────────
    // Catches triage results to show TUI toasts.
    // First-line pattern matching avoids parsing the full result.
    // Body isolation prevents false positives on content issue detection.
    "tool.execute.after": async (input, output) => {
      const result = output.output
      if (typeof result !== "string") return
      if (input.tool === "triage") {
        const first = result.split("\n")[0] ?? ""
        if (first.startsWith("SKILL ROUTED:")) {
          const skillName = first.replace("SKILL ROUTED:", "").trim()
          await client.tui.showToast({
            body: { message: `Loaded: ${skillName}`, variant: "success" },
          })
          const bodyIndex = result.indexOf("\n\n")
          if (bodyIndex !== -1) {
            const body = result.slice(bodyIndex + 2).trimStart()
            if (body.startsWith("(skill content truncated")) {
              await client.tui.showToast({
                body: { message: `Skill "${skillName}" exceeds 1MB limit — truncated`, variant: "warning" },
              })
            } else if (body.startsWith("(skill content unavailable")) {
              await client.tui.showToast({
                body: { message: `Could not read skill file for "${skillName}"`, variant: "error" },
              })
            }
          }
        } else if (first.startsWith("Multiple matches")) {
          await client.tui.showToast({
            body: { message: "Multiple skills matched — narrow your query", variant: "info" },
          })
        } else if (first.startsWith("No skill matches")) {
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
