const fs = require("fs")
const path = require("path")
const os = require("os")

const CMD = `---
description: Toggle, inspect, and benchmark the triage skill router
---
Run npx -y opencode-triage $ARGUMENTS and show the output verbatim.
If output contains "Restart opencode", tell the user to restart.
`

const isGlobal = process.env.npm_config_global === "true"

if (isGlobal) {
  const dir = path.join(os.homedir(), ".config", "opencode", "commands")
  const file = path.join(dir, "triage.md")
  // Always write (fixes edge case #12: previously only created if missing,
  // so template updates in new versions were never applied to existing installs)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, CMD, "utf-8")
  console.log()
  console.log("  opencode-triage installed globally")
  console.log()
  console.log("  1. Restart OpenCode")
  console.log("  2. Type /triage on to activate")
  console.log("  3. Hooks hide the skill catalog; SKILL.md files stay intact.")
  console.log("     Optional multilingual matching: npx opencode-triage download-model")
  console.log()
} else {
  const projectRoot = process.env.INIT_CWD || process.cwd()
  const dir = path.join(projectRoot, ".opencode", "commands")
  const file = path.join(dir, "triage.md")
  // Always write (fixes edge case #12: see global section above)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, CMD, "utf-8")
  console.log()
  console.log("  opencode-triage installed locally")
  console.log()
  console.log("  1. Restart OpenCode")
  console.log("  2. Type /triage on --local to activate")
  console.log("  3. Hooks hide the skill catalog; SKILL.md files stay intact.")
  console.log("     Optional multilingual matching: npx opencode-triage download-model")
  console.log()
}
