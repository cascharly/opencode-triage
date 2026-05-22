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
 *   - S1: IDF pre-computed outside the per-skill map loop.
 *   - S2: stem() pre-computed once per query word outside the per-skill loop.
 *   - S3: word-boundary RegExps compiled once per query word and reused across
 *         all skills — avoids O(words × skills) RegExp allocations per request.
 *   - S4: stemmed description built once per skill and cached by path — avoids
 *         re-running the Unicode word-replacement regex on every triage call.
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

// S4: Module-level cache for stemmed skill descriptions.
// Key: skill path (stable unique identifier). Value: object containing the
// original description (to prevent collisions on mock paths in unit tests) and
// the pre-computed stemmed description.
interface StemCacheEntry {
  desc: string
  stemmed: string
}
const _stemmedDescCache = new Map<string, StemCacheEntry>()

/**
 * Returns the stemmed lowercase description for a skill, using a module-level
 * cache to avoid recomputing on every triage call.
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
  // Replace each Unicode word token with its stemmed form.
  // The lookbehind `(?<=\s)` + start-of-string anchor targets whole words only.
  const stemmed = descLower.replace(/(?:^|(?<=\s))[\p{L}\p{N}]+(?=\s|$)/gu, w => stem(w))
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
 * Accepts a pre-compiled RegExp to avoid allocating a new object on every call.
 * Called O(words × skills) times per triage request — the RegExp is compiled
 * once per query word in scoreSkills() and passed in here.
 *
 * @param word - A single tokenized query word (already lowercased, punctuation stripped)
 * @param re - Pre-compiled word-boundary RegExp for this word
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
  // Tokenize: lowercase → split on whitespace → strip non-alphanumeric chars → filter short words
  // Unicode letter/number classes (\p{L}\p{N}) support international queries
  const words = query.toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(w => w.length >= MIN_WORD_LENGTH)

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

  // S2: pre-compute stem for each query word once, outside the per-skill loop.
  // Previously stem(word) was called once per word per skill — O(words × skills).
  // Now it is O(words) total. Identical outputs, eliminates redundant computation.
  const wordStems: Record<string, string> = {}
  for (const w of words) {
    wordStems[w] = stem(w)
  }

  // S3: pre-compile word-boundary RegExps once per query word.
  // getWordBonus() previously called `new RegExp(...)` on every invocation —
  // O(words × skills × 2) allocations per triage request. Now we compile
  // each pattern exactly once (O(words)) and reuse it across all skills.
  const wordRegexes: Record<string, RegExp> = {}
  const stemRegexes: Record<string, RegExp> = {}
  for (const w of words) {
    wordRegexes[w] = new RegExp(`\\b${escapeRegex(w)}\\b`, "i")
    stemRegexes[w] = new RegExp(`\\b${escapeRegex(wordStems[w])}\\b`, "i")
  }

  return skills.map(skill => {
    const nameLower = skill.name.toLowerCase()
    const descLower = skill.desc.toLowerCase()
    // Name with hyphens/underscores replaced by spaces so bigrams and phrases
    // can match across tokens (e.g. "react native" hits "vercel-react-native-skills")
    const nameTokenized = nameLower.replace(/[-_]/g, " ")
    // S4: stemmed desc retrieved from module-level cache (built once per skill).
    // Each word in the description is reduced to its base form so inflected variants
    // match uninflected query words (refactoring→refactor, vulnerabilities→vulnerability).
    const stemmedDescLower = getStemmedDesc(skill, descLower)
    let score = 0
    let descScore = 0
    const matched: string[] = []

    // Score name matches first (higher weight, with IDF + position)
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const positionWeight = Math.pow(POSITION_DECAY, i)
      const bonus = getWordBonusWithRe(wordRegexes[word], word, nameLower)
      if (bonus > 0) {
        score += NAME_WEIGHT * bonus * idf[word] * positionWeight
        matched.push(`name:${word}`)
      }
    }

    // Then score description matches (lower weight, with IDF + position).
    // Falls back to stemmed desc so "vulnerability" matches "vulnerabilities",
    // "refactor" matches "refactoring", etc. Takes the higher of the two bonuses.
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const positionWeight = Math.pow(POSITION_DECAY, i)
      const bonus = getWordBonusWithRe(wordRegexes[word], word, descLower)
      const stemBonus = getWordBonusWithRe(stemRegexes[word], wordStems[word], stemmedDescLower)
      const effectiveBonus = Math.max(bonus, stemBonus)
      if (effectiveBonus > 0) {
        const points = DESC_WEIGHT * effectiveBonus * idf[word] * positionWeight
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
