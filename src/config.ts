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
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { stripJsoncComments: _stripJsoncComments } = require("../bin/shared.cjs")

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
export const MIN_WORD_LENGTH = 3

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
 * Position weight decay: earlier words in the query matter more.
 * First word gets full weight (×1.0), each subsequent word gets
 * multiplied by this factor. Compounds with word bonus.
 */
export const POSITION_DECAY = 0.9

/**
 * Bonus points added to project-scoped skills that scored > 0.
 * Project skills are more relevant to current work than global ones.
 * Acts as a tiebreaker when a project and global skill have equal scores.
 * Small enough to never promote an irrelevant project skill over a
 * clearly better global match.
 */
export const SCOPE_BONUS = 5

/**
 * Skills permanently excluded from routing, regardless of any user configuration.
 * "triage" must always be excluded to prevent infinite self-referencing loops
 * where the LLM routes to the triage skill itself recursively.
 *
 * This set cannot be overridden by OPENCODE_TRIAGE_EXCLUDED — that env var
 * can only add additional exclusions on top of this invariant set.
 */
export const ALWAYS_EXCLUDED_SKILLS = new Set(["triage"])

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
  return _stripJsoncComments(text)
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
export async function getTriageStateFromPath(path: string): Promise<"on" | "off" | "unknown"> {
  try {
    const raw = await readFile(path, "utf-8")
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
  const paths = [
    join(worktree, ".opencode", "opencode.json"),
    join(worktree, ".opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ]
  for (const p of paths) {
    const state = await getTriageStateFromPath(p)
    if (state !== "unknown") return state
  }
  return "unknown"
}
