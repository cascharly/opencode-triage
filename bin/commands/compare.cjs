/**
 * opencode-triage compare command.
 * Token/time cost comparison with vs without triage.
 */

const fs = require("fs")
const path = require("path")
const { extractFrontmatterField } = require("../shared.cjs")
const {
  collectConfigState, estimateTokens, buildNativeSkillXml, readSkillContent,
} = require("../helpers.cjs")

module.exports = function showCompare(ctx) {
  const { SKILL_DIRS, isJson, colors, LOCAL_CFG_PATH, GLOBAL_CFG_PATH } = ctx
  const { YELLOW, GREEN, RESET, BOLD, DIM } = colors

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

  const allEntries = hiddenEntries.concat(exposedEntries)
  for (const entry of allEntries) {
    entry.nativeName = extractFrontmatterField(entry.content, "name") || entry.name
    entry.nativeDesc = extractFrontmatterField(entry.content, "description") || ""
    entry.nameDescTokens = estimateTokens(
      `<skill>\n<name>${entry.nativeName}</name>\n<description>${entry.nativeDesc}</description>\n</skill>`
    )
  }

  const SKILL_TOOL_BASE =
    "Load a skill by name. Returns the full skill instructions.\n" +
    "Call this when you need to apply a specific technique or workflow."
  const skillToolBaseTokens = estimateTokens(SKILL_TOOL_BASE)
  const nativeXml = buildNativeSkillXml(allEntries)
  const nativeXmlTokens = estimateTokens(nativeXml)
  const withoutCost = skillToolBaseTokens + nativeXmlTokens

  const withCost = toolDefTokens

  const saved = withoutCost - withCost
  const pct = withoutCost > 0 ? Math.round((saved / withoutCost) * 100) : 0

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
  const config = collectConfigState(LOCAL_CFG_PATH, GLOBAL_CFG_PATH)
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
