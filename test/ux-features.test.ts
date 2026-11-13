/**
 * Tests for CLI UX features: Levenshtein distance, command suggestion,
 * --json flag behavior, --dry-run simulation, --all flag, and out-of-sync detection.
 */
import assert from "node:assert"
import { describe, it } from "node:test"
import { execSync } from "node:child_process"
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
