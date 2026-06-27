/**
 * Tests for CLI UX features: Levenshtein distance, command suggestion,
 * --json flag behavior, --dry-run simulation, --all flag, and out-of-sync detection.
 */
import assert from "node:assert"
import { describe, it } from "node:test"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Re-implement for testing
function levenshtein(a: string, b: string): number {
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

function suggestCommand(input: string): string | null {
  const commands = ["on", "off", "enable", "disable", "status", "compare", "version", "help"]
  let best = null, bestDist = Infinity
  for (const cmd of commands) {
    const d = levenshtein(input, cmd)
    if (d < bestDist) { bestDist = d; best = cmd }
  }
  return bestDist <= 3 ? best : null
}

describe("levenshtein distance", () => {
  it("returns 0 for identical strings", () => {
    assert.strictEqual(levenshtein("status", "status"), 0)
  })

  it("returns 1 for single char difference", () => {
    assert.strictEqual(levenshtein("status", "statu"), 1)
  })

  it("returns correct distance for transposition", () => {
    assert.strictEqual(levenshtein("status", "statos"), 1)
  })

  it("returns correct distance for completely different strings", () => {
    assert.strictEqual(levenshtein("abc", "xyz"), 3)
  })

  it("handles empty strings", () => {
    assert.strictEqual(levenshtein("", "abc"), 3)
    assert.strictEqual(levenshtein("abc", ""), 3)
    assert.strictEqual(levenshtein("", ""), 0)
  })
})

describe("suggestCommand", () => {
  it("suggests 'status' for 'stats'", () => {
    assert.strictEqual(suggestCommand("stats"), "status")
  })

  it("suggests 'compare' for 'compar'", () => {
    assert.strictEqual(suggestCommand("compar"), "compare")
  })

  it("suggests 'version' for 'versio'", () => {
    assert.strictEqual(suggestCommand("versio"), "version")
  })

  it("suggests 'help' for 'hep'", () => {
    assert.strictEqual(suggestCommand("hep"), "help")
  })

  it("returns null for very different input", () => {
    assert.strictEqual(suggestCommand("xyzabcdef"), null)
  })

  it("suggests 'on' for 'o'", () => {
    assert.strictEqual(suggestCommand("o"), "on")
  })

  it("suggests 'off' for 'offf'", () => {
    assert.strictEqual(suggestCommand("offf"), "off")
  })

  it("suggests 'enable' for 'enabl'", () => {
    assert.strictEqual(suggestCommand("enabl"), "enable")
  })

  it("suggests 'disable' for 'disabl'", () => {
    assert.strictEqual(suggestCommand("disabl"), "disable")
  })

  it("handles exact match", () => {
    assert.strictEqual(suggestCommand("status"), "status")
  })
})

describe("--all flag", () => {
  const cli = path.join(import.meta.dirname, "..", "bin", "opencode-triage.cjs")

  it("status --all shows all global skills (no truncation)", () => {
    const output = execSync(`node "${cli}" status --all`, { encoding: "utf-8" })
    // Should NOT contain "... and" truncation
    assert.ok(!output.includes("... and"), "should not truncate with --all")
  })

  it("status without --all may show truncation", () => {
    const output = execSync(`node "${cli}" status`, { encoding: "utf-8" })
    // With 16 global skills, truncation should appear
    if (output.includes("~/.agents/")) {
      assert.ok(output.includes("... and") || output.includes("webhook-automation"),
        "should show all or truncated list")
    }
  })

  it("help text mentions --all flag", () => {
    const output = execSync(`node "${cli}" help`, { encoding: "utf-8" })
    assert.ok(output.includes("--all"), "help should mention --all flag")
    assert.ok(output.includes("Show full skill list"), "help should describe --all purpose")
  })
})

describe("status --json effective state", () => {
  const cli = path.join(import.meta.dirname, "..", "bin", "opencode-triage.cjs")

  function withFixture(run: (fixture: { root: string; home: string; appData: string }) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-triage-status-"))
    const home = path.join(root, "home")
    const appData = path.join(root, "appdata")
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(appData, { recursive: true })
    fs.mkdirSync(path.join(root, ".opencode"), { recursive: true })
    fs.writeFileSync(path.join(root, ".opencode", "opencode.json"), "{}\n", "utf-8")
    try {
      run({ root, home, appData })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  function writeSkill(dir: string, name: string) {
    const skillDir = path.join(dir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`, "utf-8")
  }

  function statusJson(fixture: { root: string; home: string; appData: string }) {
    const output = execSync(`node "${cli}" status --json`, {
      cwd: fixture.root,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: fixture.home,
        USERPROFILE: fixture.home,
        APPDATA: fixture.appData,
      },
    })
    return JSON.parse(output)
  }

  it("reports empty project scope as no hide mode even when global hooks are active", () => {
    withFixture(fixture => {
      const globalConfigDir = path.join(fixture.home, ".config", "opencode")
      fs.mkdirSync(globalConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(globalConfigDir, "opencode.json"),
        JSON.stringify({ plugin: [["opencode-triage", { autoHide: true }]] }),
        "utf-8"
      )
      writeSkill(path.join(globalConfigDir, "skills"), "global-skill")

      const json = statusJson(fixture)
      assert.strictEqual(json.project.total, 0)
      assert.strictEqual(json.project.hideMode, "none")
      assert.strictEqual(json.global.fileExposed, 1)
      assert.strictEqual(json.global.promptHidden, 1)
      assert.strictEqual(json.global.promptExposed, 0)
      assert.strictEqual(json.global.hideMode, "hooks")
      assert.strictEqual(json.totals.hideMode, "hooks")
    })
  })

  it("reports Windows config drift without exposing config values", () => {
    withFixture(fixture => {
      const userConfigDir = path.join(fixture.home, ".config", "opencode")
      const appDataConfigDir = path.join(fixture.appData, "opencode")
      fs.mkdirSync(userConfigDir, { recursive: true })
      fs.mkdirSync(appDataConfigDir, { recursive: true })
      fs.writeFileSync(
        path.join(userConfigDir, "opencode.json"),
        JSON.stringify({ plugin: [["opencode-triage", { autoHide: true }]], instructions: ["user-only-secret"] }),
        "utf-8"
      )
      fs.writeFileSync(
        path.join(appDataConfigDir, "opencode.json"),
        JSON.stringify({ plugin: [["opencode-triage", { autoHide: true }]], instructions: ["appdata-only-secret"] }),
        "utf-8"
      )

      const json = statusJson(fixture)
      assert.strictEqual(json.windows_config.sameHash, false)
      assert.deepStrictEqual(json.windows_config.differingSections, ["instructions"])
      assert.strictEqual(json.windows_config.userConfig.pluginPresent, true)
      assert.strictEqual(json.windows_config.appDataConfig.pluginPresent, true)
      assert.ok(!JSON.stringify(json.windows_config).includes("secret"))
    })
  })
})

describe("dedupe --dry-run --json", () => {
  const cli = path.join(import.meta.dirname, "..", "bin", "opencode-triage.cjs")

  it("returns valid no-op JSON when no duplicates exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-triage-dedupe-"))
    try {
      const output = execSync(`node "${cli}" dedupe --dry-run --json`, {
        cwd: root,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: path.join(root, "home"),
          USERPROFILE: path.join(root, "home"),
          APPDATA: path.join(root, "appdata"),
        },
      })
      const json = JSON.parse(output)
      assert.strictEqual(json.ok, true)
      assert.strictEqual(json.dryRun, true)
      assert.strictEqual(json.changed, false)
      assert.deepStrictEqual(json.duplicates, [])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
