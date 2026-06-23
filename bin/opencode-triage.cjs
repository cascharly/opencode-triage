#!/usr/bin/env node
/*
 * opencode-triage CLI
 * ==================
 * Manage the opencode-triage skill router plugin.
 *
 * Usage: /triage on | off | status | compare | download-model | version | help
 *
 * Quickstart:
 *   /triage on    Hide all skills from the AI prompt (global + local)
 *   /triage off   Expose all skills to the AI prompt (global + local)
 *   /triage status  Show current state and skill counts
 *
 * Use /triage off before switching to Cursor or another AI tool.
 * Use /triage on to return to routed mode.
 *
 * Advanced: --local or --global to target a single scope instead of both.
 */

const fs = require("fs")
const path = require("path")
const os = require("os")
const https = require("https")
const readline = require("readline")

const PLUGIN_NAME = "opencode-triage"
const CMD = process.argv[2] || "help"
const FLAGS = process.argv.slice(3)

const isJson = FLAGS.includes("--json")
const isQuiet = FLAGS.includes("--quiet")
const isDryRun = FLAGS.includes("--dry-run")
const showAll = FLAGS.includes("--all")

let CURRENT_VERSION
try { CURRENT_VERSION = require(path.join(__dirname, "..", "package.json")).version }
catch { CURRENT_VERSION = "0.0.0" }

const WORKTREE = findProjectRoot(process.cwd())
const HOMEDIR = os.homedir()

const CMD_TEMPLATE = `---
description: Toggle, inspect, and benchmark the triage skill router
---
Run npx -y opencode-triage $ARGUMENTS and show the output verbatim.
If output contains "Restart opencode", tell the user to restart.
`
const LOCAL_CFG_PATH  = path.join(WORKTREE, ".opencode", "opencode.json")
const LOCAL_CMD_DIR   = path.join(WORKTREE, ".opencode", "commands")
const LOCAL_CMD_FILE  = path.join(LOCAL_CMD_DIR, "triage.md")
const GLOBAL_CFG_PATH = path.join(HOMEDIR, ".config", "opencode", "opencode.jsonc")
const GLOBAL_CMD_DIR  = path.join(HOMEDIR, ".config", "opencode", "commands")
const GLOBAL_CMD_FILE = path.join(GLOBAL_CMD_DIR, "triage.md")

const SKILL_DIRS = [
  { base: path.join(WORKTREE, ".agent", "skills"), label: ".agent/", scope: "project" },
  { base: path.join(WORKTREE, ".agents", "skills"), label: ".agents/", scope: "project" },
  { base: path.join(WORKTREE, ".claude", "skills"), label: ".claude/", scope: "project" },
  { base: path.join(WORKTREE, ".opencode", "skills"), label: ".opencode/", scope: "project" },
  { base: path.join(HOMEDIR, ".agents", "skills"), label: "~/.agents/", scope: "global" },
  { base: path.join(HOMEDIR, ".claude", "skills"), label: "~/.claude/", scope: "global" },
  { base: path.join(HOMEDIR, ".config", "opencode", "skills"), label: "~/.config/opencode/", scope: "global" },
]

const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

// ── Helpers ───────────────────────────────────────────────

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

// Levenshtein distance for command suggestion
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

function suggestCommand(input) {
  const commands = ["on", "off", "enable", "disable", "mode", "status", "dedupe", "compare", "download-model", "version", "help"]
  let best = null, bestDist = Infinity
  for (const cmd of commands) {
    const d = levenshtein(input, cmd)
    if (d < bestDist) { bestDist = d; best = cmd }
  }
  return bestDist <= 3 ? best : null
}

// ── Main Router ───────────────────────────────────────────

function main() {
  const scopeFlag = FLAGS.includes("--both") ? "both"
    : FLAGS.includes("--local") ? "local"
    : FLAGS.includes("--global") ? "global"
    : null
  const toggleScope = scopeFlag || "both"

  switch (CMD) {
    case "on":
    case "enable":
      return toggle(true, toggleScope)
    case "off":
    case "disable":
      return toggle(false, toggleScope)
    case "status":
      return showStatus()
    case "dedupe":
    case "deduplicate":
      return dedupeSkills()
    case "mode":
      const modeArg = FLAGS.find(f => f === "auto" || f === "manual")
      return setMode(modeArg || "auto", toggleScope)
    case "compare":
      return showCompare()
    case "download-model":
      return downloadModel()
    case "version":
    case "--version":
    case "-v":
      return showVersion()
    case "help":
    case "--help":
    case "-h":
      return showHelp()
    default:
      const suggestion = suggestCommand(CMD)
      if (suggestion) {
        console.error(`Unknown command: ${CMD}. Did you mean "${suggestion}"?`)
      } else {
        console.error(`Unknown command: ${CMD}`)
      }
      console.error()
      console.error(`Usage: /triage on | off | status | dedupe | compare | version | help`)
      console.error(`Try /triage help for detailed usage.`)
      process.exit(1)
  }
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

// ── Collect skills data (shared by status, compare, toggle) ──

function collectSkills() {
  const skills = []
  // Dedup by scope+name: if the same directory name appears in multiple
  // directories of the same scope (e.g. .agents/skills/ and .claude/skills/),
  // keep only the first occurrence. SKILL_DIRS order determines priority.
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

function collectConfigState() {
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

// ── File rename for skill files ───────────────────────────

function renameSkillFiles(fromExt, toExt) {
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

// ── toggle ────────────────────────────────────────────────

function toggle(enable, scope) {
  const scopes = scope === "both" ? ["global", "local"] : [scope]
  for (const s of scopes) {
    const cfgPath = s === "global" ? GLOBAL_CFG_PATH : LOCAL_CFG_PATH
    writeTriageState(cfgPath, enable)
  }

  // Restore .disabled files back to .md — hooks handle hiding at LLM level.
  // Run on both on and off: stale .disabled from old versions should be cleaned up.
  const renamed = renameSkillFiles(".md.disabled", ".md")
  if (renamed > 0 && !isQuiet) {
    console.log(`  ${renamed} skill(s) restored from .disabled to SKILL.md`)
  }

  const scopeLabel = scope === "both" ? "" : ` — ${scope} scope`
  console.log()
  console.log(BOLD + "Triage " + (enable ? "ON" : "OFF") + scopeLabel + RESET)
  console.log()
  if (enable) {
    console.log(DIM + "  Hooks hide skills from LLM. SKILL.md files stay intact — other AI tools still see them." + RESET)
  } else {
    console.log(DIM + "  All skills exposed to LLM again." + RESET)
  }
  console.log(`  ${YELLOW}Restart opencode for changes to take effect.${RESET}`)
  console.log()
}

// Write autoHide: true/false into the plugin entry in config.
// Does NOT add or remove the plugin — only sets the autoHide flag.
// Creates the config if enabling and it doesn't exist yet.
function writeTriageState(configPath, enable) {
  let config = {}
  let exists = false
  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    config = JSON.parse(stripJsoncComments(raw))
    exists = true
  } catch {}

  // If config doesn't exist and we're disabling, nothing to persist
  if (!exists && !enable) return
  if (!exists) config = { "$schema": "https://opencode.ai/config.json" }

  config.plugin = config.plugin || []
  const idx = findTriageIndex(config.plugin)

  // If plugin not registered and we're disabling, nothing to persist
  if (idx < 0 && !enable) return

  const entry = [PLUGIN_NAME, { autoHide: enable }]
  if (idx >= 0) config.plugin[idx] = entry
  else config.plugin.push(entry)

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
  if (!isQuiet) console.log(`Config:    autoHide=${enable} → ${configPath}`)
}

function updateLocalConfig(enable) {
  let config = {}
  let hadPlugin = false
  try {
    const raw = fs.readFileSync(LOCAL_CFG_PATH, "utf-8")
    config = JSON.parse(stripJsoncComments(raw))
    hadPlugin = (config.plugin || []).some(isTriageEntry)
  } catch {
    config = { "$schema": "https://opencode.ai/config.json" }
  }
  config.plugin = config.plugin || []
  const idx = findTriageIndex(config.plugin)
  if (enable && !hadPlugin) {
    config.plugin.push(PLUGIN_NAME)
    if (!isQuiet) console.log(`Config:    added to ${LOCAL_CFG_PATH}`)
  } else if (!enable && hadPlugin) {
    config.plugin.splice(idx, 1)
    if (!isQuiet) console.log(`Config:    removed from ${LOCAL_CFG_PATH}`)
  }
  fs.mkdirSync(path.dirname(LOCAL_CFG_PATH), { recursive: true })
  fs.writeFileSync(LOCAL_CFG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

function updateGlobalConfig(enable) {
  if (!fs.existsSync(GLOBAL_CFG_PATH)) {
    if (!enable) return
    const config = { "$schema": "https://opencode.ai/config.json", plugin: [PLUGIN_NAME] }
    fs.mkdirSync(path.dirname(GLOBAL_CFG_PATH), { recursive: true })
    fs.writeFileSync(GLOBAL_CFG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8")
    if (!isQuiet) console.log(`Config:    created ${GLOBAL_CFG_PATH} with plugin`)
    return
  }
  const raw = fs.readFileSync(GLOBAL_CFG_PATH, "utf-8")
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    const stripped = stripJsoncComments(raw)
    try {
      config = JSON.parse(stripped)
    } catch {
      console.error(`Could not parse ${GLOBAL_CFG_PATH} — skipping plugin toggle`)
      return
    }
  }
  config.plugin = config.plugin || []
  const hadPlugin = config.plugin.some(isTriageEntry)
  const idx = findTriageIndex(config.plugin)
  if (enable) {
    if (!hadPlugin) {
      config.plugin.push(PLUGIN_NAME)
      fs.writeFileSync(GLOBAL_CFG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8")
      if (!isQuiet) console.log(`Config:    added to ${GLOBAL_CFG_PATH}`)
    }
  } else {
    if (hadPlugin) {
      config.plugin.splice(idx, 1)
      fs.writeFileSync(GLOBAL_CFG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8")
      if (!isQuiet) console.log(`Config:    removed from ${GLOBAL_CFG_PATH}`)
    }
  }
}

function updatePluginConfigMode(configPath, mode) {
  let raw
  try {
    raw = fs.readFileSync(configPath, "utf-8")
  } catch { return false }

  const config = JSON.parse(stripJsoncComments(raw))
  config.plugin = config.plugin || []
  const idx = findTriageIndex(config.plugin)

  if (mode === "auto") {
    if (idx >= 0 && Array.isArray(config.plugin[idx]) && config.plugin[idx][1]?.autoHide === true) return false
    setPluginMode(config.plugin, "auto")
  } else {
    if (idx >= 0 && config.plugin[idx] === PLUGIN_NAME) return false
    setPluginMode(config.plugin, "manual")
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
  return true
}

function setMode(mode, scope) {
  const scopes = scope === "both" ? ["global", "local"] : [scope]
  let changed = 0

  for (const s of scopes) {
    const cfgPath = s === "global" ? GLOBAL_CFG_PATH : LOCAL_CFG_PATH
    if (updatePluginConfigMode(cfgPath, mode)) {
      if (!isQuiet) console.log(`Config:    updated ${cfgPath}`)
      changed++
    }
  }

  const modeLabel = mode === "auto" ? "AUTO" : "MANUAL"
  const scopeLabel = scope === "both" ? " (both scopes)" : ` (${scope} scope)`
  console.log()
  console.log(BOLD + "Triage mode: " + modeLabel + scopeLabel + RESET)
  console.log()
  if (changed > 0) {
    console.log(YELLOW + "Restart opencode for changes to take effect." + RESET)
  } else {
    console.log("  Already in " + mode + " mode — no changes.")
  }
  console.log()
}

function findDuplicateNames(skills) {
  const seen = {}
  for (const s of skills) {
    seen[s.name] = (seen[s.name] || 0) + 1
  }
  return new Set(Object.entries(seen).filter(([_, c]) => c > 1).map(([n]) => n))
}

// ── dedupe ────────────────────────────────────────────────

function dedupeSkills() {
  const skills = collectSkills()
  const dupNames = findDuplicateNames(skills)

  if (dupNames.size === 0) {
    console.log()
    console.log("No duplicate skills found. Nothing to deduplicate.")
    console.log()
    return
  }

  // Group duplicates by name
  const dupGroups = {}
  for (const s of skills) {
    if (dupNames.has(s.name)) {
      if (!dupGroups[s.name]) dupGroups[s.name] = { project: null, global: null }
      dupGroups[s.name][s.scope] = s
    }
  }

  if (isDryRun) {
    console.log()
    console.log(BOLD + "Deduplicating skills (dry run)" + RESET)
    console.log()
    for (const [name, group] of Object.entries(dupGroups)) {
      console.log(`  ${name.padEnd(30)} local: ${group.project ? group.project.label : "none"} | global: ${group.global ? group.global.label : "none"}`)
    }
    console.log()
    console.log(`  ${Object.keys(dupGroups).length} duplicate group(s) found. No changes made.`)
    console.log()
    return
  }

  // Interactive mode: ask user which scope to delete for each duplicate
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  function ask(question) {
    return new Promise(resolve => rl.question(question, resolve))
  }

  async function run() {
    console.log()
    console.log(BOLD + "Deduplicating skills" + RESET)
    console.log()

    let removed = 0
    let errors = 0

    for (const [name, group] of Object.entries(dupGroups)) {
      const hasLocal = !!group.project
      const hasGlobal = !!group.global

      if (!hasLocal || !hasGlobal) continue

      console.log(`  ${BOLD}${name}${RESET}`)
      console.log(`    Local:  ${group.project.label} (${group.project.dirPath})`)
      console.log(`    Global: ${group.global.label} (${group.global.dirPath})`)
      console.log()

      const answer = await ask(`  Delete [l]ocal or [g]lobal copy? (l/g): `)
      const choice = answer.trim().toLowerCase()

      let toDelete = null
      if (choice === "l") {
        toDelete = group.project
        console.log(`  ${YELLOW}Deleting local copy...${RESET}`)
      } else if (choice === "g") {
        toDelete = group.global
        console.log(`  ${YELLOW}Deleting global copy...${RESET}`)
      } else {
        console.log(`  ${DIM}Skipped — invalid choice${RESET}`)
        continue
      }

      const files = []
      const disabledPath = path.join(toDelete.dirPath, "SKILL.md.disabled")
      const activePath = path.join(toDelete.dirPath, "SKILL.md")
      if (fs.existsSync(disabledPath)) files.push(disabledPath)
      if (fs.existsSync(activePath)) files.push(activePath)

      if (files.length === 0) {
        console.log(`  ${DIM}No skill files found — skipping${RESET}`)
        continue
      }

      let ok = true
      for (const f of files) {
        try {
          fs.unlinkSync(f)
        } catch (err) {
          console.error(`  ${RED}[error]${RESET} could not delete ${path.basename(f)}: ${err.message}`)
          ok = false
          errors++
        }
      }
      if (ok) {
        console.log(`  ${GREEN}[removed]${RESET} ${toDelete.label} copy deleted`)
        removed++
      }
      console.log()
    }

    rl.close()

    console.log(`  ${removed} duplicate(s) removed. ${errors > 0 ? errors + " error(s). " : ""}`)
    if (removed > 0) {
      console.log()
      console.log(YELLOW + "  Restart opencode for changes to take effect." + RESET)
    }
    console.log()
  }

  run()
}

// ── status ────────────────────────────────────────────────

function calcHiddenSkillTokens() {
  // Count only the name+description XML per skill — that is what the native
  // `skill` tool injects into the prompt. Full bodies are loaded on-demand
  // and cost the same whether triage is active or not.
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

function showStatus() {
  const { localActive, globalActive, localMode, globalMode } = collectConfigState()
  const skills = collectSkills()
  const dupNames = findDuplicateNames(skills)

  const projSkills = skills.filter(s => s.scope === "project")
  const gloSkills = skills.filter(s => s.scope === "global")
  const projHidden = projSkills.filter(s => s.state === "hidden").length
  const projExposed = projSkills.filter(s => s.state === "exposed").length
  const gloHidden = gloSkills.filter(s => s.state === "hidden").length
  const gloExposed = gloSkills.filter(s => s.state === "exposed").length
  const totalHidden = projHidden + gloHidden
  const totalExposed = projExposed + gloExposed
  const hiddenTokens = calcHiddenSkillTokens()

  // NET savings: native XML list (name+desc per skill) minus triage tool def.
  // Skill body loading costs the same on both sides (on-demand), so it cancels out.
  const TOOL_DEF_TEXT =
    "Discover and route to the right specialized skill. " +
    "Call this before any non-trivial task. " +
    "Pass a brief description. Returns the best match or a list of candidates." +
    "Brief description of what you need help with, e.g. 'backup my database'"
  const toolDefTokens = estimateTokens(TOOL_DEF_TEXT)
  const netSavings = hiddenTokens - toolDefTokens

  // Effective state: hooks first, file rename as fallback indicator
  // "on"  = hooks active OR all files renamed
  // "off" = hooks off AND no files renamed
  function effectiveState(scope) {
    const active = scope === "project" ? localActive : globalActive
    const mode = scope === "project" ? localMode : globalMode
    const skillsArr = scope === "project" ? projSkills : gloSkills
    const hidden = skillsArr.filter(s => s.state === "hidden").length
    const exposed = skillsArr.filter(s => s.state === "exposed").length
    if (skillsArr.length === 0) return "none"
    if (mode === "auto") return "on"                 // hooks primary
    if (hidden > 0 && exposed === 0) return "on"     // file rename fallback
    if (hidden === 0) return "off"
    return "mixed"
  }

  const projState = effectiveState("project")
  const gloState = effectiveState("global")

  function stateColor(state) { return state === "on" ? GREEN : YELLOW }
  function stateText(state) {
    return state === "on" ? "ON" : state === "off" ? "OFF" : state === "mixed" ? "MIXED" : "—"
  }

  // Defense mechanism description per scope
  function defenseDesc(scope) {
    const active = scope === "project" ? localActive : globalActive
    const mode = scope === "project" ? localMode : globalMode
    const skillsArr = scope === "project" ? projSkills : gloSkills
    const hidden = skillsArr.filter(s => s.state === "hidden").length
    const exposed = skillsArr.filter(s => s.state === "exposed").length

    if (mode === "auto") {
      const parts = [GREEN + "hooks" + RESET]
      if (hidden > 0) parts.push(`${hidden} file-hidden`)
      if (exposed > 0) parts.push(GREEN + `${exposed} exposed (hooks)` + RESET)
      return parts.join(" · ")
    }
    if (active && mode === "manual") {
      const parts = [YELLOW + "hooks off (manual)" + RESET]
      if (hidden > 0) parts.push(GREEN + `${hidden} file-hidden` + RESET)
      if (exposed > 0) parts.push(`${exposed} exposed`)
      return parts.join(" · ")
    }
    // Not active in config
    if (hidden > 0) return GREEN + `${hidden} file-hidden` + RESET + " (no hooks)"
    return exposed + " exposed (no hooks)"
  }

  // Out-of-sync warnings
  const outOfSync = []
  if (projState === "mixed") outOfSync.push(`${projExposed} project skills exposed · ${projHidden} hidden — run /triage on or /triage off`)
  if (gloState === "mixed") outOfSync.push(`${gloExposed} global skills exposed · ${gloHidden} hidden — run /triage on or /triage off`)

  // Hooks-vs-files info (human output only, not in JSON)
  const hookNotes = []
  if (localMode === "auto" && projHidden < projExposed && projExposed > 0) {
    hookNotes.push(`project hooks ON · ${projExposed} skills still SKILL.md (not .disabled) — safe, hooks handle it`)
  }
  if (globalMode === "auto" && gloHidden < gloExposed && gloExposed > 0) {
    hookNotes.push(`global hooks ON · ${gloExposed} skills still SKILL.md (not .disabled) — safe, hooks handle it`)
  }

  if (isJson) {
    const json = {
      project: {
        state: projState,
        hidden: projHidden,
        exposed: projExposed,
        total: projHidden + projExposed,
        command: fs.existsSync(LOCAL_CMD_FILE) ? "found" : "not found",
        config: { active: localActive, mode: localMode },
      },
      global: {
        state: gloState,
        hidden: gloHidden,
        exposed: gloExposed,
        total: gloHidden + gloExposed,
        command: fs.existsSync(GLOBAL_CMD_FILE) ? "found" : "not found",
        config: { active: globalActive, mode: globalMode },
      },
      totals: { hidden: totalHidden, exposed: totalExposed, total: totalHidden + totalExposed },
      tokens_saved: netSavings > 0 ? netSavings : 0,
      out_of_sync: outOfSync.length > 0 ? outOfSync : null,
      skills: skills.map(s => ({ name: s.name, state: s.state, scope: s.scope, dir: s.label, duplicate: dupNames.has(s.name) })),
    }
    console.log(JSON.stringify(json, null, 2))
    return
  }

  const scopeSummary = []
  if (projSkills.length > 0) scopeSummary.push("local "  + stateColor(projState) + stateText(projState) + RESET)
  if (gloSkills.length  > 0) scopeSummary.push("global " + stateColor(gloState)  + stateText(gloState)  + RESET)
  if (scopeSummary.length === 0) scopeSummary.push(DIM + "no skills found" + RESET)

  console.log()
  console.log(BOLD + "● Triage Status" + RESET + DIM + " — " + scopeSummary.join(" · ") + RESET)
  console.log()

  // Project row
  const projLabel = projSkills.length > 0 ? stateColor(projState) + stateText(projState) + RESET : DIM + "—" + RESET
  const projDef = defenseDesc("project")
  const projCmd = fs.existsSync(LOCAL_CMD_FILE) ? GREEN + "✓" + RESET : DIM + "✗" + RESET
  console.log(`  Project:  ${projLabel}  │  ${projHidden + projExposed} skills  │  ${projDef}  │  ${projCmd}`)

  const gloLabel = gloSkills.length > 0 ? stateColor(gloState) + stateText(gloState) + RESET : DIM + "—" + RESET
  const gloDef = defenseDesc("global")
  const gloCmd = fs.existsSync(GLOBAL_CMD_FILE) ? GREEN + "✓" + RESET : DIM + "✗" + RESET
  console.log(`  Global:   ${gloLabel}  │  ${gloHidden + gloExposed} skills  │  ${gloDef}  │  ${gloCmd}`)
  console.log()

  // Warnings
  if (outOfSync.length > 0) {
    console.log(`  ${YELLOW}⚠ ${outOfSync.join(" ")}${RESET}`)
    console.log()
  }
  if (hookNotes.length > 0) {
    console.log(`  ${DIM}ℹ ${hookNotes.join("\n  ℹ ")}${RESET}`)
    console.log()
  }

  // Badge color: exposed = GREEN when hooks handle hiding, YELLOW when actually exposed
  function skillBadge(skill, scope) {
    const mode = scope === "project" ? localMode : globalMode
    const active = scope === "project" ? localActive : globalActive
    if (skill.state === "hidden") return GREEN + "[hidden]" + RESET
    // Exposed: green if hooks active (files are SKILL.md but hidden at LLM level)
    if (mode === "auto") return GREEN + "[exposed]" + RESET + DIM + " (hooks)" + RESET
    // Exposed: yellow if hooks off or manual (actually visible to LLM)
    return YELLOW + "[exposed]" + RESET
  }

  // Grouped skill lists
  if (projSkills.length > 0) {
    console.log(`  ${DIM}── Project skills ──────────────────────────────────────${RESET}`)
    projSkills.forEach(s => {
      const badge = skillBadge(s, "project")
      const dupTag = dupNames.has(s.name) ? YELLOW + "[dup]" + RESET : ""
      const pad = 30 - (dupTag ? 5 : 0)
      console.log(`  ${badge}  ${s.name.padEnd(pad)} ${dupTag} ${s.label}`)
    })
    console.log()
  }

  if (gloSkills.length > 0) {
    const maxShow = showAll ? gloSkills.length : 10
    console.log(`  ${DIM}── Global skills ───────────────────────────────────────${RESET}`)
    gloSkills.slice(0, maxShow).forEach(s => {
      const badge = skillBadge(s, "global")
      const dupTag = dupNames.has(s.name) ? YELLOW + "[dup]" + RESET : ""
      const pad = 30 - (dupTag ? 5 : 0)
      console.log(`  ${badge}  ${s.name.padEnd(pad)} ${dupTag} ${s.label}`)
    })
    if (!showAll && gloSkills.length > maxShow) {
      console.log(`  ${DIM}  ... and ${gloSkills.length - maxShow} more${RESET}`)
    }
    console.log()
  }

  const savedLabel = netSavings > 0 ? netSavings.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "0"
  const dupCount = dupNames.size
  if (dupCount > 0) {
    console.log(`  ${YELLOW}${dupCount} duplicate(s) found — run /triage dedupe to remove project-level dupes${RESET}`)
  }

  const triageActive = projState === "on" || gloState === "on"
  if (triageActive && netSavings > 0) {
    console.log(`  ${DIM}~${savedLabel} tokens saved from prompt${RESET}`)
  } else {
    const potentialLabel = hiddenTokens.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    console.log(`  ${DIM}Triage off — ~${potentialLabel} tokens could be saved${RESET}`)
  }

  if (skills.length === 0) {
    console.log()
    console.log("(no skills found)")
    console.log()
    console.log("Create a skill to get started:")
    console.log("  .opencode/skills/<name>/SKILL.md")
  }
  console.log()
}

// ── compare ───────────────────────────────────────────────

function estimateTokens(text) {
  return Math.ceil(text.length / 4)
}

// Extract a single frontmatter field from SKILL.md content.
// Supports single-line (`key: value`) and folded block (`key: >\n  ...`) formats.
function extractFrontmatterField(content, key) {
  const clean = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
  const fmEnd = clean.indexOf("\n---", 4)
  if (fmEnd === -1) return null
  const fm = clean.slice(4, fmEnd)
  // Folded block: key: >
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const multiRe = new RegExp(`^${safeKey}:\\s*>(.+?)(?=\\r?\\n\\S|$)`, "sm")
  const multiMatch = fm.match(multiRe)
  if (multiMatch) return multiMatch[1].replace(/\n\s*/g, " ").trim()
  // Single line: key: value
  const singleRe = new RegExp(`^${safeKey}:\\s*(.+)$`, "m")
  const singleMatch = fm.match(singleRe)
  return singleMatch ? singleMatch[1].trim() : null
}

// Build the <available_skills> XML block OpenCode injects into the native
// `skill` tool description — each skill contributes name + description only.
function buildNativeSkillXml(skills) {
  if (skills.length === 0) return ""
  const items = skills.map(s => {
    const name = s.nativeName || s.name
    const desc = s.nativeDesc || ""
    return `<skill>\n<name>${name}</name>\n<description>${desc}</description>\n</skill>`
  }).join("\n")
  return `<available_skills>\n${items}\n</available_skills>`
}

function readSkillContent(dirPath) {
  const disabled = path.join(dirPath, "SKILL.md.disabled")
  const active = path.join(dirPath, "SKILL.md")
  const file = fs.existsSync(disabled) ? disabled : fs.existsSync(active) ? active : null
  if (!file) return { content: "", filePath: null }
  try { return { content: fs.readFileSync(file, "utf-8"), filePath: file } } catch { return { content: "", filePath: null } }
}

function showCompare() {
  const hiddenEntries = []
  const exposedEntries = []
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
      const hasDisabled = fs.existsSync(path.join(dirPath, "SKILL.md.disabled"))
      const hasActive = fs.existsSync(path.join(dirPath, "SKILL.md"))
      const { content, filePath } = readSkillContent(dirPath)
      const entry = { name: d.name, content, filePath, tokens: estimateTokens(content) }
      if (hasDisabled) { seen.add(key); hiddenEntries.push(entry) }
      else if (hasActive) { seen.add(key); exposedEntries.push(entry) }
    }
  }

  const total = hiddenEntries.length + exposedEntries.length
  if (total === 0) {
    console.log()
    console.log("No skills found. Nothing to compare.")
    console.log()
    console.log("Create skills in .opencode/skills/, .agent/skills/, or .agents/skills/")
    console.log()
    return
  }

  const TOOL_DEF_TEXT =
    "Discover and route to the right specialized skill. " +
    "Call this before any non-trivial task. " +
    "Pass a brief description. Returns the best match or a list of candidates." +
    "Brief description of what you need help with, e.g. 'backup my database'"
  const toolDefTokens = estimateTokens(TOOL_DEF_TEXT)

  // Enrich entries with frontmatter name + description
  const allEntries = hiddenEntries.concat(exposedEntries)
  for (const entry of allEntries) {
    entry.nativeName = extractFrontmatterField(entry.content, "name") || entry.name
    entry.nativeDesc = extractFrontmatterField(entry.content, "description") || ""
    entry.nameDescTokens = estimateTokens(
      `<skill>\n<name>${entry.nativeName}</name>\n<description>${entry.nativeDesc}</description>\n</skill>`
    )
  }

  // WITHOUT triage (OpenCode native): native `skill` tool base text + <available_skills> XML
  // Only name + description appear in the prompt per skill — full bodies are loaded on-demand.
  const SKILL_TOOL_BASE =
    "Load a skill by name. Returns the full skill instructions.\n" +
    "Call this when you need to apply a specific technique or workflow."
  const skillToolBaseTokens = estimateTokens(SKILL_TOOL_BASE)
  const nativeXml = buildNativeSkillXml(allEntries)
  const nativeXmlTokens = estimateTokens(nativeXml)
  const withoutCost = skillToolBaseTokens + nativeXmlTokens

  // WITH triage: only the triage tool definition in the prompt — no XML list at all.
  // Skill body loading is on-demand in both modes, so it costs the same and is not counted.
  const withCost = toolDefTokens

  const saved = withoutCost - withCost
  const pct = withoutCost > 0 ? Math.round((saved / withoutCost) * 100) : 0

  // Top skills by name+desc size (what actually costs per-prompt)
  const sortedEntries = [...allEntries].sort((a, b) => b.nameDescTokens - a.nameDescTokens)
  const topSkills = sortedEntries.slice(0, 5)

  if (isJson) {
    const json = {
      skills: { hidden: hiddenEntries.length, exposed: exposedEntries.length, total },
      with_triage: { total: withCost, tool_def: toolDefTokens, skill_list_xml: 0 },
      without_triage: { total: withoutCost, tool_base: skillToolBaseTokens, skill_list_xml: nativeXmlTokens },
      saved: { tokens: saved, percent: pct },
      note: "Skill body loading costs the same on both sides (on-demand) and is not counted.",
      top_skills: topSkills.map(s => ({ name: s.nativeName, name_desc_tokens: s.nameDescTokens, body_tokens: s.tokens })),
    }
    console.log(JSON.stringify(json, null, 2))
    return
  }

  const pad = (s, w) => String(s).padEnd(w)

  console.log()
  console.log(BOLD + "Cost Comparison Global + Local" + RESET)
  console.log()
  console.log(`Skills: ${hiddenEntries.length} hidden (file) · ${exposedEntries.length} exposed (file) · ${total} total`)
  const config = collectConfigState()
  if (config.globalMode === "auto" || config.localMode === "auto") {
    console.log(`  ${DIM}ℹ hooks active — skills visible above are hidden at LLM level via tool.definition hook${RESET}`)
  }
  console.log()
  console.log(pad("", 24) + pad("WITH triage", 22) + pad("WITHOUT (native)", 22))
  console.log(pad("──────────────────", 24) + pad("────────────────────", 22) + pad("────────────────────", 22))
  console.log(pad("Prompt per call", 24) + pad(withCost + " tokens", 22) + pad(withoutCost + " tokens", 22))
  console.log(pad("  Tool definition", 24) + pad(toolDefTokens + " tokens", 22) + pad(skillToolBaseTokens + " tokens", 22))
  console.log(pad("  Skill list XML", 24) + pad("0 tokens", 22) + pad(nativeXmlTokens + " tokens", 22))
  console.log(DIM + pad("  (skill body*)", 24) + pad("same for both →", 22) + pad("loaded on-demand", 22) + RESET)
  console.log(pad("──────────────────", 24) + pad("────────────────────", 22) + pad("────────────────────", 22))
  console.log(BOLD + pad("Saved per call", 24) + pad(saved + " tokens (" + pct + "%)", 22) + RESET)
  console.log()
  console.log(DIM + "  * Skill body is fetched on-demand in both modes — equal cost, not counted above." + RESET)
  console.log()

  if (topSkills.length > 0) {
    console.log("Top skills by name+desc size (prompt cost per skill):")
    topSkills.forEach(s => {
      console.log(`  ${s.nativeName.padEnd(32)} ~${s.nameDescTokens} tokens  (full body: ~${s.tokens})`)
    })
    console.log()
  }

  console.log()
}

// ── version ───────────────────────────────────────────────

function showVersion() {
  if (isJson) {
    console.log(JSON.stringify({ version: CURRENT_VERSION }))
    return
  }
  console.log(`opencode-triage v${CURRENT_VERSION}`)
}

// ── semver ────────────────────────────────────────────────

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

function checkForUpdate() {
  https.get("https://registry.npmjs.org/opencode-triage/latest", { timeout: 3000 }, (res) => {
    let data = ""
    res.on("data", (chunk) => data += chunk)
    res.on("end", () => {
      try {
        const pkg = JSON.parse(data)
        const latest = pkg.version
        if (latest && semverGt(latest, CURRENT_VERSION)) {
          console.log()
          console.log(YELLOW + BOLD + "Update available:" + RESET + YELLOW + ` ${CURRENT_VERSION} → ${latest}` + RESET)
          console.log(YELLOW + `  npm install -g opencode-triage@latest` + RESET)
          console.log()
        }
      } catch {}
    })
  }).on("error", () => {})
}

// ── download-model ─────────────────────────────────────────

async function downloadModel() {
  const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
  if (!isQuiet) console.log(`Downloading embedding model: ${MODEL}`)
  if (!isQuiet) console.log("This may take 30-60s on first run (~118MB). Subsequent starts are instant.\n")

  // Stub broken sharp (native binary download blocked by corporate proxy)
  // transformers.js uses import('sharp') which throws unhandled if the package
  // is missing entirely; a stub avoids the import-time crash.
  const sharpDir = path.join(__dirname, "..", "node_modules", "sharp")
  const sharpIndex = path.join(sharpDir, "index.js")
  const sharpPkg = path.join(sharpDir, "package.json")
  const sharpLib = path.join(sharpDir, "lib")
  const sharpLibConstructor = path.join(sharpLib, "constructor.js")
  if (fs.existsSync(sharpDir) && !fs.existsSync(sharpLibConstructor)) {
    // sharp already installed but native binary failed — replace with stub
  }
  try { fs.mkdirSync(sharpLib, { recursive: true }) } catch {}
  try { fs.writeFileSync(sharpPkg, JSON.stringify({ name: "sharp", version: "0.0.0", main: "lib/constructor.js" })) } catch {}
  try { fs.writeFileSync(sharpLibConstructor, "module.exports = function() { throw new Error('sharp: image processing unavailable') }") } catch {}
  try { fs.writeFileSync(sharpIndex, "module.exports = require('./lib/constructor')") } catch {}

  try {
    const { pipeline } = require("@xenova/transformers")
    if (!isQuiet) console.log("Loading model...")
    const model = await pipeline("feature-extraction", MODEL)
    if (!isQuiet) console.log("Warming up...")
    const out = await model("test", { pooling: "mean", normalize: true })
    if (!isQuiet) console.log(`OK — embedding dimension: ${out.data.length}`)
    if (isJson) {
      console.log(JSON.stringify({ status: "ok", model: MODEL, dims: out.data.length }))
    } else {
      console.log(`\nModel ready. Semantic cross-lingual matching is now available.`)
    }
  } catch (e) {
    const msg = e.message ?? String(e)
    if (isJson) {
      console.log(JSON.stringify({ status: "error", error: msg, raw: e.stack ?? String(e) }))
    } else {
      console.error(`Failed to download model: ${msg}`)
      console.error()
      if (!isQuiet) {
        console.error("Raw error:")
        console.error(e.stack ?? String(e))
        console.error()
      }
      console.error("Possible causes:")
      console.error("  1. Network/proxy blocks HuggingFace CDN (cdn-lfs.hf.co)")
      console.error("  2. Corporate firewall blocks .onnx file downloads")
      console.error("  3. Missing dependencies — run: npm install @xenova/transformers onnxruntime-node")
      console.error()
      if (msg.includes("fetch failed")) {
        console.error("Manual download workaround:")
        console.error(`  1. On a different network, run: npx opencode-triage download-model`)
        console.error(`     This caches the model to ~/.cache/huggingface/`)
        console.error(`  2. Or manually download and place files in:`)
        console.error(`     ~/.cache/huggingface/hub/models--Xenova--paraphrase-multilingual-MiniLM-L12-v2/`)
        console.error()
      }
      console.error("Triage will fall back to keyword scoring without semantic matching.")
    }
    process.exit(1)
  }
}

// ── help ──────────────────────────────────────────────────

function showHelp() {
  if (isJson) {
    console.log(JSON.stringify({
      version: CURRENT_VERSION,
      commands: ["on", "off", "status", "dedupe", "compare", "download-model", "version", "help"],
      flags: ["--local", "--global", "--both", "--json", "--quiet", "--all"],
    }, null, 2))
    return
  }
  const cmdCol = 16
  const flagCol = 12
  const cmd = (name, desc) => "  " + BOLD + name + RESET + " ".repeat(cmdCol - name.length) + desc
  const flag = (name, desc) => "  " + BOLD + name + RESET + " ".repeat(flagCol - name.length) + desc
  console.log()
  console.log(BOLD + "opencode-triage v" + CURRENT_VERSION + RESET + " — Deterministic Skill Router")
  console.log()
  console.log(cmd("on", "Hide skills from OpenCode LLM via hooks (no file rename)"))
  console.log(cmd("off", "Expose all skills to the LLM again"))
  console.log(cmd("status", "Show current state, skill counts, and token savings"))
  console.log(cmd("dedupe", "Remove duplicate skills (interactive: choose local or global)"))
  console.log(cmd("compare", "Token/time cost comparison with vs without triage"))
  console.log(cmd("download-model", "Pre-download the ~118MB semantic embedding model"))
  console.log(cmd("version", "Show version and check for updates"))
  console.log(cmd("help", "Show this help"))
  console.log()
  console.log(DIM + "  SKILL.md files stay intact — other AI tools can still read them." + RESET)
  console.log(DIM + "  Hooks handle hiding at the LLM prompt level, no file rename needed." + RESET)
  console.log()
  console.log(BOLD + "Scope" + RESET + DIM + "  (override default: both scopes)" + RESET)
  console.log()
  console.log(flag("--local", "Target current project only"))
  console.log(flag("--global", "Target global skills only"))
  console.log(flag("--json", "Output as JSON (all commands)"))
  console.log(flag("--quiet", "Suppress non-error output (on/off)"))
  console.log(flag("--all", "Show full skill list without truncation (status)"))
  console.log(flag("--dry-run", "Preview changes without applying (dedupe)"))
  console.log()
  console.log("  " + BOLD + "Uninstall:" + RESET + " ".repeat(flagCol - "Uninstall:".length) + "npm uninstall -g opencode-triage")
  console.log("  " + BOLD + "Docs:" + RESET + " ".repeat(flagCol - "Docs:".length) + "https://github.com/cascharly/opencode-triage")
  console.log()
}

// ── Run ───────────────────────────────────────────────────

main()
checkForUpdate()
