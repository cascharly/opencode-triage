/**
 * Simulation script: scores real installed skills against sample queries.
 * Compares vanilla vs improved scoring.
 *
 * Run: node --experimental-strip-types scripts/simulate.ts
 */
import { scoreSkills, getWordBonus } from "../src/scoring.ts"
import { THRESHOLD, NAME_WEIGHT, DESC_WEIGHT, BIGRAM_BONUS, PHRASE_BONUS, type SkillEntry, type ScoredSkill } from "../src/config.ts"
import { homedir } from "node:os"
import { join, basename } from "node:path"
import { readdir, readFile, realpath } from "node:fs/promises"

const WORKTREE = process.cwd()

function getExcludedSkills(): Set<string> {
  const env = process.env.OPENCODE_TRIAGE_EXCLUDED
  if (env) return new Set(env.split(",").map(s => s.trim()).filter(Boolean))
  return new Set(["triage"])
}

function buildSkillLocations(worktree: string) {
  return [
    { base: join(worktree, ".agent", "skills"), scope: "project" as const },
    { base: join(worktree, ".agents", "skills"), scope: "project" as const },
    { base: join(worktree, ".claude", "skills"), scope: "project" as const },
    { base: join(worktree, ".opencode", "skills"), scope: "project" as const },
    { base: join(homedir(), ".agents", "skills"), scope: "global" as const },
    { base: join(homedir(), ".claude", "skills"), scope: "global" as const },
    { base: join(homedir(), ".config", "opencode", "skills"), scope: "global" as const },
  ]
}

function isValidSkillName(name: string): boolean {
  if (name === ".." || name === ".") return false
  if (name.includes("/") || name.includes("\\")) return false
  return true
}

function extractFrontmatter(content: string, key: string): string | null {
  const clean = content.replace(/^\uFEFF/, "")
  const fmStart = clean.indexOf("---")
  if (fmStart !== 0) return null
  const fmEnd = clean.indexOf("---", 3)
  if (fmEnd === -1) return null
  const fm = clean.slice(3, fmEnd).trim()

  const keyRe = new RegExp(`^${key}:\\s*(?:(>\\s*)?\\n?)(.*?)(?=\\n\\w|$)`, "sm")
  const match = fm.match(keyRe)
  if (!match) return null
  if (match[1]) {
    const lines = match[2].trim().split("\\n")
    return lines.map(l => l.trim()).join(" ")
  }
  return match[2].trim() || null
}

async function tryReadSkill(skillDir: string): Promise<Omit<SkillEntry, "scope"> | null> {
  for (const fn of ["SKILL.md", "SKILL.md.disabled"]) {
    try {
      const content = await readFile(join(skillDir, fn), "utf-8")
      const name = extractFrontmatter(content, "name") ?? basename(skillDir)
      const desc = extractFrontmatter(content, "description") ?? ""
      return { name, desc, path: join(skillDir, fn) }
    } catch { /* try next */ }
  }
  return null
}

async function discoverAllSkills(
  locations: { base: string; scope: "project" | "global" }[]
): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = []
  const seen = new Set<string>()
  const excluded = getExcludedSkills()

  for (const { base, scope } of locations) {
    try {
      const resolvedBase = await realpath(base)
      const entries = await readdir(resolvedBase, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        if (excluded.has(entry.name) || !isValidSkillName(entry.name)) continue
        const result = await tryReadSkill(join(resolvedBase, entry.name))
        if (result && !seen.has(result.name)) {
          seen.add(result.name)
          skills.push({ ...result, scope })
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[simulate] Error scanning ${base}:`, err)
      }
    }
  }

  skills.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })

  return skills
}

// Vanilla scoring for comparison (no IDF, no bigram, no phrase, no position decay)
function scoreSkillsVanilla(query: string, skills: SkillEntry[]): ScoredSkill[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/^[^a-z0-9\u00C0-\u017F]+|[^a-z0-9\u00C0-\u017F]+$/g, ""))
    .filter(w => w.length >= 3)

  return skills.map(skill => {
    const nameLower = skill.name.toLowerCase()
    const descLower = skill.desc.toLowerCase()
    let score = 0
    let descScore = 0
    const matched: string[] = []

    for (const word of words) {
      const bonus = getWordBonus(word, nameLower)
      if (bonus > 0) {
        score += NAME_WEIGHT * bonus
        matched.push(`name:${word}`)
      }
    }
    for (const word of words) {
      const bonus = getWordBonus(word, descLower)
      if (bonus > 0) {
        score += DESC_WEIGHT * bonus
        descScore += DESC_WEIGHT * bonus
        matched.push(`desc:${word}`)
      }
    }

    return { ...skill, score, descScore, matchedBy: matched.join(", ") }
  })
}

function classify(scored: ScoredSkill[]): { status: string; top: ScoredSkill | null; gap: number } {
  if (scored.length === 0) return { status: "NONE", top: null, gap: 0 }
  const top = scored[0]
  const gap = scored.length >= 2 ? top.score - scored[1].score : Infinity
  if (gap >= THRESHOLD) return { status: "AUTO", top, gap }
  if (scored.length >= 2 && scored[1].score > 0) return { status: "AMBIGUOUS", top, gap }
  return { status: "TIE", top, gap }
}

const QUERIES = [
  "create architecture diagram",
  "backup database",
  "write unit test",
  "react component",
  "optimize performance",
  "security vulnerability",
  "CI/CD pipeline",
  "lint code",
  "database migration",
  "deploy kubernetes",
  "clickup task",
  "webhook integration",
  "browser automation",
  "offer letter",
  "MCP tools",
  "refactor component",
  "ai agent builder",
  "check accessibility",
  "incident response",
  "next.js performance",
]

async function main() {
  const locations = buildSkillLocations(WORKTREE)
  const skills = await discoverAllSkills(locations)

  console.log(`Loaded ${skills.length} skills (${skills.filter(s => s.scope === "project").length} project, ${skills.filter(s => s.scope === "global").length} global)`)
  console.log("")
  console.log("Installed skills:")
  for (const s of skills) {
    const shortDesc = s.desc.length > 70 ? s.desc.slice(0, 67) + "..." : s.desc
    console.log(`  ${s.scope === "project" ? "[P]" : "[G]"} ${s.name}: ${shortDesc}`)
  }
  console.log("")

  let autoV = 0, ambV = 0, tieV = 0, noneV = 0
  let autoI = 0, ambI = 0, tieI = 0, noneI = 0

  for (const query of QUERIES) {
    const vanilla = scoreSkillsVanilla(query, skills).filter(s => s.score > 0).sort((a, b) => b.score - a.score)
    const improved = scoreSkills(query, skills).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

    const v = classify(vanilla)
    const i = classify(improved)

    if (v.status === "AUTO") autoV++; else if (v.status === "AMBIGUOUS") ambV++; else if (v.status === "TIE") tieV++; else noneV++
    if (i.status === "AUTO") autoI++; else if (i.status === "AMBIGUOUS") ambI++; else if (i.status === "TIE") tieI++; else noneI++

    // Only show queries where results differ, or all ambiguous/tie cases, or all
    const changed = v.status !== i.status || v.top?.name !== i.top?.name

    if (changed || v.status !== "AUTO" || i.status !== "AUTO") {
      console.log(`Query: "${query}"`)
      console.log(`  Vanilla:  ${v.status.padEnd(10)} ${v.top ? `${v.top.name} (${v.top.score.toFixed(1)})` : "—"}`)
      if (v.top && vanilla.length >= 2) {
        console.log(`            runner-up: ${vanilla[1].name} (${vanilla[1].score.toFixed(1)})`)
      }
      console.log(`  Improved: ${i.status.padEnd(10)} ${i.top ? `${i.top.name} (${i.top.score.toFixed(1)})` : "—"}`)
      if (i.top && improved.length >= 2) {
        console.log(`            runner-up: ${improved[1].name} (${improved[1].score.toFixed(1)})`)
      }
      if (changed) console.log(`  → ${v.status !== i.status ? `Status changed: ${v.status} → ${i.status}` : `Winner changed: ${v.top?.name} → ${i.top?.name}`}`)
      console.log("")
    }
  }

  const total = QUERIES.length
  console.log("--- Summary ---")
  console.log(`Vanilla:   AUTO ${autoV}/${total} | AMBIG ${ambV}/${total} | TIE ${tieV}/${total} | NONE ${noneV}/${total}`)
  console.log(`Improved:  AUTO ${autoI}/${total} | AMBIG ${ambI}/${total} | TIE ${tieI}/${total} | NONE ${noneI}/${total}`)
  console.log(`Auto-route rate: ${Math.round((autoV/total)*100)}% → ${Math.round((autoI/total)*100)}%`)
}

main().catch(console.error)
