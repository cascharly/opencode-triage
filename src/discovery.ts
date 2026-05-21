/**
 * Skill discovery module.
 *
 * Handles filesystem scanning for SKILL.md files across project and global
 * directories, reading skill content, and migrating file extensions when
 * hooks are detected.
 *
 * Responsibilities:
 *   - Build list of directories to scan for skills
 *   - Discover all skills from filesystem locations
 *   - Read individual skill files with fallback to .disabled
 *   - Rename SKILL.md ↔ SKILL.md.disabled for hook-based toggling
 */

import { homedir } from "node:os"
import { join, basename } from "node:path"
import { readdir, realpath, rename, readFile } from "node:fs/promises"
import { MAX_SKILL_SIZE, MAX_TOTAL_SKILL_SIZE } from "./config.ts"
import type { SkillEntry } from "./config.ts"
import { extractFrontmatter, stripBOM, isValidSkillName, sanitizeSkillContent } from "./utils.ts"

/**
 * Builds the list of directories to scan for skill files.
 *
 * Searches both project-level (.agent/, .agents/, .claude/, .opencode/)
 * and global (~/.agents/, ~/.claude/, ~/.config/opencode/) skills directories.
 * Project skills take precedence over global skills of the same name.
 *
 * @param worktree - Git worktree root or current working directory
 * @returns Array of {base, scope} pairs to scan
 */
export function buildSkillLocations(worktree: string) {
  return [
    { base: join(worktree, ".agent", "skills"), scope: "project" as const },
    { base: join(worktree, ".agents", "skills"), scope: "project" as const },
    { base: join(worktree, ".claude", "skills"), scope: "project" as const },
    { base: join(worktree, ".opencode", "skills"), scope: "project" as const },
    { base: join(homedir(), ".agents", "skills"), scope: "global" as const },
    { base: join(homedir(), ".claude", "skills"), scope: "global" as const },
    { base: join(homedir(), ".config", "opencode", "skills"), scope: "global" as const },
    { base: join(homedir(), ".gemini", "config", "skills"), scope: "global" as const },
  ]
}

/**
 * Discovers all skills from the provided filesystem locations.
 *
 * Resolves symlinks, enumerates subdirectories, reads frontmatter from
 * SKILL.md files (primary) with SKILL.md.disabled as fallback for users
 * on older OpenCode versions. Deduplicates by name and sorts project
 * skills before global ones.
 *
 * Non-ENOENT errors are logged to stderr but do not halt discovery.
 *
 * @param locations - Array of {base, scope} directory pairs to scan
 * @param getExcludedSkills - Function returning set of excluded skill names
 * @returns Deduplicated, sorted array of discovered skills
 */
export async function discoverAllSkills(
  locations: { base: string; scope: "project" | "global" }[],
  getExcludedSkills: () => Set<string>
): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = []
  const seen = new Set<string>()
  const excluded = getExcludedSkills()
  let totalBytesRead = 0

  for (const { base, scope } of locations) {
    try {
      const resolvedBase = await realpath(base)
      const entries = await readdir(resolvedBase, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.isSymbolicLink()) continue
        if (excluded.has(entry.name)) continue
        if (!isValidSkillName(entry.name)) continue

        const result = await tryReadSkill(join(resolvedBase, entry.name))
        if (result && !seen.has(result.name)) {
          totalBytesRead += result.size
          if (totalBytesRead > MAX_TOTAL_SKILL_SIZE) {
            console.error("[opencode-triage] Total skill size exceeds 10MB limit — stopping discovery")
            break
          }
          seen.add(result.name)
          skills.push({ name: result.name, desc: result.desc, path: result.path, scope })
        }
      }
    } catch (err) {
      const baseName = basename(base)
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[opencode-triage] Error scanning ${baseName}:`, (err as Error).message)
      }
    }
  }

  skills.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })

  return skills
}

/**
 * Attempts to read a skill definition from a directory.
 *
 * Reads SKILL.md first, falls back to SKILL.md.disabled.
 * .disabled fallback supports users who still use the CLI's file-rename
 * toggle on older OpenCode versions where hooks may not be available.
 *
 * @param skillDir - Absolute path to a skill subdirectory
 * @returns Parsed skill entry (without scope) with size, or null if neither file exists
 */
async function tryReadSkill(
  skillDir: string
): Promise<(Omit<SkillEntry, "scope"> & { size: number }) | null> {
  const filenames = ["SKILL.md", "SKILL.md.disabled"]
  for (const fn of filenames) {
    const filePath = join(skillDir, fn)
    try {
      const content = await readFile(filePath, "utf-8")
      const name = extractFrontmatter(content, "name") ?? basename(skillDir)
      const desc = extractFrontmatter(content, "description") ?? ""
      const size = Buffer.byteLength(content, "utf-8")
      return { name, desc, path: filePath, size }
    } catch { /* try next filename */ }
  }
  return null
}

/**
 * Reads a skill file, strips YAML frontmatter, returns body content.
 *
 * Enforces a 1MB size limit to prevent memory exhaustion. Strips UTF-8
 * BOM for Windows compatibility. Returns error strings on failure rather
 * than throwing, so the triage tool always returns a usable string.
 *
 * @param filePath - Absolute path to SKILL.md or SKILL.md.disabled
 * @returns Body content without frontmatter, or an error string
 */
export async function readSkillContent(filePath: string): Promise<string> {
  try {
    const buf = await readFile(filePath)
    if (buf.byteLength > MAX_SKILL_SIZE) {
      return `(skill content truncated: exceeds 1MB limit)`
    }
    const content = buf.toString("utf-8")
    const clean = stripBOM(content)
    const bodyMatch = clean.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n*([\s\S]*)/)
    const body = bodyMatch ? bodyMatch[1].trim() : clean.trim()
    return sanitizeSkillContent(body)
  } catch {
    return "(skill content unavailable)"
  }
}

/**
 * Renames SKILL.md files between .md and .md.disabled extensions.
 *
 * Used for hook-based toggling: when hooks are detected, migrate any
 * remaining .disabled files to .md (upgrade from old triage).
 *
 * @param fromExt - Source extension (".md" or ".md.disabled")
 * @param getExcludedSkills - Function returning set of excluded skill names
 * @returns Number of files successfully renamed
 */
export async function renameSkills(
  fromExt: string,
  getExcludedSkills: () => Set<string>
): Promise<number> {
  const toExt = fromExt === ".md" ? ".md.disabled" : ".md"
  const excluded = getExcludedSkills()
  const locations = buildSkillLocations(process.cwd())
  let count = 0
  for (const { base } of locations) {
    try {
      const resolvedBase = await realpath(base)
      const entries = await readdir(resolvedBase, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.isSymbolicLink()) continue
        if (excluded.has(entry.name)) continue
        if (!isValidSkillName(entry.name)) continue
        const src = join(resolvedBase, entry.name, `SKILL${fromExt}`)
        const dst = join(resolvedBase, entry.name, `SKILL${toExt}`)
        try {
          await rename(src, dst)
          count++
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`[opencode-triage] Failed to rename ${src}:`, err)
          }
        }
      }
    } catch { /* dir doesn't exist */ }
  }
  return count
}

