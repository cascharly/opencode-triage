import { it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { getTriageStateFromPath, getTriageOptionsFromPath } from "../src/config.ts"

const require = createRequire(import.meta.url)
const { setTriageState } = require("../bin/plugin-config.cjs")
const cli = resolve(import.meta.dirname, "../bin/opencode-triage.cjs")

for (const format of ["plugin", "plugins"] as const) {
  it(`preserves the ${format} config format, package pin, and options across toggles`, async () => {
    const root = mkdtempSync(join(tmpdir(), "triage-config-"))
    try {
      const file = join(root, "opencode.json")
      const pinned = "opencode-triage@1.4.0"
      const original = format === "plugin"
        ? { plugin: ["other-plugin", [pinned, { autoHide: false, semanticMatching: false, ambientMaxCandidates: 2 }]], model: "unchanged" }
        : { plugins: ["other-plugin", { package: pinned, options: { autoHide: false, semanticMatching: false, ambientMaxCandidates: 2 } }], model: "unchanged" }
      writeFileSync(file, JSON.stringify(original))
      for (const [command, expected] of [["on", "on"], ["off", "off"]] as const) {
        const result = spawnSync(process.execPath, [cli, command, "--local", "--quiet"], {
          cwd: root, encoding: "utf8", env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
        })
        assert.equal(result.status, 0, result.stderr)
        const config = JSON.parse(readFileSync(file, "utf8"))
        assert.equal(config.model, "unchanged")
        assert.equal(config[format][0], "other-plugin")
        assert.equal(config[format].length, 2)
        assert.equal(format === "plugin" ? config.plugin[1][0] : config.plugins[1].package, pinned)
        assert.equal(Object.hasOwn(config, format === "plugin" ? "plugins" : "plugin"), false)
        assert.equal(await getTriageStateFromPath(file), expected)
        assert.equal(getTriageOptionsFromPath(file)?.semanticMatching, false)
        assert.equal(getTriageOptionsFromPath(file)?.ambientMaxCandidates, 2)
      }
    } finally {
      assert.ok(root.startsWith(join(tmpdir(), "triage-config-")))
      rmSync(root, { recursive: true, force: true })
    }
  })
}

it("updates both existing versions without duplicate registrations", () => {
  const config: any = { plugin: [["opencode-triage", { autoHide: false }]], plugins: [{ package: "opencode-triage", options: { autoHide: false } }] }
  assert.equal(setTriageState(config, true), true)
  assert.equal(config.plugin[0][1].autoHide, true)
  assert.equal(config.plugins[0].options.autoHide, true)
  assert.equal(setTriageState(config, true), false)
})

it("does not overwrite malformed config files", () => {
  const root = mkdtempSync(join(tmpdir(), "triage-config-"))
  try {
    const file = join(root, "opencode.json")
    const original = '{ "plugins": [broken json'
    writeFileSync(file, original)
    const result = spawnSync(process.execPath, [cli, "on", "--local", "--quiet"], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") },
    })
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(file, "utf8"), original)
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "triage-config-")))
    rmSync(root, { recursive: true, force: true })
  }
})
