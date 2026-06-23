/**
 * Configuration and types module.
 *
 * Centralizes all scoring constants, type definitions, and triage state
 * management logic. This is the single source of truth for:
 *   - Scoring thresholds and weights
 *   - Type definitions for skills and scored results
 *   - Triage state resolution from plugin options and config files
 */

import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"

// ── Scoring constants ──────────────────────────────────────

/**
 * Minimum score gap required between the top two matches for auto-routing.
 * If the gap is below this threshold, the LLM gets a list of candidates
 * to choose from instead of a single skill.
 *
 * Scoring: exact word match = 15pts, substring match = 10pts.
 * Name matches are weighted 3x, description matches 1x.
 * So a single exact name match (15 * 3 = 45) exceeds this threshold alone.
 */
export const THRESHOLD = 30

/**
 * Minimum word length to consider during query tokenization.
 * Filters out common short words like "a", "an", "to", "do" that
 * would create false positive matches across many skills.
 */
export const MIN_WORD_LENGTH = 2

/**
 * Multiplier applied to score bonuses from skill name matches.
 * Names are more specific than descriptions, so they get higher weight.
 * A name match contributes 3x more to the final score than a description match.
 */
export const NAME_WEIGHT = 3

/**
 * Multiplier applied to score bonuses from skill description matches.
 * Descriptions are broader and less specific, so they get baseline weight.
 */
export const DESC_WEIGHT = 1

/**
 * Maximum allowed size for a skill file in bytes (1MB).
 * Prevents memory exhaustion attacks where a maliciously large SKILL.md
 * would be loaded into the LLM context window.
 */
export const MAX_SKILL_SIZE = 1024 * 1024 // 1MB

/**
 * Maximum total size for all skill files combined during discovery (10MB).
 * Prevents memory exhaustion from many moderately-sized skills.
 */
export const MAX_TOTAL_SKILL_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * Bonus points awarded when two consecutive query words appear as a
 * bigram (adjacent pair) in the skill description.
 */
export const BIGRAM_BONUS = 10

/**
 * Bonus points awarded when 3+ consecutive query words appear verbatim
 * as a phrase in the skill name or description. This is a strong
 * intent signal — the user's exact wording matches the skill's own text.
 */
export const PHRASE_BONUS = 50

/**
 * Bonus points added to project-scoped skills that scored > 0.
 * Project skills are more relevant to current work than global ones.
 * Acts as a tiebreaker when a project and global skill have equal scores.
 * Small enough to never promote an irrelevant project skill over a
 * clearly better global match.
 */
export const SCOPE_BONUS = 5

// ── Semantic embedding constants ──────────────────────────

/**
 * Embedding model to use for semantic skill matching.
 * Multilingual model covering 50+ languages including Chinese and English.
 */
export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"

/**
 * Minimum score gap between top two semantic matches for auto-routing.
 * Cosine similarity is scaled to 0-100, so 15 means a 0.15 cosine gap.
 */
export const SEMANTIC_THRESHOLD = 15

/**
 * Default minimum semantic score for ambient skill suggestion injection.
 * Cosine similarity * 100. 25 means cosine > 0.25 before a skill appears
 * in the suggested_skills block.
 */
export const AMBIENT_MIN_SEMANTIC = 25

// ── Ambient suggestion constants ───────────────────────────

/**
 * Default minimum absolute score a skill must reach to be auto-injected
 * as a candidate into the system prompt for the current message.
 *
 * Different from THRESHOLD (which is a top-vs-runner-up GAP for single-skill
 * auto-routing). This is an absolute FLOOR: too low surfaces noise on
 * unrelated messages, too high never surfaces relevant skills.
 *
 * Reference (see scoring.ts): one exact name word ≈ 45+, one exact desc
 * word ≈ 15–30. ~20 means "needs at least one decent hit to surface".
 *
 * Overridable via plugin options (`ambientMinScore`) or env
 * (`OPENCODE_TRIAGE_MIN_SCORE`).
 */
export const AMBIENT_MIN_SCORE = 30

/**
 * Default maximum number of candidate skills injected per message (top-K).
 * Higher = better recall but more tokens per turn and more mis-trigger risk.
 *
 * Overridable via plugin options (`ambientMaxCandidates`) or env
 * (`OPENCODE_TRIAGE_MAX_CANDIDATES`).
 */
export const AMBIENT_MAX_CANDIDATES = 3

// ── Type definitions ───────────────────────────────────────

/**
 * Represents a discovered skill from the filesystem.
 * Populated during the discovery phase before any scoring occurs.
 */
export interface SkillEntry {
  /** Skill name from frontmatter, or directory name as fallback */
  name: string
  /** Skill description from frontmatter, or empty string if missing */
  desc: string
  /** Absolute path to the SKILL.md or SKILL.md.disabled file */
  path: string
  /** Whether this skill was found in a project-level or global directory */
  scope: "project" | "global"
}

/**
 * A skill entry enriched with its relevance score for a specific query.
 * Returned by scoreSkills() and used to rank candidates.
 */
export interface ScoredSkill extends SkillEntry {
  /** Computed relevance score based on keyword matching */
  score: number
  /** Points from description matches only (name matches excluded). Includes bigram and phrase bonuses. Used for tiebreaking. */
  descScore: number
  /** Human-readable list of which words matched and where (e.g. "name:backup, desc:database") */
  matchedBy: string
}

/**
 * Resolved configuration for the ambient (per-message) skill suggestion feature.
 * Produced by resolveAmbientConfig() from plugin options, config files, env, and defaults.
 */
export interface AmbientConfig {
  /** Whether to auto-inject candidate skills into the system prompt per message */
  autoSuggest: boolean
  /** Absolute score floor a skill must reach to be injected as a candidate */
  ambientMinScore: number
  /** Maximum number of candidates injected per message */
  ambientMaxCandidates: number
}

// ── Triage state ───────────────────────────────────────────

/**
 * Parses JSONC (JSON with comments) by stripping // and /* comments.
 *
 * Handles comments inside and outside strings correctly — comments
 * inside quoted strings are preserved, comments outside are removed.
 *
 * @param text - Raw JSONC text
 * @returns Clean JSON text ready for JSON.parse
 */
export function stripJsoncComments(text: string): string {
  let result = ""
  let inString = false
  let escape = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (escape) { result += ch; escape = false; i++; continue }
    if (ch === "\\" && inString) { result += ch; escape = true; i++; continue }
    if (ch === '"') { inString = !inString; result += ch; i++; continue }
    if (!inString && ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (!inString && ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    result += ch; i++
  }
  return result
}

/**
 * Returns the configured triage state from a single config file.
 *
 * Reads opencode.json or opencode.jsonc and looks for the
 * "opencode-triage" plugin entry with autoHide option.
 *
 * @param path - Absolute path to config file
 * @returns "on" if autoHide is true, "off" if false, "unknown" otherwise
 */
export function getTriageStateFromPath(path: string): "on" | "off" | "unknown" {
  try {
    const raw = readFileSync(path, "utf-8")
    const json = JSON.parse(stripJsoncComments(raw))
    const plugin: unknown[] = json.plugin ?? []
    for (const p of plugin) {
      if (!Array.isArray(p) || p[0] !== "opencode-triage") continue
      const opts = p[1] as Record<string, unknown> | undefined
      if (opts?.autoHide === true)  return "on"
      if (opts?.autoHide === false) return "off"
    }
    return "unknown"
  } catch { return "unknown" }
}

/**
 * Returns the config file paths checked for the opencode-triage plugin entry,
 * in priority order: local project config first, then global config.
 *
 * @param worktree - Git worktree root or current working directory
 * @returns Ordered list of candidate config file paths
 */
export function configPaths(worktree: string): string[] {
  return [
    join(worktree, ".opencode", "opencode.json"),
    join(worktree, ".opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ]
}

/**
 * Reads the opencode-triage plugin options object from a single config file.
 *
 * @param path - Absolute path to config file
 * @returns The plugin options object, or null if the entry/file is missing
 */
export function getTriageOptionsFromPath(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf-8")
    const json = JSON.parse(stripJsoncComments(raw))
    const plugin: unknown[] = json.plugin ?? []
    for (const p of plugin) {
      if (!Array.isArray(p) || p[0] !== "opencode-triage") continue
      return (p[1] as Record<string, unknown>) ?? {}
    }
    return null
  } catch { return null }
}

/**
 * Resolves the effective triage state from plugin options + config files.
 *
 * Priority: plugin options → local config → global config.
 * Returns "on" | "off" | "unknown" (never configured).
 *
 * @param worktree - Git worktree root or current working directory
 * @param options - Plugin options passed from OpenCode runtime
 * @returns Current triage state
 */
export async function checkTriageState(
  worktree: string,
  options: Record<string, unknown> | undefined
): Promise<"on" | "off" | "unknown"> {
  if (options?.autoHide === true)  return "on"
  if (options?.autoHide === false) return "off"
  for (const p of configPaths(worktree)) {
    const state = getTriageStateFromPath(p)
    if (state !== "unknown") return state
  }
  return "on"
}

// ── Ambient config resolution ──────────────────────────────

/**
 * Coerces a value to boolean. Accepts native booleans, numbers (0/non-0),
 * and common string forms (true/false/1/0/yes/no/on/off, case-insensitive).
 *
 * @returns The boolean, or undefined if the value is absent/unrecognized
 */
function coerceBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (["true", "1", "yes", "on"].includes(s)) return true
    if (["false", "0", "no", "off"].includes(s)) return false
  }
  return undefined
}

/**
 * Coerces a value to a finite number with optional clamping/rounding.
 * Out-of-range values are clamped (not rejected) so a sane number is always used.
 *
 * @returns The number, or undefined if the value is absent/non-numeric
 */
function coerceNum(v: unknown, opts: { min?: number; max?: number; int?: boolean }): number | undefined {
  let n: number
  if (typeof v === "number") n = v
  else if (typeof v === "string" && v.trim() !== "") n = Number(v)
  else return undefined
  if (!Number.isFinite(n)) return undefined
  if (opts.int) n = Math.round(n)
  if (opts.min !== undefined && n < opts.min) n = opts.min
  if (opts.max !== undefined && n > opts.max) n = opts.max
  return n
}

/** Returns the first source that coerces to a boolean, else the fallback. */
function pickBool(sources: unknown[], fallback: boolean): boolean {
  for (const s of sources) {
    const b = coerceBool(s)
    if (b !== undefined) return b
  }
  return fallback
}

/** Returns the first source that coerces to a number, else the fallback. */
function pickNum(sources: unknown[], fallback: number, opts: { min?: number; max?: number; int?: boolean }): number {
  for (const s of sources) {
    const n = coerceNum(s, opts)
    if (n !== undefined) return n
  }
  return fallback
}

/**
 * Resolves the ambient suggestion configuration.
 *
 * Precedence (first defined wins, per key):
 *   inline plugin options → config file entry → environment variable → default
 *
 * All values are validated/clamped; malformed input falls back to the default.
 *
 * Env vars: OPENCODE_TRIAGE_AUTO_SUGGEST, OPENCODE_TRIAGE_MIN_SCORE,
 *           OPENCODE_TRIAGE_MAX_CANDIDATES
 *
 * @param worktree - Git worktree root or current working directory
 * @param options - Plugin options passed from OpenCode runtime
 * @returns The resolved, validated ambient config
 */
export function resolveAmbientConfig(
  worktree: string,
  options: Record<string, unknown> | undefined
): AmbientConfig {
  let fileOpts: Record<string, unknown> | null = null
  for (const p of configPaths(worktree)) {
    const o = getTriageOptionsFromPath(p)
    if (o !== null) { fileOpts = o; break }
  }
  return {
    autoSuggest: pickBool(
      [options?.autoSuggest, fileOpts?.autoSuggest, process.env.OPENCODE_TRIAGE_AUTO_SUGGEST],
      true
    ),
    ambientMinScore: pickNum(
      [options?.ambientMinScore, fileOpts?.ambientMinScore, process.env.OPENCODE_TRIAGE_MIN_SCORE],
      AMBIENT_MIN_SEMANTIC,
      { min: 0 }
    ),
    ambientMaxCandidates: pickNum(
      [options?.ambientMaxCandidates, fileOpts?.ambientMaxCandidates, process.env.OPENCODE_TRIAGE_MAX_CANDIDATES],
      AMBIENT_MAX_CANDIDATES,
      { min: 1, int: true }
    ),
  }
}
