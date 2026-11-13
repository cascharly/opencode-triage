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
import { levenshtein } from "../src/spellcheck.ts"

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

describe("--all flag", () => {
  const cli = path.join(import.meta.dirname, "..", "bin", "opencode-triage.cjs")

  it("status --all shows all global skills (no truncation)", () => {
    const output = execSync(`node "${cli}" status --all`, { encoding: "utf-8" })
    // Should NOT contain "... and" truncation
    assert.ok(!output.includes("... and"), "should not truncate with --all")
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

  it("reports Windows config drift without exposing config values", { skip: process.platform !== "win32" }, () => {
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
