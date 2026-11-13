import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cosineSimilarity } from "../src/embeddings.ts"
import { scoreSkillsSemantic } from "../src/scoring.ts"
import { SCOPE_BONUS } from "../src/config.ts"

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