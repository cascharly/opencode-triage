import assert from "node:assert"
import { describe, it } from "node:test"
import { execSync } from "node:child_process"
import path from "node:path"

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
