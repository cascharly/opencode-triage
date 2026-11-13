/**
 * Shared helper functions for the opencode-triage CLI.
 * Extracted from opencode-triage.cjs to avoid duplication (W3).
 */

const fs = require("fs")
const path = require("path")
const { stripJsoncComments, levenshtein, extractFrontmatterField } = require("./shared.cjs")

const PLUGIN_NAME = "opencode-triage"

function findProjectRoot(startDir) {
  let dir = startDir
  while (true) {
    const candidates = [
      path.join(dir, ".opencode", "opencode.json"),
      path.join(dir, ".opencode", "opencode.jsonc"),
      path.join(dir, "opencode.json"),
      path.join(dir, "opencode.jsonc"),
    ]
    for (const configPath of candidates) {
      if (fs.existsSync(configPath)) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

function safeRenameSync(src, dst) {
  try {
    if (fs.existsSync(dst)) fs.unlinkSync(dst)
    fs.renameSync(src, dst)
    return true
  } catch (err) {
    if (err.code === "EXDEV") {
      if (fs.existsSync(dst)) fs.unlinkSync(dst)
      fs.copyFileSync(src, dst)
      fs.unlinkSync(src)
      return true
    } else {
      throw err
    }
  }
}

function sanitizeName(name) {
  return name.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
}

function suggestCommand(input) {
  const commands = ["on", "off", "enable", "disable", "mode", "status", "dedupe", "compare", "version", "help"]
  let best = null, bestDist = Infinity
  for (const cmd of commands) {
    const d = levenshtein(input, cmd)
    if (d < bestDist) { bestDist = d; best = cmd }
  }
  return bestDist <= 3 ? best : null
}

function isTriageEntry(entry) {
  return entry === PLUGIN_NAME || (Array.isArray(entry) && entry[0] === PLUGIN_NAME)
}

function findTriageIndex(plugin) {
  for (let i = 0; i < plugin.length; i++) {
    if (isTriageEntry(plugin[i])) return i
  }
  return -1
}

function setPluginMode(plugin, mode) {
  const idx = findTriageIndex(plugin)
  if (mode === "auto") {
    const entry = ["opencode-triage", { autoHide: true }]
    if (idx >= 0) plugin[idx] = entry
    else plugin.push(entry)
  } else {
    if (idx >= 0) {
      plugin.splice(idx, 1)
      plugin.push("opencode-triage")
    } else plugin.push("opencode-triage")
  }
}

function collectSkills(SKILL_DIRS) {
  const skills = []
  const seen = new Set()
  for (const { base, label, scope } of SKILL_DIRS) {
    if (!fs.existsSync(base)) continue
    const dirs = fs.readdirSync(base, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      if (d.isSymbolicLink()) continue
      if (d.name === "triage") continue
      if (d.name.includes(path.sep) || d.name === ".." || d.name === ".") continue
      const key = `${scope}:${d.name}`
      if (seen.has(key)) continue
      const hasDisabled = fs.existsSync(path.join(base, d.name, "SKILL.md.disabled"))
      const hasActive = fs.existsSync(path.join(base, d.name, "SKILL.md"))
      if (hasDisabled || hasActive) {
        seen.add(key)
        skills.push({
          name: sanitizeName(d.name),
          label,
          scope,
          state: hasDisabled ? "hidden" : "exposed",
          dirPath: path.join(base, d.name),
        })
      }
    }
  }
  return skills
}

function collectConfigState(LOCAL_CFG_PATH, GLOBAL_CFG_PATH) {
  function readMode(path) {
    try {
      const raw = fs.readFileSync(path, "utf-8")
      const plugin = JSON.parse(stripJsoncComments(raw)).plugin || []
      const idx = findTriageIndex(plugin)
      if (idx < 0) return { active: false, mode: "manual" }
      return {
        active: true,
        mode: Array.isArray(plugin[idx]) && plugin[idx][1]?.autoHide === true ? "auto" : "manual",
      }
    } catch { return { active: false, mode: "manual" } }
  }

  const local = readMode(LOCAL_CFG_PATH)
  const global = readMode(GLOBAL_CFG_PATH)

  return { localActive: local.active, globalActive: global.active, localMode: local.mode, globalMode: global.mode }
}

function renameSkillFiles(SKILL_DIRS, fromExt, toExt, isDryRun) {
  let count = 0
  for (const { base } of SKILL_DIRS) {
    if (!fs.existsSync(base)) continue
    const dirs = fs.readdirSync(base, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue
      if (d.name === "triage") continue
      const src = path.join(base, d.name, "SKILL" + fromExt)
      const dst = path.join(base, d.name, "SKILL" + toExt)
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        if (!isDryRun) safeRenameSync(src, dst)
        count++
      }
    }
  }
  return count
}

function findDuplicateNames(skills) {
  const seen = {}
  for (const s of skills) {
    seen[s.name] = (seen[s.name] || 0) + 1
  }
  return new Set(Object.entries(seen).filter(([_, c]) => c > 1).map(([n]) => n))
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

function buildNativeSkillXml(skills) {
  if (skills.length === 0) return ""
  const items = skills.map(s => {
    const name = s.nativeName || s.name
    const desc = s.nativeDesc || ""
    return `<skill>\n<name>${name}</name>\n<description>${desc}</description>\n</skill>`
  }).join("\n")
  return `<available_skills>\n${items}\n</available_skills>`
}

function calcHiddenSkillTokens(SKILL_DIRS) {
  const xmlEntries = []
  const seen = new Set()
  for (const { base, scope } of SKILL_DIRS) {
    if (!fs.existsSync(base)) continue
    const dirs = fs.readdirSync(base, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      if (d.isSymbolicLink()) continue
      if (d.name === "triage") continue
      if (d.name.includes(path.sep) || d.name === ".." || d.name === ".") continue
      const key = `${scope}:${d.name}`
      if (seen.has(key)) continue
      const dirPath = path.join(base, d.name)
      const file = fs.existsSync(path.join(dirPath, "SKILL.md.disabled"))
        ? path.join(dirPath, "SKILL.md.disabled")
        : fs.existsSync(path.join(dirPath, "SKILL.md"))
          ? path.join(dirPath, "SKILL.md")
          : null
      if (file) {
        try {
          const content = fs.readFileSync(file, "utf-8")
          const nativeName = extractFrontmatterField(content, "name") || d.name
          const nativeDesc = extractFrontmatterField(content, "description") || ""
          seen.add(key)
          xmlEntries.push({ nativeName, nativeDesc })
        } catch {}
      }
    }
  }
  const xml = buildNativeSkillXml(xmlEntries)
  return estimateTokens(xml)
}

function readSkillContent(dirPath) {
  const disabled = path.join(dirPath, "SKILL.md.disabled")
  const active = path.join(dirPath, "SKILL.md")
  const file = fs.existsSync(disabled) ? disabled : fs.existsSync(active) ? active : null
  if (!file) return { content: "", filePath: null }
  try { return { content: fs.readFileSync(file, "utf-8"), filePath: file } } catch { return { content: "", filePath: null } }
}

module.exports = {
  PLUGIN_NAME,
  findProjectRoot,
  safeRenameSync,
  sanitizeName,
  suggestCommand,
  isTriageEntry,
  findTriageIndex,
  setPluginMode,
  collectSkills,
  collectConfigState,
  renameSkillFiles,
  findDuplicateNames,
  estimateTokens,
  buildNativeSkillXml,
  calcHiddenSkillTokens,
  readSkillContent,
}
