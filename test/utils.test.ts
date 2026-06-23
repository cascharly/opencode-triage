import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { stripBOM, extractFrontmatter, escapeRegex, isValidSkillName } from "../src/utils.ts"
import { getWordBonus, scoreSkills, stem, scoreSkillsSemantic } from "../src/scoring.ts"
import { cosineSimilarity } from "../src/embeddings.ts"
import { THRESHOLD, SCOPE_BONUS } from "../src/config.ts"

// ── stripBOM ──────────────────────────────────────────────

describe("stripBOM", () => {
  it("removes UTF-8 BOM", () => {
    const withBOM = "\uFEFF---\nname: test\n---\ncontent"
    assert.equal(stripBOM(withBOM), "---\nname: test\n---\ncontent")
  })

  it("returns unchanged when no BOM", () => {
    const noBOM = "---\nname: test\n---\ncontent"
    assert.equal(stripBOM(noBOM), noBOM)
  })

  it("handles empty string", () => {
    assert.equal(stripBOM(""), "")
  })
})

// ── extractFrontmatter ────────────────────────────────────

describe("extractFrontmatter", () => {
  it("extracts name from single-line frontmatter", () => {
    const content = `---
name: backup-restore
description: Backup and restore databases
---
Some content here.`
    assert.equal(extractFrontmatter(content, "name"), "backup-restore")
  })

  it("extracts description from single-line frontmatter", () => {
    const content = `---
name: backup-restore
description: Backup and restore databases
---
Some content here.`
    assert.equal(extractFrontmatter(content, "description"), "Backup and restore databases")
  })

  it("extracts first line of folded description (> syntax)", () => {
    const content = `---
name: my-skill
description: >
  This is a long
  folded description
---
Body.`
    // With m flag, $ matches end-of-line, so multi-line folded blocks
    // only capture the first line. This is a known limitation.
    assert.equal(extractFrontmatter(content, "description"), "This is a long")
  })

  it("returns null when key missing", () => {
    const content = `---
name: my-skill
---
Body.`
    assert.equal(extractFrontmatter(content, "description"), null)
  })

  it("returns null when no frontmatter", () => {
    assert.equal(extractFrontmatter("Just plain text", "name"), null)
  })

  it("handles BOM before frontmatter", () => {
    const content = "\uFEFF---\nname: bom-skill\n---\nBody"
    assert.equal(extractFrontmatter(content, "name"), "bom-skill")
  })

  it("handles CRLF line endings", () => {
    const content = "---\r\nname: crlf-skill\r\ndescription: Windows style\r\n---\r\nBody"
    assert.equal(extractFrontmatter(content, "name"), "crlf-skill")
  })
})

// ── escapeRegex ───────────────────────────────────────────

describe("escapeRegex", () => {
  it("escapes special regex characters", () => {
    assert.equal(escapeRegex("a.b"), "a\\.b")
    assert.equal(escapeRegex("a*b"), "a\\*b")
    assert.equal(escapeRegex("a+b"), "a\\+b")
    assert.equal(escapeRegex("a?b"), "a\\?b")
    assert.equal(escapeRegex("a^b"), "a\\^b")
    assert.equal(escapeRegex("a$b"), "a\\$b")
    assert.equal(escapeRegex("a{b}"), "a\\{b\\}")
    assert.equal(escapeRegex("a(b)"), "a\\(b\\)")
    assert.equal(escapeRegex("a|b"), "a\\|b")
    assert.equal(escapeRegex("a[b]"), "a\\[b\\]")
    assert.equal(escapeRegex("a\\b"), "a\\\\b")
  })

  it("escapes hyphen", () => {
    assert.equal(escapeRegex("a-b"), "a\\-b")
  })

  it("leaves alphanumeric unchanged", () => {
    assert.equal(escapeRegex("abc123"), "abc123")
  })
})

// ── getWordBonus ──────────────────────────────────────────

describe("getWordBonus", () => {
  it("returns 15 for exact word match", () => {
    assert.equal(getWordBonus("backup", "backup restore"), 15)
  })

  it("returns 15 for exact word match at boundaries", () => {
    assert.equal(getWordBonus("db", "backup db restore"), 15)
  })

  it("returns 10 for substring match", () => {
    assert.equal(getWordBonus("back", "backup"), 10)
  })

  it("returns 0 for no match", () => {
    assert.equal(getWordBonus("xyz", "backup restore"), 0)
  })

  it("is case insensitive", () => {
    assert.equal(getWordBonus("BACKUP", "backup restore"), 15)
    assert.equal(getWordBonus("backup", "BACKUP RESTORE"), 15)
  })
})

// ── scoreSkills ───────────────────────────────────────────

describe("scoreSkills", () => {
  const skills = [
    { name: "backup-restore", desc: "Backup and restore databases", path: "/a", scope: "project" as const },
    { name: "database-sync", desc: "Synchronize databases across servers", path: "/b", scope: "project" as const },
    { name: "web-design", desc: "Design responsive web interfaces", path: "/c", scope: "global" as const },
  ]

  it("returns empty array for empty query", () => {
    assert.deepEqual(scoreSkills("", skills), [])
  })

  it("scores name match higher than desc match", () => {
    const result = scoreSkills("backup", skills)
    const backupSkill = result.find(s => s.name === "backup-restore")
    const dbSkill = result.find(s => s.name === "database-sync")
    assert.ok(backupSkill && dbSkill)
    assert.ok(backupSkill.score > dbSkill.score)
  })

  it("strips punctuation from query", () => {
    const result = scoreSkills("backup my database!", skills)
    const backupSkill = result.find(s => s.name === "backup-restore")
    assert.ok(backupSkill && backupSkill.score > 0)
  })

  it("returns zero scores for no matches", () => {
    const result = scoreSkills("cooking recipe pizza", skills)
    assert.ok(result.every(s => s.score === 0))
  })

  it("tracks matched words", () => {
    const result = scoreSkills("backup database", skills)
    const backupSkill = result.find(s => s.name === "backup-restore")
    assert.ok(backupSkill)
    assert.ok(backupSkill.matchedBy.includes("name:backup"))
    assert.ok(backupSkill.matchedBy.includes("desc:database"))
  })
})

// ── isValidSkillName ──────────────────────────────────────

describe("isValidSkillName", () => {
  it("rejects ..", () => {
    assert.equal(isValidSkillName(".."), false)
  })

  it("rejects .", () => {
    assert.equal(isValidSkillName("."), false)
  })

  it("rejects forward slash", () => {
    assert.equal(isValidSkillName("foo/bar"), false)
  })

  it("rejects backslash", () => {
    assert.equal(isValidSkillName("foo\\bar"), false)
  })

  it("accepts normal names", () => {
    assert.equal(isValidSkillName("backup-restore"), true)
    assert.equal(isValidSkillName("my_cool_skill"), true)
    assert.equal(isValidSkillName("web-design"), true)
  })
})

// ── stem ──────────────────────────────────────────────────

describe("stem", () => {
  it("ies → y: vulnerabilities → vulnerability", () => {
    assert.equal(stem("vulnerabilities"), "vulnerability")
  })

  it("ies → y: activities → activity", () => {
    assert.equal(stem("activities"), "activity")
  })

  it("ing → '': refactoring → refactor", () => {
    assert.equal(stem("refactoring"), "refactor")
  })

  it("ing → '': testing → test", () => {
    assert.equal(stem("testing"), "test")
  })

  it("ing → '': monitoring → monitor", () => {
    assert.equal(stem("monitoring"), "monitor")
  })

  it("no rule: react stays react", () => {
    assert.equal(stem("react"), "react")
  })

  it("MIN guard: short words not stripped — ring stays ring", () => {
    assert.equal(stem("ring"), "ring")
  })

  it("MIN guard: using stays using (result 'us' too short)", () => {
    assert.equal(stem("using"), "using")
  })

  it("MIN guard: ties stays ties (result 'ty' too short)", () => {
    assert.equal(stem("ties"), "ties")
  })
})

// ── Integration: scoring scenarios ────────────────────────

describe("scoring scenarios", () => {
  const skills = [
    { name: "backup-restore", desc: "Backup and restore databases", path: "/a", scope: "project" as const },
    { name: "database-sync", desc: "Synchronize databases across servers", path: "/b", scope: "project" as const },
    { name: "web-design", desc: "Design responsive web interfaces", path: "/c", scope: "global" as const },
  ]

  it("clear winner with high gap", () => {
    const scored = scoreSkills("web design responsive", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored[0].name, "web-design")
    const gap = scored[0].score - (scored[1]?.score ?? 0)
    assert.ok(gap >= THRESHOLD, `Gap ${gap} should be >= ${THRESHOLD}`)
  })

  it("IDF resolves ambiguity — rare word dominates common word", () => {
    const scored = scoreSkills("backup database", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.ok(scored.length >= 2)
    assert.equal(scored[0].name, "backup-restore")
    const gap = scored[0].score - (scored[1]?.score ?? 0)
    assert.ok(gap >= THRESHOLD, `Gap ${gap} should be >= ${THRESHOLD} — IDF boosted "backup" (rare word)`)
  })

  it("single skill returns auto-route", () => {
    const single = [{ name: "only-skill", desc: "Does one thing", path: "/x", scope: "project" as const }]
    const scored = scoreSkills("does thing", single)
      .filter(s => s.score > 0)

    assert.equal(scored.length, 1)
  })

  it("bigram bonus when consecutive words appear in desc", () => {
    const skills = [
      { name: "react-patterns", desc: "React composition patterns. Use when building React apps with boolean prop patterns.", path: "/a", scope: "project" as const },
      { name: "react-perf", desc: "React performance optimization for production apps.", path: "/b", scope: "project" as const },
    ]
    const scored = scoreSkills("boolean prop", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored.length, 1)
    assert.equal(scored[0].name, "react-patterns")
    assert.ok(scored[0].matchedBy.includes("bigram:boolean prop"), "bigram match should be tracked")
    assert.ok(scored[0].score >= 10, "bigram bonus should increase score")
  })

  it("phrase bonus for 3+ consecutive words in desc", () => {
    const skills = [
      { name: "diagram-creator", desc: "Create architecture diagrams and flowcharts for system design using Mermaid.", path: "/a", scope: "project" as const },
      { name: "other-tool", desc: "General diagram tool for different purposes.", path: "/b", scope: "project" as const },
    ]
    const scored = scoreSkills("create architecture diagrams", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored[0].name, "diagram-creator")
    assert.ok(scored[0].matchedBy.includes("phrase:"), "phrase match should be tracked")
    assert.ok(scored[0].score >= 50, "phrase bonus should add at least 50 points")
  })

  it("descScore tracks description-only points", () => {
    const skills = [
      { name: "x-skill", desc: "alpha beta gamma delta epsilon zeta eta theta", path: "/x", scope: "project" as const },
    ]
    const scored = scoreSkills("alpha beta gamma", skills)
    assert.ok(scored[0].descScore > 0, "descScore should be > 0 when description matches")
    assert.ok(scored[0].descScore <= scored[0].score, "descScore should not exceed total score")
  })

  it("stemming — inflected desc word matches uninflected query word", () => {
    const skills = [
      { name: "sec-tool", desc: "Detect and report LLM vulnerabilities in production", path: "/a", scope: "project" as const },
      { name: "sec-monitor", desc: "Security monitoring and alerting service", path: "/b", scope: "project" as const },
    ]
    const scored = scoreSkills("vulnerability", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored[0].name, "sec-tool", "sec-tool has 'vulnerabilities' → stems to 'vulnerability'")
    assert.ok(scored[0].matchedBy.includes("desc:stem:vulnerability"), "stem match should be tracked")
  })

  it("stemming — query word matches gerund in desc", () => {
    const skills = [
      { name: "code-tools", desc: "Tools for refactoring legacy codebases", path: "/a", scope: "project" as const },
      { name: "react-guide", desc: "React component best practices", path: "/b", scope: "project" as const },
    ]
    const scored = scoreSkills("refactor", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored[0].name, "code-tools")
    assert.ok(scored[0].matchedBy.includes("desc:stem:refactor"))
  })

  it("name tokenization — bigram matches across hyphenated name", () => {
    const skills = [
      { name: "vercel-react-native-skills", desc: "Mobile framework guide", path: "/a", scope: "global" as const },
      { name: "vercel-react-best-practices", desc: "Web framework guide", path: "/b", scope: "global" as const },
    ]
    const scored = scoreSkills("react native", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored[0].name, "vercel-react-native-skills")
    assert.ok(scored[0].matchedBy.includes("bigram:name:react native"), "name bigram should be tracked")
    const gap = scored[0].score - scored[1].score
    assert.ok(gap >= THRESHOLD, `gap ${gap} should exceed THRESHOLD after name bigram bonus`)
  })

  it("scope tiebreaker — project skill wins exact tie over global", () => {
    const skills = [
      { name: "sec-scanner", desc: "security vulnerability scanning tool", path: "/a", scope: "project" as const },
      { name: "sec-monitor", desc: "security vulnerability monitoring service", path: "/b", scope: "global" as const },
    ]
    const scored = scoreSkills("security vulnerability", skills)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    assert.equal(scored[0].name, "sec-scanner", "project skill should win equal tie")
    assert.ok(scored[0].matchedBy.includes("scope:project"), "scope bonus should be tracked")
    assert.equal(scored[0].score - scored[1].score, SCOPE_BONUS, `gap should equal SCOPE_BONUS (${SCOPE_BONUS})`)
  })

  it("scope bonus not applied to zero-score skills", () => {
    const skills = [
      { name: "project-skill", desc: "react component builder", path: "/a", scope: "project" as const },
      { name: "global-skill", desc: "react component library", path: "/b", scope: "global" as const },
    ]
    const allScored = scoreSkills("kubernetes deploy", skills)
    const projectSkill = allScored.find(s => s.name === "project-skill")!
    assert.equal(projectSkill.score, 0, "project scope bonus must not apply when score is 0")
  })
})

// ── cosineSimilarity ─────────────────────────────────────

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