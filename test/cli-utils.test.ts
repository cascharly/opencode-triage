/**
 * Tests for CLI utility functions (stripJsoncComments, safeRenameSync behavior, etc.)
 */
import assert from "node:assert"
import { describe, it } from "node:test"

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
