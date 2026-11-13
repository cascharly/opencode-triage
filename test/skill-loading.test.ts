import { it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "../src/index.ts"

it("searches and loads file-hidden skills without relying on the native loader", async () => {
  const root = mkdtempSync(join(tmpdir(), "triage-loader-"))
  let plugin: Awaited<ReturnType<typeof server>> | undefined
  try {
    const dir = join(root, ".agents/skills/qzxhidden")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md.disabled"), "---\nname: qzxhidden\ndescription: qzxhidden <tag> & tools\n---\n\nPrivate workflow instructions.")
    plugin = await server({ worktree: root, client: { tui: { showToast: async () => {} } } } as any, { autoHide: false })
    const context = { abort: new AbortController().signal } as any
    const found = await plugin.tool!.triage.execute({ query: "qzxhidden" }, context)
    assert.match(found, /load-skill/)
    assert.doesNotMatch(found, /Private workflow instructions/)
    const loaded = await plugin.tool!["load-skill"].execute({ name: "qzxhidden" }, context)
    assert.match(loaded, /Private workflow instructions/)
    const missing = await plugin.tool!["load-skill"].execute({ name: "../../outside" }, context)
    assert.match(missing, /No installed skill/)
    const listed = await plugin.tool!["list-skills"].execute({}, context)
    assert.match(listed, /qzxhidden &lt;tag&gt; &amp; tools/)
  } finally {
    await plugin?.dispose?.()
    assert.ok(root.startsWith(join(tmpdir(), "triage-loader-")))
    rmSync(root, { recursive: true, force: true })
  }
})
