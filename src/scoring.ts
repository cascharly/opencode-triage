/**
 * Scoring engine module.
 *
 * Implements the keyword-based relevance scoring pipeline that matches
 * user queries against discovered skills.
 *
 * Scoring pipeline:
 *   1. Tokenize query: split on whitespace, strip punctuation, filter short words
 *   2. Compute IDF — words appearing in many descs get lower weight
 *   3. For each skill, score each query word against name (3x) and desc (1x)
 *      with IDF
 *   4. Desc scoring falls back to stemmed form — "vulnerability" matches
 *      "vulnerabilities", "refactor" matches "refactoring", etc.
 *   5. Bigram bonus — consecutive word pairs in desc OR tokenized name
 *   6. Exact phrase bonus — 3+ consecutive words found verbatim
 *   7. Scope tiebreaker — project skills get small bonus over global
 *
 * Returns all skills with computed scores. Caller filters for score > 0.
 */

import {
  NAME_WEIGHT,
  DESC_WEIGHT,
  BIGRAM_BONUS,
  PHRASE_BONUS,
  SCOPE_BONUS,
} from "./config.ts"
import { escapeRegex } from "./utils.ts"
import type { SkillEntry, ScoredSkill } from "./config.ts"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const NON_ALPHANUM_RE = /[^\p{L}\p{N}]/gu

let _jieba: { cut_for_search(text: string, hmm: boolean): string[] } | null = null

function getJieba() {
  if (!_jieba) {
    _jieba = require("jieba-wasm")
  }
  return _jieba!
}

/**
 * Tokenizes a query string into an array of searchable words.
 *
 * Uses jieba's cut_for_search for word segmentation, then strips
 * non-alphanumeric chars and filters tokens shorter than 2 characters.
 * Tokens are deduplicated while preserving order.
 *
 * Falls back to whitespace-based tokenization if jieba is unavailable.
 *
 * @param query - Already lowercased query string
 * @returns Array of tokenized and filtered words
 */
function tokenizeQuery(query: string): string[] {
  try {
    const jieba = getJieba()
    const tokens = jieba.cut_for_search(query, true)
    const seen = new Set<string>()
    const words: string[] = []
    for (const t of tokens) {
      const cleaned = t.replace(NON_ALPHANUM_RE, "")
      if (!cleaned || cleaned.length < 2) continue
      if (seen.has(cleaned)) continue
      seen.add(cleaned)
      words.push(cleaned)
    }
    return words
  } catch {
    return query
      .split(/\s+/)
      .map(w => w.replace(NON_ALPHANUM_RE, ""))
      .filter(w => w.length >= 2)
  }
}

/**
 * Applies lightweight suffix stripping to normalize word inflections.
 *
 * Rules (applied in order, first match wins):
 *   - "ies" → "y"  : plurals/conjugations  (vulnerabilities → vulnerability)
 *   - "ing" → ""   : gerunds/participles    (refactoring → refactor, testing → test)
 *
 * A minimum stem length of 4 chars prevents over-stripping short words
 * (e.g. "ring" stays "ring", "using" stays "using").
 *
 * Used to build a normalised version of skill descriptions so that query
 * words match their inflected forms in text without needing a full NLP library.
 *
 * @param word - A single lowercased word
 * @returns The stemmed word, or the original if no rule applies
 */
export function stem(word: string): string {
  const MIN = 4
  if (word.endsWith("ies") && word.length - 3 >= MIN) return word.slice(0, -3) + "y"
  if (word.endsWith("ing") && word.length - 3 >= MIN) return word.slice(0, -3)
  return word
}

/**
 * Calculates a relevance bonus for a single query word against a target string.
 *
 * Scoring tiers:
 *   - 15 points: Exact word-boundary match (e.g. "db" matches "backup db restore")
 *   - 10 points: Substring match (e.g. "back" matches "backup")
 *   - 0 points: No match at all
 *
 * Word-boundary matches score higher because they indicate a more precise
 * semantic match. Substring matches catch related terms but are less specific.
 *
 * @param word - A single tokenized query word (already lowercased, punctuation stripped)
 * @param target - The skill name or description to match against (already lowercased)
 * @returns Score bonus: 15, 10, or 0
 */
export function getWordBonus(word: string, target: string): number {
  const re = new RegExp(`\\b${escapeRegex(word)}\\b`, "i")
  if (re.test(target)) return 15
  if (target.includes(word)) return 10
  return 0
}

/**
 * Scores all skills against a user query using keyword matching.
 *
 * The scoring pipeline:
 *   1. Tokenize query: jieba cut_for_search for word segmentation, then strip
 *      non-alphanumeric chars and filter tokens shorter than 2 characters.
 *   2. Compute IDF — words appearing in many descs get lower weight
 *   3. For each skill, score each query word against name (3x) and desc (1x)
 *      with IDF. Desc scoring falls back to stemmed form — "vulnerability" matches
 *       "vulnerabilities", "refactor" matches "refactoring", etc.
 *   4. Bigram bonus — consecutive word pairs in desc OR tokenized name get +BIGRAM_BONUS
 *      ("react native" hits "vercel-react-native-skills" via name tokenization)
 *   5. Exact phrase bonus — 3+ consecutive words found verbatim in desc, name,
 *      or tokenized name get +PHRASE_BONUS
 *   6. Return all skills with their computed scores and match details
 *
 * Note: This returns ALL skills, including those with score 0.
 * The caller should filter with `.filter(s => s.score > 0)` to get only matches.
 *
 * @param query - The user's natural language query (e.g. "backup my database")
 * @param skills - Array of discovered skills to score against
 * @returns All skills with computed scores (filter for score > 0 to get matches)
 */
export function scoreSkills(query: string, skills: SkillEntry[]): ScoredSkill[] {
  const words = tokenizeQuery(query.toLowerCase())

  if (words.length === 0) return []

  // IDF: count how many skill descriptions contain each query word.
  // Words appearing in many skills (e.g. "use", "guide") get downweighted.
  // Rare words (e.g. "kubernetes", "boolean") get full or boosted weight.
  const df: Record<string, number> = {}
  for (const w of words) {
    df[w] = skills.filter(s => s.desc.toLowerCase().includes(w)).length
  }

  // IDF: precompute inverse document frequency for each query word.
  // Hoisted outside the per-skill loop since values are identical across skills.
  const idf: Record<string, number> = {}
  for (const w of words) {
    idf[w] = 1 + Math.log(skills.length / (df[w] || 1))
  }

  return skills.map(skill => {
    const nameLower = skill.name.toLowerCase()
    const descLower = skill.desc.toLowerCase()
    // Name with hyphens/underscores replaced by spaces so bigrams and phrases
    // can match across tokens (e.g. "react native" hits "vercel-react-native-skills")
    const nameTokenized = nameLower.replace(/[-_]/g, " ")
    // Stemmed desc: each word reduced to its base form so inflected variants
    // in descriptions match uninflected query words (refactoring→refactor, etc.)
    const stemmedDescLower = descLower.replace(/(?:^|(?<=\s))[\p{L}\p{N}]+(?=\s|$)/gu, w => stem(w))
    let score = 0
    let descScore = 0
    const matched: string[] = []

    // Score name matches first (higher weight, with IDF)
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const bonus = getWordBonus(word, nameLower)
      if (bonus > 0) {
        score += NAME_WEIGHT * bonus * idf[word]
        matched.push(`name:${word}`)
      }
    }

    // Then score description matches (lower weight, with IDF).
    // Falls back to stemmed desc so "vulnerability" matches "vulnerabilities",
    // "refactor" matches "refactoring", etc. Takes the higher of the two bonuses.
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const bonus = getWordBonus(word, descLower)
      const stemBonus = getWordBonus(stem(word), stemmedDescLower)
      const effectiveBonus = Math.max(bonus, stemBonus)
      if (effectiveBonus > 0) {
        const points = DESC_WEIGHT * effectiveBonus * idf[word]
        score += points
        descScore += points
        matched.push(stemBonus > bonus ? `desc:stem:${word}` : `desc:${word}`)
      }
    }

    // Bigram bonus: consecutive word pairs in description OR tokenized name.
    // Name bigrams don't count toward descScore (they're name-level signals).
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`
      if (descLower.includes(bigram)) {
        score += BIGRAM_BONUS
        descScore += BIGRAM_BONUS
        matched.push(`bigram:${bigram}`)
      } else if (nameTokenized.includes(bigram)) {
        score += BIGRAM_BONUS
        matched.push(`bigram:name:${bigram}`)
      }
    }

    // Exact phrase bonus: 3+ consecutive query words verbatim in desc, name, or tokenized name
    for (const n of [5, 4, 3]) {
      for (let i = 0; i <= words.length - n; i++) {
        const phrase = words.slice(i, i + n).join(" ")
        if (descLower.includes(phrase) || nameLower.includes(phrase) || nameTokenized.includes(phrase)) {
          score += PHRASE_BONUS
          descScore += PHRASE_BONUS
          matched.push(`phrase:${phrase}`)
          break
        }
      }
      if (matched.some(m => m.startsWith("phrase:"))) break
    }

    // Scope tiebreaker: project skills are more relevant to current work.
    // Only applied when the skill has matched something (score > 0).
    if (skill.scope === "project" && score > 0) {
      score += SCOPE_BONUS
      matched.push("scope:project")
    }

    return { ...skill, score, descScore, matchedBy: matched.join(", ") }
  })
}
