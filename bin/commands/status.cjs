/**
 * opencode-triage status command.
 * Shows current triage state, skill counts, token savings, and per-skill status.
 */

const fs = require("fs")
const path = require("path")
const { collectWindowsConfigDiagnostics } = require("../config-diagnostics.cjs")
const { stripJsoncComments, extractFrontmatterField } = require("../shared.cjs")
const {
  PLUGIN_NAME, findTriageIndex, collectSkills, collectConfigState,
  findDuplicateNames, calcHiddenSkillTokens, estimateTokens, buildNativeSkillXml,
} = require("../helpers.cjs")

module.exports = function showStatus(ctx) {
  const {
    SKILL_DIRS, LOCAL_CMD_FILE, GLOBAL_CMD_FILE, LOCAL_CFG_PATH, GLOBAL_CFG_PATH, WINDOWS_APPDATA_CFG_PATH,
    isJson, showAll, colors,
  } = ctx
  const { YELLOW, GREEN, RED, CYAN, RESET, BOLD, DIM } = colors

  const { localActive, globalActive, localMode, globalMode } = collectConfigState(LOCAL_CFG_PATH, GLOBAL_CFG_PATH)
  const skills = collectSkills(SKILL_DIRS)
  const dupNames = findDuplicateNames(skills)

  const projSkills = skills.filter(s => s.scope === "project")
  const gloSkills = skills.filter(s => s.scope === "global")
  const projHidden = projSkills.filter(s => s.state === "hidden").length
  const projExposed = projSkills.filter(s => s.state === "exposed").length
  const gloHidden = gloSkills.filter(s => s.state === "hidden").length
  const gloExposed = gloSkills.filter(s => s.state === "exposed").length
  const totalHidden = projHidden + gloHidden
  const totalExposed = projExposed + gloExposed
  const hiddenTokens = calcHiddenSkillTokens(SKILL_DIRS)
  const windowsConfig = collectWindowsConfigDiagnostics(GLOBAL_CFG_PATH, WINDOWS_APPDATA_CFG_PATH)

  const TOOL_DEF_TEXT =
    "Discover and route to the right specialized skill. " +
    "Call this before any non-trivial task. " +
    "Pass a brief description. Returns the best match or a list of candidates." +
    "Brief description of what you need help with, e.g. 'backup my database'"
  const toolDefTokens = estimateTokens(TOOL_DEF_TEXT)
  const netSavings = hiddenTokens - toolDefTokens

  function effectiveState(scope) {
    const active = scope === "project" ? localActive : globalActive
    const mode = scope === "project" ? localMode : globalMode
    const skillsArr = scope === "project" ? projSkills : gloSkills
    const hidden = skillsArr.filter(s => s.state === "hidden").length
    const exposed = skillsArr.filter(s => s.state === "exposed").length
    if (skillsArr.length === 0) return "none"
    if (mode === "auto") return "on"
    if (hidden > 0 && exposed === 0) return "on"
    if (hidden === 0) return "off"
    return "mixed"
  }

  const projState = effectiveState("project")
  const gloState = effectiveState("global")

  function effectiveCounts(scope) {
    const mode = scope === "project" ? localMode : globalMode
    const skillsArr = scope === "project" ? projSkills : gloSkills
    const fileHidden = skillsArr.filter(s => s.state === "hidden").length
    const fileExposed = skillsArr.filter(s => s.state === "exposed").length
    const hooksActive = mode === "auto"
    const promptHidden = hooksActive ? fileHidden + fileExposed : fileHidden
    const promptExposed = hooksActive ? 0 : fileExposed
    const hasSkills = skillsArr.length > 0
    return {
      hooksActive,
      fileHidden,
      fileExposed,
      promptHidden,
      promptExposed,
      effectiveHidden: promptHidden,
      effectiveExposed: promptExposed,
      hideMode: hasSkills && hooksActive ? "hooks" : hasSkills && fileHidden > 0 && fileExposed === 0 ? "file" : "none",
    }
  }

  const projEffective = effectiveCounts("project")
  const gloEffective = effectiveCounts("global")
  const totalEffective = {
    hooksActive: projEffective.hooksActive || gloEffective.hooksActive,
    fileHidden: projEffective.fileHidden + gloEffective.fileHidden,
    fileExposed: projEffective.fileExposed + gloEffective.fileExposed,
    promptHidden: projEffective.promptHidden + gloEffective.promptHidden,
    promptExposed: projEffective.promptExposed + gloEffective.promptExposed,
    effectiveHidden: projEffective.effectiveHidden + gloEffective.effectiveHidden,
    effectiveExposed: projEffective.effectiveExposed + gloEffective.effectiveExposed,
    hideMode: (projEffective.hideMode === "hooks" || gloEffective.hideMode === "hooks") ? "hooks" : totalHidden > 0 && totalExposed === 0 ? "file" : "none",
  }

  function stateColor(state) { return state === "on" ? GREEN : YELLOW }
  function stateText(state) {
    return state === "on" ? "ON" : state === "off" ? "OFF" : state === "mixed" ? "MIXED" : "—"
  }

  function defenseDesc(scope) {
    const active = scope === "project" ? localActive : globalActive
    const mode = scope === "project" ? localMode : globalMode
    const skillsArr = scope === "project" ? projSkills : gloSkills
    const hidden = skillsArr.filter(s => s.state === "hidden").length
    const exposed = skillsArr.filter(s => s.state === "exposed").length

    if (skillsArr.length === 0) return "file: none · prompt: none"
    if (mode === "auto") {
      const fileState = hidden > 0 && exposed > 0 ? `mixed (${hidden} hidden, ${exposed} exposed)` : hidden > 0 ? "hidden" : "exposed"
      const parts = [`file: ${fileState}`, GREEN + "prompt: hidden by hooks" + RESET]
      return parts.join(" · ")
    }
    if (active && mode === "manual") {
      const fileState = hidden > 0 && exposed > 0 ? `mixed (${hidden} hidden, ${exposed} exposed)` : hidden > 0 ? "hidden" : "exposed"
      const promptState = exposed > 0 ? YELLOW + "prompt: exposed" + RESET : GREEN + "prompt: hidden by file rename" + RESET
      const parts = [YELLOW + "hooks off (manual)" + RESET, `file: ${fileState}`, promptState]
      return parts.join(" · ")
    }
    // Not active in config
    if (hidden > 0) return `file: hidden · ${GREEN}prompt: hidden by file rename${RESET} · no hooks`
    return `file: exposed · ${YELLOW}prompt: exposed${RESET} · no hooks`
  }

  const outOfSync = []
  if (projState === "mixed") outOfSync.push(`${projExposed} project skills exposed · ${projHidden} hidden — run /triage on or /triage off`)
  if (gloState === "mixed") outOfSync.push(`${gloExposed} global skills exposed · ${gloHidden} hidden — run /triage on or /triage off`)

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
        ...projEffective,
        command: fs.existsSync(LOCAL_CMD_FILE) ? "found" : "not found",
        config: { active: localActive, mode: localMode },
      },
      global: {
        state: gloState,
        hidden: gloHidden,
        exposed: gloExposed,
        total: gloHidden + gloExposed,
        ...gloEffective,
        command: fs.existsSync(GLOBAL_CMD_FILE) ? "found" : "not found",
        config: { active: globalActive, mode: globalMode },
      },
      totals: { hidden: totalHidden, exposed: totalExposed, total: totalHidden + totalExposed, ...totalEffective },
      windows_config: windowsConfig,
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

  const projLabel = projSkills.length > 0 ? stateColor(projState) + stateText(projState) + RESET : DIM + "—" + RESET
  const projDef = defenseDesc("project")
  const projCmd = fs.existsSync(LOCAL_CMD_FILE) ? GREEN + "✓" + RESET : DIM + "✗" + RESET
  console.log(`  Project:  ${projLabel}  │  ${projHidden + projExposed} skills  │  ${projDef}  │  command: ${projCmd}`)

  const gloLabel = gloSkills.length > 0 ? stateColor(gloState) + stateText(gloState) + RESET : DIM + "—" + RESET
  const gloDef = defenseDesc("global")
  const gloCmd = fs.existsSync(GLOBAL_CMD_FILE) ? GREEN + "✓" + RESET : DIM + "✗" + RESET
  console.log(`  Global:   ${gloLabel}  │  ${gloHidden + gloExposed} skills  │  ${gloDef}  │  command: ${gloCmd}`)
  console.log()

  if (outOfSync.length > 0) {
    console.log(`  ${YELLOW}⚠ ${outOfSync.join(" ")}${RESET}`)
    console.log()
  }
  if (hookNotes.length > 0) {
    console.log(`  ${DIM}ℹ ${hookNotes.join("\n  ℹ ")}${RESET}`)
    console.log()
  }

  if (windowsConfig) {
    const differText = windowsConfig.sameHash
      ? "config files match"
      : `config files differ${windowsConfig.differingSections.length > 0 ? ": " + windowsConfig.differingSections.join(", ") : ""}`
    const userStatus = windowsConfig.userConfig.pluginPresent ? GREEN + "plugin present" + RESET : YELLOW + "plugin missing" + RESET
    const appDataStatus = windowsConfig.appDataConfig.pluginPresent ? GREEN + "plugin present" + RESET : YELLOW + "plugin missing" + RESET
    console.log(`  ${BOLD}Windows config check:${RESET}`)
    console.log(`    ~/.config/opencode/${path.basename(windowsConfig.userConfig.path)}: ${userStatus} · sha256:${windowsConfig.userConfig.hash || "unreadable"}`)
    console.log(`    %APPDATA%/opencode/${path.basename(windowsConfig.appDataConfig.path)}: ${appDataStatus} · sha256:${windowsConfig.appDataConfig.hash || "unreadable"}`)
    console.log(`    ${differText}`)
    console.log()
  }

  function skillBadge(skill, scope) {
    const mode = scope === "project" ? localMode : globalMode
    const active = scope === "project" ? localActive : globalActive
    if (skill.state === "hidden") return GREEN + "[hidden]" + RESET
    if (mode === "auto") return GREEN + "[exposed]" + RESET + DIM + " (hooks)" + RESET
    return YELLOW + "[exposed]" + RESET
  }

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
