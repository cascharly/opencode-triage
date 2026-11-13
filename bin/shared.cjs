/**
 * Shared utility functions for the opencode-triage CLI.
 * Extracted to avoid duplication and improve maintainability (W3).
 */

function stripJsoncComments(text) {
  let result = ""
  let inString = false
  let escape = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (escape) {
      result += ch
      escape = false
      i++
      continue
    }
    if (ch === "\\" && inString) {
      result += ch
      escape = true
      i++
      continue
    }
    if (ch === '"') {
      inString = !inString
      result += ch
      i++
      continue
    }
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
    result += ch
    i++
  }
  return result
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[m][n]
}

function extractFrontmatterField(content, key) {
  const clean = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
  const fmEnd = clean.indexOf("\n---", 4)
  if (fmEnd === -1) return null
  const fm = clean.slice(4, fmEnd)
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const multiRe = new RegExp(`^${safeKey}:\\s*>(.+?)(?=\\r?\\n\\S|$)`, "sm")
  const multiMatch = fm.match(multiRe)
  if (multiMatch) return multiMatch[1].replace(/\n\s*/g, " ").trim()
  const singleRe = new RegExp(`^${safeKey}:\\s*(.+)$`, "m")
  const singleMatch = fm.match(singleRe)
  return singleMatch ? singleMatch[1].trim() : null
}

function semverGt(a, b) {
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

module.exports = {
  stripJsoncComments,
  levenshtein,
  extractFrontmatterField,
  semverGt
}
