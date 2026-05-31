/**
 * Tests for CLI utility functions (stripJsoncComments, safeRenameSync behavior, etc.)
 */
import assert from "node:assert"
import { describe, it } from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const shared = require("../bin/shared.cjs")
import { stripJsoncComments } from "../src/config.ts"

describe("stripJsoncComments", () => {
  it("strips single-line comments", () => {
    const input = `{\n  "key": "value", // this is a comment\n  "other": 1\n}`
    const expected = `{\n  "key": "value", \n  "other": 1\n}`
    assert.strictEqual(stripJsoncComments(input), expected)
  })

  it("strips multi-line comments", () => {
    const input = `{\n  /* comment */\n  "key": "value"\n}`
    const expected = `{\n  \n  "key": "value"\n}`
    assert.strictEqual(stripJsoncComments(input), expected)
  })

  it("preserves URLs with // inside strings", () => {
    const input = `{"url": "https://example.com"}`
    assert.strictEqual(stripJsoncComments(input), input)
  })

  it("preserves URLs with // inside strings alongside comments", () => {
    const input = `{\n  "url": "https://example.com", // comment here\n  "name": "test"\n}`
    const expected = `{\n  "url": "https://example.com", \n  "name": "test"\n}`
    assert.strictEqual(stripJsoncComments(input), expected)
  })

  it("handles escaped quotes inside strings", () => {
    const input = `{"msg": "he said \\"hello\\" // not a comment"}`
    assert.strictEqual(stripJsoncComments(input), input)
  })

  it("handles empty string", () => {
    assert.strictEqual(stripJsoncComments(""), "")
  })

  it("handles string with only comment", () => {
    assert.strictEqual(stripJsoncComments("// comment\n"), "\n")
  })

  it("handles multi-line block comment spanning lines", () => {
    const input = `{\n  /* line1\n     line2\n     line3 */\n  "key": 1\n}`
    const expected = `{\n  \n  "key": 1\n}`
    assert.strictEqual(stripJsoncComments(input), expected)
  })

  it("handles comment inside string value is not stripped", () => {
    const input = `{"path": "C://Users//test"}`
    assert.strictEqual(stripJsoncComments(input), input)
  })

  it("handles trailing backslash in string", () => {
    const input = `{"path": "C:\\\\test"}`
    assert.strictEqual(stripJsoncComments(input), input)
  })
})

describe("shared.cjs utilities", () => {
  // stripJsoncComments is defined in bin/shared.cjs and re-exported by src/config.ts.
  // The TypeScript layer imports from shared.cjs via createRequire — single source of truth.
  it("exports stripJsoncComments", () => {
    const input = `{\n  "key": "value", // this is a comment\n  "other": 1\n}`
    const expected = `{\n  "key": "value", \n  "other": 1\n}`
    assert.strictEqual(shared.stripJsoncComments(input), expected)
  })

  it("exports levenshtein that calculates distance correctly", () => {
    assert.strictEqual(shared.levenshtein("cat", "cat"), 0)
    assert.strictEqual(shared.levenshtein("cat", "bat"), 1)
    assert.strictEqual(shared.levenshtein("kitten", "sitting"), 3)
  })

  it("exports semverGt that compares semver correctly", () => {
    assert.strictEqual(shared.semverGt("1.2.3", "1.2.2"), true)
    assert.strictEqual(shared.semverGt("1.2.3", "1.2.3"), false)
    assert.strictEqual(shared.semverGt("1.3.0", "1.2.9"), true)
    assert.strictEqual(shared.semverGt("2.0.0", "1.9.9"), true)
    assert.strictEqual(shared.semverGt("1.10.0", "1.9.0"), true)
  })

  it("exports extractFrontmatterField that parses field correctly", () => {
    const content = `---
name: backup-restore
description: Backup and restore databases
---
Body text`
    assert.strictEqual(shared.extractFrontmatterField(content, "name"), "backup-restore")
    assert.strictEqual(shared.extractFrontmatterField(content, "description"), "Backup and restore databases")
    assert.strictEqual(shared.extractFrontmatterField(content, "missing"), null)
  })
})

