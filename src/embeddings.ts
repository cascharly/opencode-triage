/**
 * Embedding module for semantic skill matching.
 *
 * Loads a multilingual transformer model, computes text embeddings,
 * and manages a persistent on-disk cache keyed by skill file path + mtime.
 *
 * If @huggingface/transformers or onnxruntime-node are not installed (or fail
 * to load due to network/hardware limitations), this module gracefully
 * returns null from loadModel() — the caller should fall back to keyword
 * scoring via scoreSkills().
 *
 * An optional second-pass model rescores with several skill views; its vectors
 * live in a separate file per model under "<view>|<abs-path>" keys, so the
 * first model's frequent cache reads stay small.
 *
 * Cache location: ~/.cache/opencode-triage/embeddings.json
 * Format: { "<abs-path>": { "mtime": 1718963200000, "embedding": [0.12, ...] } }
 */

import { join } from "node:path"
import { homedir } from "node:os"
import { readFile, writeFile, stat, mkdir } from "node:fs/promises"
import type { SkillEntry } from "./config.ts"
import { EMBEDDING_MODEL } from "./config.ts"

const CACHE_DIR = join(homedir(), ".cache", "opencode-triage")
const CACHE_FILE = join(CACHE_DIR, "embeddings.json")

function cacheFile(modelId: string): string {
  return modelId === EMBEDDING_MODEL ? CACHE_FILE : join(CACHE_DIR, `embeddings-${modelId.replace(/[^\w.-]+/g, "_")}.json`)
}

type EmbedCacheEntry = { mtime: number; model: string; text: string; embedding: number[] }
type EmbedDiskCache = Map<string, EmbedCacheEntry>

const _models = new Map<string, any>()
const _modelPromises = new Map<string, Promise<any | null>>()
const _loadErrors = new Map<string, string>()

async function loadModelRaw(modelId: string, localOnly: boolean): Promise<any> {
  const { pipeline } = await import("@huggingface/transformers")
  const opts: Record<string, unknown> = { cache_dir: join(CACHE_DIR, "models"), dtype: "q8" }
  if (localOnly) opts.local_files_only = true
  return pipeline("feature-extraction", modelId, opts)
}

/**
 * Loads an embedding model from local cache only (no network).
 * Returns null if not cached, deps missing, or initialization fails.
 */
export async function loadModel(modelId: string = EMBEDDING_MODEL): Promise<any | null> {
  const loaded = _models.get(modelId)
  if (loaded) return loaded
  let promise = _modelPromises.get(modelId)
  if (!promise) {
    promise = loadModelRaw(modelId, true).then(model => { _models.set(modelId, model); return model }).catch(error => {
      _loadErrors.set(modelId, error instanceof Error ? error.message : String(error))
      return null
    })
    _modelPromises.set(modelId, promise)
  }
  return promise
}

/**
 * Loads or downloads an embedding model (allows network).
 * Only used by the download-model CLI — never called at startup.
 */
export async function loadModelForDownload(modelId: string = EMBEDDING_MODEL): Promise<any> {
  return loadModelRaw(modelId, false)
}

export function getLoadError(modelId: string = EMBEDDING_MODEL): string | null {
  return _loadErrors.get(modelId) ?? null
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
  if (!a.length || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0
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

async function loadDiskCache(file: string): Promise<EmbedDiskCache> {
  try {
    const raw = await readFile(file, "utf-8")
    const obj = JSON.parse(raw) as Record<string, EmbedCacheEntry>
    return new Map(Object.entries(obj))
  } catch {
    return new Map()
  }
}

// Serializes read-merge-write cycles so concurrent computations never drop entries.
let _saveChain: Promise<void> = Promise.resolve()

function saveDiskCache(file: string, updates: EmbedDiskCache): Promise<void> {
  _saveChain = _saveChain.then(async () => {
    try {
      const cache = await loadDiskCache(file)
      for (const [k, v] of updates) cache.set(k, v)
      await mkdir(CACHE_DIR, { recursive: true })
      await writeFile(file, JSON.stringify(Object.fromEntries(cache)), "utf-8")
    } catch {
      // non-critical — cache will be rebuilt next time
    }
  })
  return _saveChain
}

function getSkillText(skill: SkillEntry): string {
  return `${skill.name}: ${skill.desc}`
}

export interface SkillView {
  id: string
  text: (skill: SkillEntry) => string
}

const BACKGROUND_YIELD_MS = 5

const PRIMARY_VIEW: SkillView = { id: "current", text: getSkillText }
const nameWords = (skill: SkillEntry) => skill.name.replace(/[-_]/g, " ")

/** Skill views rescored by the second-pass model; a skill's score is the best view. */
export const SECOND_PASS_VIEWS: SkillView[] = [
  { id: "desc", text: skill => skill.desc },
  { id: "words", text: nameWords },
  { id: "wordsDesc", text: skill => `${nameWords(skill)}: ${skill.desc}` },
]

function cacheKey(modelId: string, view: SkillView, path: string): string {
  // The primary model keeps its original path-only keys for cache compatibility.
  return modelId === EMBEDDING_MODEL && view.id === PRIMARY_VIEW.id ? path : `${view.id}|${path}`
}

/**
 * Returns one path-to-vector map per view, reusing disk-cached vectors whose
 * model, text and file mtime still match, and computing the rest.
 */
export async function getOrComputeViewEmbeddings(
  skills: SkillEntry[],
  model: any,
  modelId: string,
  views: SkillView[],
  signal?: { cancelled: boolean }
): Promise<Map<string, number[]>[]> {
  const file = cacheFile(modelId)
  const diskCache = await loadDiskCache(file)
  const results = views.map(() => new Map<string, number[]>())
  const dirty: Array<{ key: string; path: string; text: string; result: Map<string, number[]> }> = []

  for (const skill of skills) {
    let mtime = 0
    try {
      mtime = (await stat(skill.path)).mtimeMs
    } catch {
      // file gone — skip
    }
    views.forEach((view, i) => {
      const key = cacheKey(modelId, view, skill.path)
      const text = view.text(skill)
      const cached = diskCache.get(key)
      if (cached && cached.model === modelId && cached.text === text && cached.mtime === mtime) {
        results[i].set(skill.path, cached.embedding)
      } else {
        dirty.push({ key, path: skill.path, text, result: results[i] })
      }
    })
  }

  if (dirty.length > 0) {
    const updates: EmbedDiskCache = new Map()
    for (const { key, path, text, result } of dirty) {
      if (signal?.cancelled) break
      // Background builds yield between items so chat turns are not starved.
      if (signal) await new Promise(resolve => setTimeout(resolve, BACKGROUND_YIELD_MS))
      try {
        const embedding = await embed(model, text)
        result.set(path, embedding)
        let mtime = 0
        try {
          mtime = (await stat(path)).mtimeMs
        } catch {}
        updates.set(key, { mtime, model: modelId, text, embedding })
      } catch {
        // individual skill embedding failed — skip
      }
    }
    if (updates.size > 0) await saveDiskCache(file, updates)
  }

  return results
}

export async function getOrComputeEmbeddings(
  skills: SkillEntry[],
  model: any
): Promise<Map<string, number[]>> {
  const [vectors] = await getOrComputeViewEmbeddings(skills, model, EMBEDDING_MODEL, [PRIMARY_VIEW])
  return vectors
}

