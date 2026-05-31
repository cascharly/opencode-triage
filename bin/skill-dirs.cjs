/**
 * Single source of truth for skill directory locations.
 *
 * Both the CLI (bin/opencode-triage.cjs) and the plugin
 * (src/discovery.ts) consume this module — one place to update
 * when adding or changing skill scan directories.
 */

const path = require("path")

const DIR_PATTERNS = [
  { subpath: [".agent", "skills"], scope: "project", label: ".agent/skills/" },
  { subpath: [".agents", "skills"], scope: "project", label: ".agents/skills/" },
  { subpath: [".claude", "skills"], scope: "project", label: ".claude/skills/" },
  { subpath: [".opencode", "skills"], scope: "project", label: ".opencode/skills/" },
  { subpath: [".agents", "skills"], scope: "global", label: "~/.agents/skills/" },
  { subpath: [".claude", "skills"], scope: "global", label: "~/.claude/skills/" },
  { subpath: [".config", "opencode", "skills"], scope: "global", label: "~/.config/opencode/skills/" },
  { subpath: [".gemini", "config", "skills"], scope: "global", label: "~/.gemini/config/skills/" },
]

/**
 * Builds full location objects from a project root and home directory.
 *
 * @param {string} root - Project worktree root
 * @param {string} home - User home directory (os.homedir())
 * @returns {{ base: string, scope: string, label: string }[]}
 */
function buildLocations(root, home) {
  return DIR_PATTERNS.map(({ subpath, scope, label }) => ({
    base: path.resolve(scope === "project" ? root : home, ...subpath),
    scope,
    label,
  }))
}

module.exports = { DIR_PATTERNS, buildLocations }
