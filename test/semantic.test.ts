import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cosineSimilarity, loadModel, embed } from "../src/embeddings.ts"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { scoreSkillsSemantic } from "../src/scoring.ts"
import { SCOPE_BONUS } from "../src/config.ts"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { server } from "../src/index.ts"

it("routes by keywords when the optional embedding dependency is absent", {
  skip: process.env.TRIAGE_TEST_MISSING_EMBEDDINGS !== "1",
}, async () => {
  assert.equal(await loadModel(), null)
  const root = mkdtempSync(join(tmpdir(), "triage-fallback-"))
  let plugin: Awaited<ReturnType<typeof server>> | undefined
  try {
    const dir = join(root, ".agents/skills/qzxfallback")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), "---\nname: qzxfallback\ndescription: qzxfallback workflow\n---\n")
    plugin = await server({ worktree: root, client: { tui: { showToast: async () => {} } } } as any, { autoHide: false })
    const result = await plugin.tool!.triage.execute({ query: "qzxfallback" }, { abort: new AbortController().signal } as any)
    assert.ok(typeof result === "string")
    assert.match(result, /qzxfallback/)
    assert.match(result, /Best match/)
  } finally {
    await plugin?.dispose?.()
    assert.ok(root.startsWith(join(tmpdir(), "triage-fallback-")))
    rmSync(root, { recursive: true, force: true })
  }
})

it("rejects incompatible or corrupt embedding vectors", () => {
  assert.equal(cosineSimilarity([1], [1, 2]), 0)
  assert.equal(cosineSimilarity([NaN, 1], [1, 2]), 0)
  assert.equal(cosineSimilarity([], []), 0)
})

it("matches Spanish queries to English skills without modifying sharp", {
  skip: process.env.TRIAGE_TEST_SEMANTIC_MODEL !== "1",
}, async () => {
  const require = createRequire(import.meta.url)
  const sharpFiles = [require.resolve("sharp/package.json"), require.resolve("sharp")]
  const hashes = () => sharpFiles.map(file => createHash("sha256").update(readFileSync(file)).digest("hex"))
  const before = hashes()
  const model = await loadModel()
  assert.ok(model, "Run download-model first to populate the local model cache")
  const skills = [
    { name: "backup-restore", desc: "Back up and restore databases, create database snapshots and recover lost data.", path: "/backup", scope: "global" as const },
    { name: "web-design", desc: "Design responsive websites and improve CSS layouts.", path: "/design", scope: "global" as const },
    { name: "offer-letter", desc: "Write employment offer letters for new employees.", path: "/offer", scope: "global" as const },
  ]
  const vectors = new Map<string, number[]>()
  for (const skill of skills) vectors.set(skill.path, await embed(model, `${skill.name}: ${skill.desc}`))
  for (const [query, expected] of [
    ["Necesito hacer una copia de seguridad de mi base de datos", "backup-restore"],
    ["Quiero mejorar el diseno visual de mi sitio web", "web-design"],
  ]) {
    const ranked = scoreSkillsSemantic(await embed(model, query), skills, vectors).sort((a, b) => b.score - a.score)
    assert.equal(ranked[0].name, expected)
    assert.ok(ranked[0].score >= 25)
    assert.ok(ranked[0].score - ranked[1].score >= 20)
  }
  assert.deepEqual(hashes(), before)
})

describe("cosineSimilarity", () => {
  it("identical vectors → 1", () => {
    const v = [1, 2, 3]
    assert.equal(cosineSimilarity(v, v), 1)
  })

  it("orthogonal vectors → 0", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  })

  it("opposite vectors → -1", () => {
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1)
  })

  it("zero vector → 0", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0)
  })

  it("both zero → 0", () => {
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0)
  })
})

// ── scoreSkillsSemantic ──────────────────────────────────

describe("scoreSkillsSemantic", () => {
  const skills = [
    { name: "backup-restore", desc: "Backup and restore databases", path: "/a", scope: "project" as const },
    { name: "web-design", desc: "Design responsive web interfaces", path: "/b", scope: "project" as const },
    { name: "unrelated", desc: "Something completely different", path: "/c", scope: "global" as const },
  ]

  const queryEmb = [0.5, 0.5, 0, 0]

  it("ranks high-similarity skill above low", () => {
    const skillEmbs = new Map<string, number[]>([
      ["/a", [0.5, 0.5, 0, 0]],   // cosine 1 → score ~100
      ["/b", [0.1, 0.1, 0, 0]],   // cosine ~0.99 → score ~99
      ["/c", [0, 0, 1, 1]],       // cosine 0 → score 0
    ])
    const scored = scoreSkillsSemantic(queryEmb, skills, skillEmbs)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored[0].name, "backup-restore")
    assert.ok(scored[0].score >= 90)
  })

  it("returns 0 for missing embedding", () => {
    const skillEmbs = new Map<string, number[]>([
      ["/b", [0.1, 0.1, 0, 0]],
    ])
    const all = scoreSkillsSemantic(queryEmb, skills, skillEmbs)
    const missing = all.find(s => s.name === "backup-restore")!
    assert.equal(missing.score, 0)
    assert.equal(missing.matchedBy, "")
  })

  it("adds scope bonus for project skills", () => {
    const skillEmbs = new Map<string, number[]>([
      ["/a", [0.25, 0, 0, 0]],   // project, low cosine
      ["/c", [0.25, 0, 0, 0]],   // global, same cosine
    ])
    const all = scoreSkillsSemantic(queryEmb, skills, skillEmbs)
    const project = all.find(s => s.name === "backup-restore")!
    const global = all.find(s => s.name === "unrelated")!
    assert.equal(project.score - global.score, SCOPE_BONUS)
  })

  it("scope bonus not applied when score is 0", () => {
    const skillEmbs = new Map<string, number[]>([
      ["/a", [0, 0, 1, 1]],   // cosine 0 with query → score 0
    ])
    const all = scoreSkillsSemantic(queryEmb, skills, skillEmbs)
    const project = all.find(s => s.name === "backup-restore")!
    assert.equal(project.score, 0)
  })

  it("matchedBy contains semantic prefix", () => {
    const skillEmbs = new Map<string, number[]>([
      ["/a", [0.5, 0.5, 0, 0]],
    ])
    const all = scoreSkillsSemantic(queryEmb, skills, skillEmbs)
    const match = all.find(s => s.name === "backup-restore")!
    assert.ok(match.matchedBy.startsWith("semantic:"))
  })
})
