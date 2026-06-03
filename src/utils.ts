/**
 * Shared utility functions for the opencode-triage plugin.
 *
 * This module contains core string manipulation and security utilities
 * used across multiple modules. It has zero external dependencies — it
 * only uses built-in JavaScript/TypeScript features.
 *
 * Key responsibilities:
 *   - Parse YAML frontmatter from SKILL.md files
 *   - Escape regex metacharacters for safe pattern building
 *   - Validate skill directory names (path traversal defense)
 *   - Sanitize skill content for safe LLM injection
 */

// ── String utilities ───────────────────────────────────────

/**
 * Removes the UTF-8 Byte Order Mark (BOM) from the beginning of a string.
 *
 * Windows editors (Notepad, some VS Code configurations) prepend the BOM
 * character (U+FEFF) to UTF-8 files. If not stripped, the BOM breaks
 * frontmatter regex matching since `---` won't be at position 0.
 *
 * @param content - Raw file content that may start with a BOM
 * @returns Content with BOM removed, or unchanged if no BOM present
 */
export function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xFEFF) return content.slice(1)
  return content
}

// ── Regex utilities ────────────────────────────────────────

/**
 * Escapes all special regex metacharacters in a string.
 *
 * This is critical for security: user query words are used to build
 * dynamic regex patterns for word-boundary matching. Without escaping,
 * a query like `te.st` would match `test`, `teast`, `te1st`, etc.
 *
 * @param s - Raw string that may contain regex metacharacters
 * @returns Safely escaped string for use inside a RegExp constructor
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")
}

// Module-level RegExp cache for extractFrontmatter.
// The two patterns (folded-block "multiRe" and single-line "singleRe") only
// differ by the escaped YAML key name — typically "name" and "description".
// Caching by that string avoids re-compiling identical RegExp objects on every
// skill discovery call (once per skill per query cycle).
const _fmMultiReCache = new Map<string, RegExp>()
const _fmSingleReCache = new Map<string, RegExp>()

/**
 * Extracts a value from YAML frontmatter by key.
 *
 * Supports two frontmatter formats:
 *   1. Single-line: `description: Some text here`
 *   2. Folded block: `description: >` followed by indented lines
 *
 * Uses indexOf() instead of regex for the frontmatter boundary to avoid
 * catastrophic backtracking (ReDoS) on files with many `---` sequences.
 * The per-key RegExp patterns for value extraction are compiled once and
 * cached at module level to eliminate redundant RegExp allocation per skill.
 *
 * @param content - Full file content including frontmatter delimiters
 * @param key - The frontmatter key to extract (e.g. "name", "description")
 * @returns The extracted value, or null if the key is not found
 */
export function extractFrontmatter(content: string, key: string): string | null {
  const clean = stripBOM(content)
  // Find the closing `---` delimiter. Start search at position 4
  // (after the opening `---\n`) to avoid matching the opening delimiter.
  const fmEnd = clean.indexOf("\n---", 4)
  if (fmEnd === -1) return null
  const fm = clean.slice(4, fmEnd)

  // Try folded block syntax first: `key: >` followed by indented lines.
  // The regex captures everything after `>` until a non-indented line or end.
  // Compiled once per distinct key and reused on all subsequent calls.
  const safeKey = escapeRegex(key)
  let multiRe = _fmMultiReCache.get(safeKey)
  if (!multiRe) {
    multiRe = new RegExp(`(?:^|\\r?\\n)${safeKey}:\\s*>(.+?)(?=\\r?\\n\\S|$)`, "s")
    _fmMultiReCache.set(safeKey, multiRe)
  }
  const multiMatch = fm.match(multiRe)
  if (multiMatch) {
    // Collapse multi-line folded text into a single space-separated line
    return multiMatch[1].replace(/\n\s*/g, " ").trim()
  }

  // Fall back to single-line syntax: `key: value`
  let singleRe = _fmSingleReCache.get(safeKey)
  if (!singleRe) {
    singleRe = new RegExp(`^${safeKey}:\\s*(.+)$`, "m")
    _fmSingleReCache.set(safeKey, singleRe)
  }
  const singleMatch = fm.match(singleRe)
  return singleMatch ? singleMatch[1].trim() : null
}

// ── Security ───────────────────────────────────────────────

/**
 * Windows reserved device names that cause issues with readdir, zip, and git.
 * Blocked case-insensitively to prevent bypass via casing tricks.
 */
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
])

/**
 * Validates that a directory name is safe to use as a skill identifier.
 *
 * Rejects names that could be used for path traversal attacks:
 *   - `..` and `.` — relative path navigation
 *   - `/` and `\` — path separators that could escape the skills directory
 *   - Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
 *     — break readdir, zip, git on Windows
 *
 * This is a defense-in-depth check. The discovery code also resolves
 * symlinks and checks for symbolic links, but this provides an additional
 * layer of protection at the name validation level.
 *
 * @param name - Directory name from filesystem enumeration
 * @returns true if the name is safe to use, false if it should be skipped
 */
export function isValidSkillName(name: string): boolean {
  if (name === ".." || name === ".") return false
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false
  if (WINDOWS_RESERVED.has(name.toLowerCase())) return false
  return true
}

/**
 * Sanitizes skill content before injecting into LLM context.
 *
 * Strips dangerous HTML patterns that could be used for prompt injection
 * or XSS-like attacks when the content is rendered in the LLM context:
 *   - <script>, <iframe>, <object>, <embed>, <form> tags
 *   - javascript: URIs
 *   - event handler attributes (onclick, onerror, etc.)
 *   - <meta> refresh tags
 *
 * This is defense-in-depth: skill files are local text, but malicious
 * content could still attempt to manipulate the LLM via HTML injection.
 *
 * @param content - Raw skill file content
 * @returns Sanitized content with dangerous patterns stripped
 */
const SANITIZE_PATTERNS: [RegExp, string][] = [
  [/<script[\s\S]*?<\/script>/gi, "[script removed]"],
  [/<iframe[\s\S]*?<\/iframe>/gi, "[iframe removed]"],
  [/<object[\s\S]*?<\/object>/gi, "[object removed]"],
  [/<embed[\s\S]*?<\/embed>/gi, "[embed removed]"],
  [/<form[\s\S]*?<\/form>/gi, "[form removed]"],
  [/<meta\s+http-equiv=["']?refresh["']?[^>]*>/gi, "[meta refresh removed]"],
  [/\bon\w+\s*=\s*(?:["'][^"']*["']|[^\s>]+)/gi, "[event handler removed]"],
  [/javascript\s*:/gi, "[javascript uri removed]"],
]

export function sanitizeSkillContent(content: string): string {
  let result = content
  for (const [re, replacement] of SANITIZE_PATTERNS) {
    result = result.replace(re, replacement)
  }
  return result
}
