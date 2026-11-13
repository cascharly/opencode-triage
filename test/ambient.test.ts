import { it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "../src/index.ts"
import { scoreSkills } from "../src/scoring.ts"

it("isolates concurrent sessions, refreshes every request, and avoids duplicate suggestions", async () => {
  const root = mkdtempSync(join(tmpdir(), "triage-ambient-"))
  let plugin: Awaited<ReturnType<typeof server>> | undefined
  try {
    for (const name of ["qzxalpha", "qzxbeta"]) {
      const dir = join(root, ".agents/skills", name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} specialized workflow\n---\n`)
    }
    plugin = await server({ worktree: root, client: { tui: { showToast: async () => {} } } } as any,
      { autoHide: true, ambientMaxCandidates: 1 })
    const transform = plugin["experimental.chat.messages.transform"]!
    const request = (sessionID: string, text: string): any => ({ messages: [{
      info: { id: `msg_${sessionID}`, role: "user", sessionID },
      parts: [{ id: "prt_original", type: "text", text, sessionID, messageID: `msg_${sessionID}` }],
    }] })
    const alpha = request("alpha", "qzxalpha")
    const beta = request("beta", "qzxbeta")
    await Promise.all([transform({}, alpha), transform({}, beta)])
    assert.match(alpha.messages[0].parts[0].text, /qzxalpha/)
    assert.doesNotMatch(alpha.messages[0].parts[0].text, /qzxbeta/)
    assert.match(beta.messages[0].parts[0].text, /qzxbeta/)
    await transform({}, alpha)
    assert.equal(alpha.messages[0].parts.filter((p: any) => p.synthetic).length, 1)
    const nextStep = request("alpha", "qzxalpha")
    await transform({}, nextStep)
    assert.match(nextStep.messages[0].parts[0].text, /suggested_skills/)
    const unrelated = request("alpha", "zzzxxyyunknown")
    await transform({}, unrelated)
    assert.equal(unrelated.messages[0].parts.length, 1)
  } finally {
    await plugin?.dispose?.()
    assert.ok(root.startsWith(join(tmpdir(), "triage-ambient-")))
    rmSync(root, { recursive: true, force: true })
  }
})

it("segments unspaced Chinese while retaining short English word filtering", () => {
  const skills = [
    { name: "db-backup", desc: "\u6570\u636e\u5e93\u5907\u4efd", path: "/db", scope: "global" as const },
    { name: "web-design", desc: "website design", path: "/web", scope: "global" as const },
  ]
  const scored = scoreSkills("\u5e2e\u6211\u5907\u4efd\u6570\u636e\u5e93", skills)
  assert.ok(scored.find(s => s.name === "db-backup")!.score > 0)
  assert.equal(scored.find(s => s.name === "web-design")!.score, 0)
  assert.deepEqual(scoreSkills("a an", skills), [])
})
