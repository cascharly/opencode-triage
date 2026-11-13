import { it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Host } from "@opencode/plugin/host"
import plugin from "../src/server.ts"
import * as legacy from "../src/index.ts"

async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "triage-v2-"))
  const previous = new Map(["HOME", "USERPROFILE"].map(key => [key, process.env[key]]))
  const previousFetch = globalThis.fetch
  const previousInfo = console.info
  try {
    process.env.HOME = process.env.USERPROFILE = join(root, "home")
    globalThis.fetch = async () => new Response("{}")
    console.info = () => {}
    await run(root)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = previousFetch
    console.info = previousInfo
    assert.ok(root.startsWith(join(tmpdir(), "triage-v2-")))
    rmSync(root, { recursive: true, force: true })
  }
}

function host(root: string, enabled = true) {
  const tools = new Map<string, any>([["skill", { name: "skill", description: "native catalog", execute: () => {} }]])
  const skills = new Map<string, any>([["native_123", {
    id: "native_123", name: "qzxalpha", path: join(root, ".agents/skills/qzxalpha/SKILL.md"),
    description: "qzxalpha workflow", autoinvoke: true,
  }]])
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const permissions: any[] = []
  let disposed = 0
  const registration = () => ({ dispose: async () => { disposed++ } })
  const ctx: any = {
    location: { directory: root, project: { canonical: root } },
    options: { autoHide: enabled, semanticMatching: false },
    permission: { assert: async (input: any) => { permissions.push(input) } },
    tool: { transform: async (callback: any) => {
      callback({ add: (tool: any) => tools.set(tool.name, tool), update: (id: string, edit: any) => {
        if (tools.has(id)) edit(tools.get(id))
      } })
      return registration()
    } },
    skill: {
      list: async () => ({ location: { directory: root }, data: [...skills.values()] }),
      reload: async () => {},
      transform: async (callback: any) => {
        callback({ list: () => [...skills.values()], update: (id: string, edit: any) => edit(skills.get(id)) })
        return registration()
      },
    },
    session: { hook: async (name: string, callback: any) => { hooks.set(name, callback); return registration() } },
  }
  const context: any = { sessionID: "ses_test", messageID: "msg_test", agent: "build", id: "call_test", signal: new AbortController().signal }
  return { ctx, context, tools, skills, hooks, permissions, disposed: () => disposed }
}

it("lets V2 choose ./server automatically while the legacy entry stays callable", async () => {
  assert.deepEqual(Object.keys(legacy), ["server"])
  assert.equal(typeof legacy.server, "function")
  const entries = Host.resolve({ directory: resolve(import.meta.dirname, "..") })
  assert.match(entries.server!, /src[\\/]server\.ts$/)
  const loaded: any = await Host.load(entries.server!)
  assert.equal(loaded.default.id, "opencode-triage")
  assert.equal(typeof loaded.default.setup, "function")
})

it("registers native tools, uses V2 skill IDs, isolates context, and cleans up", async () => fixture(async root => {
  const dir = join(root, ".agents/skills/qzxalpha")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "---\nname: qzxalpha\ndescription: qzxalpha workflow\n---\nAlpha instructions")
  const h = host(root)
  const cleanup = await plugin.setup(h.ctx)
  try {
    assert.deepEqual([...h.tools.keys()].sort(), ["skill", "triage", "load-skill", "list-skills", "rescan"].sort())
    assert.equal(h.skills.get("native_123").autoinvoke, false)
    const found = await h.tools.get("triage").execute({ query: "qzxalpha" }, h.context)
    assert.match(found.content, /skill\(\{ id: "native_123" \}\)/)
    assert.doesNotMatch(found.content, /Alpha instructions/)
    assert.ok(existsSync(join(dir, "SKILL.md")))
    const media = { type: "media", media: { source: "attachment" } }
    const event: any = {
      sessionID: "ses_test", system: [{ type: "text", text: "Rules\n<available_skills>FULL CATALOG</available_skills>", metadata: { source: "test" } }],
      messages: [{ role: "user", id: "msg_test", content: [{ type: "text", text: "qzxalpha" }, media] }],
    }
    await h.hooks.get("context")!(event)
    assert.doesNotMatch(event.system[0].text, /FULL CATALOG/)
    assert.deepEqual(event.system[0].metadata, { source: "test" })
    assert.match(event.messages[0].content[0].text, /native_123/)
    assert.ok(event.messages[0].content.includes(media))
    await h.hooks.get("context")!(event)
    assert.equal(event.messages[0].content.filter((p: any) => p.type === "text" && p.text.startsWith("<suggested_skills>")).length, 1)
    const unrelated: any = { system: [], messages: [{ role: "user", content: [{ type: "text", text: "zzzxxyyunknown" }] }] }
    await h.hooks.get("context")!(unrelated)
    assert.equal(unrelated.messages[0].content.length, 1)
    assert.ok(unrelated.system.length > 0)
    for (const kind of ["compaction", "title", "generate"]) {
      const auxiliary: any = { system: [{ type: "text", text: "<available_skills>FULL CATALOG</available_skills>" }] }
      await h.hooks.get(kind)!(auxiliary)
      assert.doesNotMatch(auxiliary.system[0].text, /FULL CATALOG/)
      assert.doesNotMatch(auxiliary.system[0].text, /Before any task/)
    }
    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await h.tools.get("triage").execute({ query: "qzxalpha" }, { ...h.context, signal: aborted.signal })
    assert.match(cancelled.content, /cancelled/)
    const loaded = await h.tools.get("load-skill").execute({ name: "qzxalpha" }, h.context)
    assert.match(loaded.content, /Alpha instructions/)
    assert.deepEqual(h.permissions[0].resources, ["native_123"])
    h.ctx.permission.assert = async (input: any) => { if (input.resources.includes("native_123")) throw new Error("denied") }
    await assert.rejects(h.tools.get("load-skill").execute({ name: "qzxalpha" }, h.context), /denied/)
  } finally { await cleanup?.() }
  assert.equal(h.disposed(), 6)
}))

it("leaves native exposure unchanged when disabled and rolls back setup errors", async () => fixture(async root => {
  const h = host(root, false)
  const cleanup = await plugin.setup(h.ctx)
  try {
    assert.equal(h.skills.get("native_123").autoinvoke, true)
    assert.equal(h.tools.get("skill").description, "native catalog")
    const event: any = { system: [{ type: "text", text: "<available_skills>visible</available_skills>" }], messages: [] }
    await h.hooks.get("context")!(event)
    assert.match(event.system[0].text, /visible/)
  } finally { await cleanup?.() }
  const broken = host(root)
  broken.ctx.session.hook = async () => { throw new Error("hook registration failed") }
  await assert.rejects(plugin.setup(broken.ctx), /hook registration failed/)
  assert.equal(broken.disposed(), 2)
}))
