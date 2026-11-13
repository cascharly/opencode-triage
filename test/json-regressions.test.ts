import { it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const cli = resolve(import.meta.dirname, "../bin/opencode-triage.cjs")

it("keeps dedupe previews non-destructive and rejects ambiguous JSON removal", () => {
  const root = mkdtempSync(join(tmpdir(), "triage-json-"))
  try {
    const home = join(root, "home")
    const local = join(root, ".agents/skills/duplicate/SKILL.md")
    const global = join(home, ".agents/skills/duplicate/SKILL.md")
    for (const file of [local, global]) {
      mkdirSync(resolve(file, ".."), { recursive: true })
      writeFileSync(file, "---\nname: duplicate\ndescription: duplicate\n---\n")
    }
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "dedupe", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    const preview = run("--dry-run", "--json")
    assert.equal(preview.status, 0)
    assert.equal(JSON.parse(preview.stdout).changesPending, true)
    const removal = run("--json")
    assert.equal(removal.status, 1)
    assert.equal(JSON.parse(removal.stdout).ok, false)
    assert.ok(existsSync(local) && existsSync(global))
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "triage-json-")))
    rmSync(root, { recursive: true, force: true })
  }
})

it("JSON mode never requests an update or appends update notices", () => {
  const root = mkdtempSync(join(tmpdir(), "triage-json-"))
  try {
    const preload = join(root, "no-network.cjs")
    writeFileSync(preload, 'require("node:https").get = () => { throw new Error("unexpected update request") }')
    const result = spawnSync(process.execPath, ["--require", preload, cli, "version", "--json"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(typeof JSON.parse(result.stdout).version, "string")
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "triage-json-")))
    rmSync(root, { recursive: true, force: true })
  }
})
