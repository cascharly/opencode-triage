/**
 * Embedding module for semantic skill matching.
 *
 * Loads a multilingual transformer model, computes text embeddings,
 * and manages a persistent on-disk cache keyed by skill file path + mtime.
 *
 * If @xenova/transformers or onnxruntime-node are not installed (or fail
 * to load due to network/hardware limitations), this module gracefully
 * returns null from loadModel() — the caller should fall back to keyword
 * scoring via scoreSkills().
 *
 * Cache location: ~/.cache/opencode-triage/embeddings.json
 * Format: { "<abs-path>": { "mtime": 1718963200000, "embedding": [0.12, ...] } }
 */

import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile, writeFile, stat, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { SkillEntry } from "./config.ts"
import { EMBEDDING_MODEL } from "./config.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const __nodeModules = join(__dirname, "..", "node_modules")

const CACHE_DIR = join(homedir(), ".cache", "opencode-triage")
const CACHE_FILE = join(CACHE_DIR, "embeddings.json")

type EmbedCacheEntry = { mtime: number; embedding: number[] }
type EmbedDiskCache = Map<string, EmbedCacheEntry>

let _model: any | null = null
let _loadAttempted = false
let _loadError: string | null = null

function stubBrokenSharp() {
  const sharpDir = join(__nodeModules, "sharp")
  const sharpLib = join(sharpDir, "lib")
  const pkgPath = join(sharpDir, "package.json")
  const constructorPath = join(sharpLib, "constructor.js")
  const indexPath = join(sharpDir, "index.js")

  try { mkdirSync(sharpLib, { recursive: true }) } catch {}
  try {
    writeFileSync(pkgPath, JSON.stringify({ name: "sharp", version: "0.0.0", main: "lib/constructor.js" }))
    writeFileSync(constructorPath, "module.exports = function() { throw new Error('sharp: image processing unavailable') }")
    writeFileSync(indexPath, "module.exports = require('./lib/constructor')")
  } catch {}
}

async function loadModelRaw(localOnly: boolean): Promise<any> {
  stubBrokenSharp()
  const { pipeline } = await import("@xenova/transformers")
  const opts: Record<string, unknown> = {}
  if (localOnly) opts.local_files_only = true
  return pipeline("feature-extraction", EMBEDDING_MODEL, opts)
}

/**
 * Loads the embedding model from local cache only (no network).
 * Returns null if not cached, deps missing, or initialization fails.
 */
export async function loadModel(): Promise<any | null> {
  if (_model) return _model
  if (_loadAttempted) return null
  _loadAttempted = true

  try {
    _model = await loadModelRaw(true)
    return _model
  } catch (e) {
    _loadError = (e as Error).message ?? String(e)
    console.error("[opencode-triage] Embedding model unavailable:", _loadError)
    return null
  }
}

/**
 * Loads or downloads the embedding model (allows network).
 * Only used by the download-model CLI — never called at startup.
 */
export async function loadModelForDownload(): Promise<any> {
  stubBrokenSharp()
  const { pipeline } = await import("@xenova/transformers")
  return pipeline("feature-extraction", EMBEDDING_MODEL)
}

export function getLoadError(): string | null {
  return _loadError
}

/**
 * Preloads the embedding model from local cache (no network).
 * Returns the model or null if not cached / deps missing.
 */
export async function preloadModelIfCached(): Promise<any | null> {
  return loadModel()
}

export async function embed(
  model: any,
  text: string
): Promise<number[]> {
  const output = await model(text, { pooling: "mean", normalize: true })
  return Array.from(output.data)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

async function loadDiskCache(): Promise<EmbedDiskCache> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8")
    const obj = JSON.parse(raw) as Record<string, EmbedCacheEntry>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

async function saveDiskCache(cache: EmbedDiskCache): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    const obj: Record<string, EmbedCacheEntry> = {}
    for (const [k, v] of cache) {
      obj[k] = v
    }
    await writeFile(CACHE_FILE, JSON.stringify(obj), "utf-8")
  } catch {
    // non-critical — cache will be rebuilt next time
  }
}

function getSkillText(skill: SkillEntry): string {
  return `${skill.name}: ${skill.desc}`
}

export async function getOrComputeEmbeddings(
  skills: SkillEntry[],
  model: any
): Promise<Map<string, number[]>> {
  const diskCache = await loadDiskCache()
  const result = new Map<string, number[]>()
  const dirty: Array<{ path: string; text: string }> = []

  for (const skill of skills) {
    const cached = diskCache.get(skill.path)
    let mtime = 0
    try {
      mtime = (await stat(skill.path)).mtimeMs
    } catch {
      // file gone — skip
    }

    if (cached && cached.mtime === mtime) {
      result.set(skill.path, cached.embedding)
    } else {
      dirty.push({ path: skill.path, text: getSkillText(skill) })
    }
  }

  if (dirty.length > 0) {
    for (const { path, text } of dirty) {
      try {
        const embedding = await embed(model, text)
        result.set(path, embedding)
        let mtime = 0
        try {
          mtime = (await stat(path)).mtimeMs
        } catch {}
        diskCache.set(path, { mtime, embedding })
      } catch {
        // individual skill embedding failed — skip
      }
    }
    await saveDiskCache(diskCache)
  }

  return result
}
