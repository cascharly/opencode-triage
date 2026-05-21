/**
 * Single source of truth for skill directory locations.
 *
 * Both the CLI (bin/opencode-triage.cjs) and the plugin
 * (src/discovery.ts) consume this module — one place to update
 * when adding or changing skill scan directories.
 */

const path = require("path")

const DIR_PATTERNS = [
  { subpath: [".agent", "skills"], scope: "project", label: ".agent/" },
  { subpath: [".agents", "skills"], scope: "project", label: ".agents/" },
  { subpath: [".claude", "skills"], scope: "project", label: ".claude/" },
  { subpath: [".opencode", "skills"], scope: "project", label: ".opencode/" },
  { subpath: [".agents", "skills"], scope: "global", label: "~/.agents/" },
  { subpath: [".claude", "skills"], scope: "global", label: "~/.claude/" },
  { subpath: [".config", "opencode", "skills"], scope: "global", label: "~/.config/opencode/" },
  { subpath: [".gemini", "config", "skills"], scope: "global", label: "~/.gemini/config/" },
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
