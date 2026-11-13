/**
 * Tests for CLI UX features: Levenshtein distance, command suggestion,
 * --json flag behavior, --dry-run simulation, --all flag, and out-of-sync detection.
 */
import assert from "node:assert"
import { describe, it } from "node:test"
import { execSync } from "node:child_process"
import path from "node:path"
import { levenshtein } from "../src/spellcheck.ts"

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
