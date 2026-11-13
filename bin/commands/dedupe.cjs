/**
 * opencode-triage dedupe command.
 * Interactive duplicate skill removal.
 */

const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { collectSkills, findDuplicateNames, safeRenameSync } = require("../helpers.cjs")

module.exports = function dedupeSkills(ctx) {
  const { SKILL_DIRS, isDryRun, colors } = ctx
  const { YELLOW, GREEN, RED, RESET, BOLD, DIM } = colors

  const skills = collectSkills(SKILL_DIRS)
  const dupNames = findDuplicateNames(skills)

  if (dupNames.size === 0) {
    console.log()
    console.log("No duplicate skills found. Nothing to deduplicate.")
    console.log()
    return
  }

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
