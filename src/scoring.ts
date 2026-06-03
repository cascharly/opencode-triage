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
 *      with IDF and position decay (earlier words matter more)
 *   4. Desc scoring falls back to stemmed form — "vulnerability" matches
 *      "vulnerabilities", "refactor" matches "refactoring", etc.
 *   5. Bigram bonus — consecutive word pairs in desc OR tokenized name
 *   6. Exact phrase bonus — 3+ consecutive words found verbatim
 *   7. Scope tiebreaker — project skills get small bonus over global
 *
 * Returns all skills with computed scores. Caller filters for score > 0.
 *
 * Performance notes:
 *   - IDF pre-computed outside the per-skill map loop.
 *   - stem() pre-computed once per query word outside the per-skill loop.
 *   - Word-boundary RegExps compiled once per query word and reused across
 *     all skills — avoids O(words × skills) RegExp allocations per request.
 *   - Stemmed description built once per skill and cached by path — avoids
 *     re-running the Unicode word-replacement regex on every triage call.
 */

import {
  THRESHOLD,
  MIN_WORD_LENGTH,
  NAME_WEIGHT,
  DESC_WEIGHT,
  BIGRAM_BONUS,
  PHRASE_BONUS,
  POSITION_DECAY,
  SCOPE_BONUS,
} from "./config.ts"
import { escapeRegex } from "./utils.ts"
import type { SkillEntry, ScoredSkill } from "./config.ts"

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

// Module-level cache for stemmed skill descriptions.
// Key: skill path (stable unique identifier). Value: object containing the
// original description (to prevent collisions on mock paths in unit tests) and
// the pre-computed stemmed description.
interface StemCacheEntry {
  desc: string
  stemmed: string
}
const _stemmedDescCache = new Map<string, StemCacheEntry>()
const MAX_STEM_CACHE = 100

/**
 * Returns the stemmed lowercase description for a skill, using a module-level
 * cache to avoid recomputing on every triage call.
 * Evicts oldest entries when cache exceeds MAX_STEM_CACHE to cap memory.
 *
 * @param skill - The skill entry (path is used as the cache key)
 * @param descLower - Pre-lowercased description string
 * @returns Stemmed description string
 */
function getStemmedDesc(skill: SkillEntry, descLower: string): string {
  const entry = _stemmedDescCache.get(skill.path)
  if (entry !== undefined && entry.desc === descLower) {
    return entry.stemmed
  }
  const stemmed = descLower.replace(/(?:^|(?<=\s))[\p{L}\p{N}]+(?=\s|$)/gu, w => stem(w))
  if (_stemmedDescCache.size >= MAX_STEM_CACHE) {
    const oldest = _stemmedDescCache.keys().next().value
    if (oldest !== undefined) _stemmedDescCache.delete(oldest)
  }
  _stemmedDescCache.set(skill.path, { desc: descLower, stemmed })
  return stemmed
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
 * For bulk scoring, scoreSkills() uses getWordBonusWithRe() with pre-compiled
 * RegExp objects to avoid redundant allocations. This exported function
 * creates its own RegExp per call for convenience.
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
 * Internal version of getWordBonus that accepts a pre-compiled RegExp.
 * Used inside scoreSkills() where the RegExp is compiled once per query word.
 */
function getWordBonusWithRe(re: RegExp, word: string, target: string): number {
  if (re.test(target)) return 15
  if (target.includes(word)) return 10
  return 0
}

interface ScoringContext {
  words: string[]
  idf: Record<string, number>
  wordStems: Record<string, string>
  wordRegexes: Record<string, RegExp>
  stemRegexes: Record<string, RegExp>
}

function tokenizeQuery(query: string): string[] {
  return query.toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(w => w.length >= MIN_WORD_LENGTH)
}

function computeDF(words: string[], skills: SkillEntry[]): Record<string, number> {
  const df: Record<string, number> = {}
  for (const s of skills) {
    const d = s.desc.toLowerCase()
    for (const w of words) {
      if (d.includes(w)) df[w] = (df[w] ?? 0) + 1
    }
  }
  return df
}

function computeIDF(words: string[], skillCount: number, df: Record<string, number>): Record<string, number> {
  const idf: Record<string, number> = {}
  for (const w of words) {
    idf[w] = 1 + Math.log(skillCount / (df[w] || 1))
  }
  return idf
}

function preComputeStems(words: string[]): Record<string, string> {
  const stems: Record<string, string> = {}
  for (const w of words) stems[w] = stem(w)
  return stems
}

function preCompileRegexps(words: string[], stems: Record<string, string>): {
  wordRegexes: Record<string, RegExp>
  stemRegexes: Record<string, RegExp>
} {
  const wordRegexes: Record<string, RegExp> = {}
  const stemRegexes: Record<string, RegExp> = {}
  for (const w of words) {
    wordRegexes[w] = new RegExp(`\\b${escapeRegex(w)}\\b`, "i")
    stemRegexes[w] = new RegExp(`\\b${escapeRegex(stems[w])}\\b`, "i")
  }
  return { wordRegexes, stemRegexes }
}

function scoreNameMatches(
  ctx: ScoringContext,
  nameLower: string,
): { score: number; matched: string[] } {
  let score = 0
  const matched: string[] = []
  for (let i = 0; i < ctx.words.length; i++) {
    const word = ctx.words[i]
    const positionWeight = Math.pow(POSITION_DECAY, i)
    const bonus = getWordBonusWithRe(ctx.wordRegexes[word], word, nameLower)
    if (bonus > 0) {
      score += NAME_WEIGHT * bonus * ctx.idf[word] * positionWeight
      matched.push(`name:${word}`)
    }
  }
  return { score, matched }
}

function scoreDescMatches(
  ctx: ScoringContext,
  descLower: string,
  stemmedDescLower: string,
): { score: number; descScore: number; matched: string[] } {
  let score = 0
  let descScore = 0
  const matched: string[] = []
  for (let i = 0; i < ctx.words.length; i++) {
    const word = ctx.words[i]
    const positionWeight = Math.pow(POSITION_DECAY, i)
    const bonus = getWordBonusWithRe(ctx.wordRegexes[word], word, descLower)
    const stemBonus = getWordBonusWithRe(ctx.stemRegexes[word], ctx.wordStems[word], stemmedDescLower)
    const effectiveBonus = Math.max(bonus, stemBonus)
    if (effectiveBonus > 0) {
      const points = DESC_WEIGHT * effectiveBonus * ctx.idf[word] * positionWeight
      score += points
      descScore += points
      matched.push(stemBonus > bonus ? `desc:stem:${word}` : `desc:${word}`)
    }
  }
  return { score, descScore, matched }
}

function applyBigramBonus(
  ctx: ScoringContext,
  descLower: string,
  nameTokenized: string,
): { score: number; descScore: number; matched: string[] } {
  let score = 0
  let descScore = 0
  const matched: string[] = []
  for (let i = 0; i < ctx.words.length - 1; i++) {
    const bigram = `${ctx.words[i]} ${ctx.words[i + 1]}`
    if (descLower.includes(bigram)) {
      score += BIGRAM_BONUS
      descScore += BIGRAM_BONUS
      matched.push(`bigram:${bigram}`)
    } else if (nameTokenized.includes(bigram)) {
      score += BIGRAM_BONUS
      matched.push(`bigram:name:${bigram}`)
    }
  }
  return { score, descScore, matched }
}

function applyPhraseBonus(
  ctx: ScoringContext,
  descLower: string,
  nameLower: string,
  nameTokenized: string,
): { score: number; descScore: number; matched: string[] } {
  for (const n of [5, 4, 3]) {
    for (let i = 0; i <= ctx.words.length - n; i++) {
      const phrase = ctx.words.slice(i, i + n).join(" ")
      if (descLower.includes(phrase) || nameLower.includes(phrase) || nameTokenized.includes(phrase)) {
        return { score: PHRASE_BONUS, descScore: PHRASE_BONUS, matched: [`phrase:${phrase}`] }
      }
    }
  }
  return { score: 0, descScore: 0, matched: [] }
}

function applyScopeBonus(skill: SkillEntry, score: number, matched: string[]): void {
  if (skill.scope === "project" && score > 0) {
    matched.push("scope:project")
  }
}

function scoreSingleSkill(skill: SkillEntry, ctx: ScoringContext): ScoredSkill {
  const nameLower = skill.name.toLowerCase()
  const descLower = skill.desc.toLowerCase()
  const nameTokenized = nameLower.replace(/[-_]/g, " ")
  const stemmedDescLower = getStemmedDesc(skill, descLower)

  const nameResult = scoreNameMatches(ctx, nameLower)
  const descResult = scoreDescMatches(ctx, descLower, stemmedDescLower)
  const bigramResult = applyBigramBonus(ctx, descLower, nameTokenized)
  const phraseResult = applyPhraseBonus(ctx, descLower, nameLower, nameTokenized)

  const sum = nameResult.score + descResult.score + bigramResult.score + phraseResult.score
  const score = sum + (skill.scope === "project" && sum > 0 ? SCOPE_BONUS : 0)
  const descScore = descResult.descScore + bigramResult.descScore + phraseResult.descScore
  const matched = [
    ...nameResult.matched,
    ...descResult.matched,
    ...bigramResult.matched,
    ...phraseResult.matched,
  ]
  applyScopeBonus(skill, score, matched)

  return { ...skill, score, descScore, matchedBy: matched.join(", ") }
}

/**
 * Scores all skills against a user query using keyword matching.
 *
 * The scoring pipeline:
 *   1. Tokenize query: split on whitespace, strip punctuation, filter short words
 *   2. Compute IDF — words appearing in many descs get lower weight
 *   3. For each skill, score each query word against name (3x) and desc (1x)
 *      with IDF and position decay (earlier words matter more)
 *   3a. Desc scoring falls back to stemmed form — "vulnerability" matches
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
  const words = tokenizeQuery(query)
  if (words.length === 0) return []

  const df = computeDF(words, skills)
  const idf = computeIDF(words, skills.length, df)
  const wordStems = preComputeStems(words)
  const { wordRegexes, stemRegexes } = preCompileRegexps(words, wordStems)

  const ctx: ScoringContext = { words, idf, wordStems, wordRegexes, stemRegexes }
  return skills.map(skill => scoreSingleSkill(skill, ctx))
}
