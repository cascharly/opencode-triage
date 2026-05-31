/**
 * Spell correction module.
 *
 * Detects unmatched query words and suggests corrections using Levenshtein
 * distance against skill vocabulary (names + descriptions).
 *
 * How it works:
 *   1. Build vocabulary set from all skill names and descriptions
 *   2. Tokenize query and check each word against vocab
 *   3. If a word has no exact match in vocab (length >= 4), find closest
 *      vocab word by Levenshtein distance (max 2 edits)
 *   4. Return correction hints like '"scurity" → "security"'
 *
 * Hints are injected into triage tool results for the LLM to self-correct
 * silently — transparent to the user.
 */

import { createRequire } from "node:module"
import { MIN_WORD_LENGTH } from "./config.ts"
import type { SkillEntry } from "./config.ts"

const require = createRequire(import.meta.url)
const { levenshtein: _levenshtein } = require("../bin/shared.cjs")

/**
 * Computes the Levenshtein (edit) distance between two strings.
 *
 * Uses dynamic programming with O(m*n) time and space complexity.
 * Returns the minimum number of single-character edits (insert, delete,
 * substitute) needed to transform string a into string b.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Number of single-character edits needed
 */
export function levenshtein(a: string, b: string): number {
  return _levenshtein(a, b)
}

/**
 * Finds unmatched query words and suggests corrections from skill vocabulary.
 *
 * Builds a vocabulary set from all skill names and descriptions, then checks
 * each query token. If a token has no exact match in the vocabulary, finds
 * the closest word by Levenshtein distance (max 2 edits).
 *
 * Optimizations:
 *   - vocab.has(word) — O(1) set lookup instead of [...vocab].some() which
 *     allocated a new array and ran a linear scan on every word check.
 *   - Length early-exit — vocab words whose length differs from the query word
 *     by more than 2 are skipped before the O(N²) Levenshtein computation,
 *     eliminating ~90% of heavy DP calls.
 *
 * Words shorter than 4 characters are skipped to avoid false positives
 * on short common words like "app", "ten", "use".
 *
 * @param query - The user's raw query
 * @param skills - Array of discovered skills to build vocabulary from
 * @returns Array of correction strings like "scurity → security", or empty
 */
export function suggestCorrections(query: string, skills: SkillEntry[]): string[] {
  const words = query.toLowerCase().split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(w => w.length >= MIN_WORD_LENGTH)
  if (words.length === 0 || skills.length === 0) return []

  // Build vocabulary from skill names and descriptions
  const vocab = new Set<string>()
  for (const s of skills) {
    s.name.toLowerCase().split(/[-_\s]+/).forEach(w => { const clean = w.replace(/[^\p{L}\p{N}]/gu, ""); if (clean.length >= MIN_WORD_LENGTH) vocab.add(clean) })
    s.desc.toLowerCase().split(/\s+/).forEach(w => { const clean = w.replace(/[^\p{L}\p{N}]/gu, ""); if (clean.length >= MIN_WORD_LENGTH) vocab.add(clean) })
  }

  // Check each query word against vocabulary
  const hints: string[] = []
  for (const word of words) {
    // vocab.has() is O(1) — avoids the prior [...vocab].some() which allocated
    // a full array on every word check.
    if (vocab.has(word) || word.length < 4) continue
    let best = ""
    let bestDist = Infinity
    for (const v of vocab) {
      // Early-exit: if length difference already exceeds max edit distance (2),
      // the Levenshtein distance must be at least that large — skip O(N²) DP.
      if (Math.abs(word.length - v.length) > 2) continue
      const d = levenshtein(word, v)
      if (d < bestDist) { bestDist = d; best = v }
    }
    if (bestDist <= 2 && bestDist > 0 && best) hints.push(`"${word}" → "${best}"`)
  }
  return hints
}
