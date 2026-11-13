#!/usr/bin/env node
/*
 * opencode-triage CLI
 * ==================
 * Manage the opencode-triage skill router plugin.
 *
 * Usage: /triage on | off | status | compare | version | help
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
const {
  stripJsoncComments,
  levenshtein,
  extractFrontmatterField,
  semverGt
} = require("./shared.cjs")
const helpers = require("./helpers.cjs")
const { setTriageState } = require("./plugin-config.cjs")
const showStatus = require("./commands/status.cjs")
const showCompare = require("./commands/compare.cjs")
const dedupeSkills = require("./commands/dedupe.cjs")

const CMD = process.argv[2] || "help"
const FLAGS = process.argv.slice(3)

const isJson = FLAGS.includes("--json")
const isQuiet = FLAGS.includes("--quiet")
const isDryRun = FLAGS.includes("--dry-run")
const showAll = FLAGS.includes("--all")

let CURRENT_VERSION
try { CURRENT_VERSION = require(path.join(__dirname, "..", "package.json")).version }
catch { CURRENT_VERSION = "0.0.0" }

const WORKTREE = helpers.findProjectRoot(process.cwd())
const HOMEDIR = os.homedir()

const CMD_TEMPLATE = `---
description: Toggle, inspect, and benchmark the triage skill router
---
Run npx -y opencode-triage $ARGUMENTS and show the output verbatim.
If output contains "Restart opencode", tell the user to restart.
`
const LOCAL_CFG_PATH = [
  path.join(WORKTREE, ".opencode", "opencode.json"),
  path.join(WORKTREE, ".opencode", "opencode.jsonc"),
  path.join(WORKTREE, "opencode.json"),
  path.join(WORKTREE, "opencode.jsonc"),
].find(file => fs.existsSync(file)) || path.join(WORKTREE, ".opencode", "opencode.json")
const LOCAL_CMD_DIR   = path.join(WORKTREE, ".opencode", "commands")
const LOCAL_CMD_FILE  = path.join(LOCAL_CMD_DIR, "triage.md")
const GLOBAL_CFG_PATH = (() => {
  const jsonPath = path.join(HOMEDIR, ".config", "opencode", "opencode.json")
  const jsoncPath = path.join(HOMEDIR, ".config", "opencode", "opencode.jsonc")
  if (fs.existsSync(jsonPath)) return jsonPath
  if (fs.existsSync(jsoncPath)) return jsoncPath
  return jsoncPath
})()
const GLOBAL_CMD_DIR  = path.join(HOMEDIR, ".config", "opencode", "commands")
const GLOBAL_CMD_FILE = path.join(GLOBAL_CMD_DIR, "triage.md")
const WINDOWS_APPDATA_CFG_PATH = (() => {
  if (process.platform !== "win32" || !process.env.APPDATA) return null
  const dir = path.join(process.env.APPDATA, "opencode")
  const jsonPath = path.join(dir, "opencode.json")
  const jsoncPath = path.join(dir, "opencode.jsonc")
  if (fs.existsSync(jsonPath)) return jsonPath
  if (fs.existsSync(jsoncPath)) return jsoncPath
  return null
})()


// Single source of truth: shared with src/discovery.ts — both stay in sync
const { buildLocations } = require("./skill-dirs.cjs")
const SKILL_DIRS = buildLocations(WORKTREE, HOMEDIR)

const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

const colors = { YELLOW, GREEN, RED, CYAN, RESET, BOLD, DIM }

// ── Main Router ───────────────────────────────────────────

function main() {
  const scopeFlag = FLAGS.includes("--both") ? "both"
    : FLAGS.includes("--local") ? "local"
    : FLAGS.includes("--global") ? "global"
    : null
  const toggleScope = scopeFlag || "both"

  const ctx = {
    SKILL_DIRS, LOCAL_CMD_FILE, GLOBAL_CMD_FILE, LOCAL_CFG_PATH, GLOBAL_CFG_PATH, WINDOWS_APPDATA_CFG_PATH,
    isJson, showAll, isDryRun, colors,
  }

  switch (CMD) {
    case "on":
    case "enable":
      return toggle(true, toggleScope)
    case "off":
    case "disable":
      return toggle(false, toggleScope)
    case "status":
      return showStatus(ctx)
    case "dedupe":
    case "deduplicate":
      return dedupeSkills(ctx)
    case "mode":
      const modeArg = FLAGS.find(f => f === "auto" || f === "manual")
      return setMode(modeArg || "auto", toggleScope)
    case "compare":
      return showCompare(ctx)
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
      const suggestion = helpers.suggestCommand(CMD)
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

// ── toggle ────────────────────────────────────────────────

function toggle(enable, scope) {
  const scopes = scope === "both" ? ["global", "local"] : [scope]
  for (const s of scopes) {
    const cfgPath = s === "global" ? GLOBAL_CFG_PATH : LOCAL_CFG_PATH
    writeTriageState(cfgPath, enable)
  }

  // Restore .disabled files back to .md — hooks handle hiding at LLM level.
  // Run on both on and off: stale .disabled from old versions should be cleaned up.
  const renamed = helpers.renameSkillFiles(SKILL_DIRS, ".md.disabled", ".md", isDryRun)
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
  let config
  try {
    config = JSON.parse(stripJsoncComments(fs.readFileSync(configPath, "utf-8")))
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read valid config: ${configPath}`)
    if (!enable) return
    config = { "$schema": "https://opencode.ai/config.json" }
  }
  if (!setTriageState(config, enable)) return
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
  if (!isQuiet) console.log(`Config: autoHide=${enable} -> ${configPath}`)
}

function updateLocalConfig(enable) {
  let config = {}
  let hadPlugin = false
  try {
    const raw = fs.readFileSync(LOCAL_CFG_PATH, "utf-8")
    config = JSON.parse(stripJsoncComments(raw))
    hadPlugin = (config.plugin || []).some(helpers.isTriageEntry)
  } catch {
    config = { "$schema": "https://opencode.ai/config.json" }
  }
  config.plugin = config.plugin || []
  const idx = helpers.findTriageIndex(config.plugin)
  if (enable && !hadPlugin) {
    config.plugin.push(helpers.PLUGIN_NAME)
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
    const config = { "$schema": "https://opencode.ai/config.json", plugin: [helpers.PLUGIN_NAME] }
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
  const hadPlugin = config.plugin.some(helpers.isTriageEntry)
  const idx = helpers.findTriageIndex(config.plugin)
  if (enable) {
    if (!hadPlugin) {
      config.plugin.push(helpers.PLUGIN_NAME)
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
  let config
  try { config = JSON.parse(stripJsoncComments(fs.readFileSync(configPath, "utf-8"))) }
  catch (error) { if (error.code === "ENOENT") return false; throw error }
  if (!setTriageState(config, mode === "auto")) return false
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

// showStatus, showCompare, dedupeSkills, calcHiddenSkillTokens, estimateTokens,
// buildNativeSkillXml, readSkillContent, findDuplicateNames moved to bin/commands/

// ── version ───────────────────────────────────────────────

function showVersion() {
  if (isJson) {
    console.log(JSON.stringify({ version: CURRENT_VERSION }))
    return
  }
  console.log(`opencode-triage v${CURRENT_VERSION}`)
}

// semverGt required from shared.cjs

function checkForUpdate() {
  if (isJson || isQuiet) return
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

// ── help ──────────────────────────────────────────────────

async function downloadModel() {
  // Keep in sync with EMBEDDING_MODEL and SECOND_PASS_MODEL in src/config.ts.
  const MODELS = [
    { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", size: "~118MB", role: "first pass" },
    { id: "Xenova/paraphrase-multilingual-mpnet-base-v2", size: "~280MB", role: "second pass" },
  ]
  const selected = FLAGS.includes("--no-second-pass") ? MODELS.slice(0, 1) : MODELS
  const MODEL = selected.map(m => m.id).join(", ")
  if (!isQuiet && !isJson) console.log(`Downloading embedding models: ${MODEL}`)
  if (!isQuiet && !isJson) console.log(`This may take a few minutes on first run (${selected.map(m => `${m.role} ${m.size}`).join(", ")}). Subsequent starts are instant.\n`)

  try {
    const { pipeline } = await import("@huggingface/transformers")
    const dims = {}
    for (const { id, role } of selected) {
      if (!isQuiet && !isJson) console.log(`Loading ${role} model ${id}...`)
      const model = await pipeline("feature-extraction", id, { cache_dir: path.join(HOMEDIR, ".cache", "opencode-triage", "models"), dtype: "q8" })
      const out = await model("test", { pooling: "mean", normalize: true })
      dims[id] = out.data.length
      await model.dispose?.()
      if (!isQuiet && !isJson) console.log(`OK — embedding dimension: ${out.data.length}`)
    }
    if (isJson) {
      console.log(JSON.stringify({ status: "ok", models: selected.map(m => m.id), dims }))
    } else {
      console.log(`\nModels ready. Restart OpenCode to use semantic cross-lingual matching${selected.length > 1 ? " with the second pass" : ""}.`)
    }
  } catch (e) {
    const msg = e.message ?? String(e)
    if (isJson) {
      console.log(JSON.stringify({ status: "error", error: msg, raw: e.stack ?? String(e) }))
    } else {
      console.error(`Failed to download model: ${msg}`)
      console.error()
      if (!isQuiet && !isJson) {
        console.error("Raw error:")
        console.error(e.stack ?? String(e))
        console.error()
      }
      console.error("Possible causes:")
      console.error("  1. Network/proxy blocks HuggingFace CDN (cdn-lfs.hf.co)")
      console.error("  2. Corporate firewall blocks .onnx file downloads")
      console.error("  3. Missing dependencies — run: npm install @huggingface/transformers")
      console.error()
      if (msg.includes("fetch failed")) {
        console.error("Manual download workaround:")
        console.error(`  1. On a different network, run: npx opencode-triage download-model`)
        console.error(`     This caches the model to ~/.cache/opencode-triage/models/`)
        console.error(`  2. Or manually download and place files in:`)
        console.error(`     ~/.cache/opencode-triage/models/Xenova/<model-name>/`)
        console.error()
      }
      console.error("Triage falls back to the first-pass model alone, or to keyword scoring without any model.")
    }
    process.exit(1)
  }
}


function showHelp() {
  if (isJson) {
    console.log(JSON.stringify({
      version: CURRENT_VERSION,
      commands: ["on", "off", "mode", "status", "dedupe", "compare", "download-model", "version", "help"],
      flags: ["--local", "--global", "--both", "--json", "--quiet", "--all", "--dry-run", "--no-second-pass"],
    }, null, 2))
    return
  }
  const cmdCol = 16
  const flagCol = 18
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
  console.log(cmd("version", "Show version and check for updates"))
  console.log(cmd("help", "Show this help"))
  console.log()
  console.log(DIM + "  SKILL.md files stay intact — other AI tools can still read them." + RESET)
  console.log(DIM + "  Hooks handle hiding at the LLM prompt level, no file rename needed." + RESET)
  console.log()
  console.log(cmd("download-model", "Download the optional local multilingual embedding models"))
  console.log()
  console.log(BOLD + "Scope" + RESET + DIM + "  (override default: both scopes)" + RESET)
  console.log()
  console.log(flag("--local", "Target current project only"))
  console.log(flag("--global", "Target global skills only"))
  console.log(flag("--json", "Output as JSON (all commands)"))
  console.log(flag("--quiet", "Suppress non-error output (on/off)"))
  console.log(flag("--all", "Show full skill list without truncation (status)"))
  console.log(flag("--dry-run", "Preview changes without applying (dedupe)"))
  console.log(flag("--no-second-pass", "Download only the first-pass model (download-model)"))
  console.log()
  console.log("  " + BOLD + "Uninstall:" + RESET + " ".repeat(flagCol - "Uninstall:".length) + "npm uninstall -g opencode-triage")
  console.log("  " + BOLD + "Docs:" + RESET + " ".repeat(flagCol - "Docs:".length) + "https://github.com/cascharly/opencode-triage")
  console.log()
}

// ── Run ───────────────────────────────────────────────────

Promise.resolve(main()).catch(error => { console.error(error.message); process.exitCode = 1 })
checkForUpdate()
