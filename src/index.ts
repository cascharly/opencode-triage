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
import { scoreSkills } from "./scoring.ts"
import { suggestCorrections } from "./spellcheck.ts"
import { THRESHOLD, ALWAYS_EXCLUDED_SKILLS, checkTriageState } from "./config.ts"
import type { SkillEntry } from "./config.ts"

const require = createRequire(import.meta.url)
const CURRENT_VERSION: string = (() => {
  try { return require("../package.json").version }
  catch { return "0.0.0" }
})()

const { semverGt } = require("../bin/shared.cjs") as { semverGt: (a: string, b: string) => boolean }

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
          watchers.push(watch(base, { recursive: true }, () => { cache = null }))
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
            const urls = [
              "https://skills.sh/",
              "https://github.com/obra/superpowers",
            ].join("\n  ")
            return `No skill matches "${query}". Try different keywords.${hint ? "\n\n" + hint : ""}${combined}\n\nResources:\n  ${urls}`
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
    // ── System prompt cleanup + triage directive injection ────────
    // Strips the <available_skills> XML block from the system prompt
    // as a belt-and-suspenders measure alongside tool.definition.
    // Falls back silently if the experimental hook is not available.
    // Also handles mid-session state changes: if triage toggled ON
    // after startup, restore .disabled files here.
    // Injects a directive that mandates calling the `triage` tool first,
    // so the LLM has an explicit, hard-to-ignore instruction instead of
    // relying on the tool description alone.
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
        const newlineIdx = result.indexOf("\n")
        const first = newlineIdx === -1 ? result : result.slice(0, newlineIdx)
        if (first.startsWith("SKILL ROUTED:")) {
          const skillName = first.replace("SKILL ROUTED:", "").trim()
          await client.tui.showToast({
            body: { message: `Loaded: ${skillName}`, variant: "success" },
          })
          const bodyIndex = result.indexOf("\n\n")
          if (bodyIndex !== -1) {
            const body = result.slice(bodyIndex + 2).trimStart()
            if (body.startsWith("__TRIAGE_TRUNCATED__")) {
              await client.tui.showToast({
                body: { message: `Skill "${skillName}" exceeds 1MB limit — truncated`, variant: "warning" },
              })
            } else if (body.startsWith("__TRIAGE_UNAVAILABLE__")) {
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
