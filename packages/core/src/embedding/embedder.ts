import type { TokenCounter } from '../chunking.js'
import { l2Normalize } from '../vector.js'
import type { ModelDescriptor } from './models.js'

export interface EmbedProgress {
  readonly done: number
  readonly total: number
}

export type ProgressCallback = (progress: EmbedProgress) => void

/**
 * Everything that turns text into vectors sits behind this interface, so the
 * indexer never knows whether it is talking to ONNX, to a worker pool, or to
 * the deterministic stand-in used by tests.
 */
export interface Embedder {
  readonly model: ModelDescriptor
  /** Token counter matching the model's own tokenizer. */
  readonly counter: TokenCounter
  embedDocuments(texts: readonly string[], onProgress?: ProgressCallback): Promise<Float32Array[]>
  embedQuery(text: string): Promise<Float32Array>
  dispose(): Promise<void>
}

/**
 * A hashing vectoriser: bag of words hashed into `dim` buckets, then L2
 * normalised. It is not a semantic model, but it is *lexically* meaningful —
 * texts sharing words end up close — which makes the whole index-and-search
 * path testable offline and deterministically.
 *
 * Selecting it for real content is allowed but pointless; `models list` marks
 * it as such.
 */
export class DeterministicEmbedder implements Embedder {
  readonly model: ModelDescriptor
  readonly counter: TokenCounter

  constructor(model: ModelDescriptor) {
    this.model = model
    this.counter = {
      count: (text: string) => Math.max(1, tokenize(text).length),
    }
  }

  embedDocuments(
    texts: readonly string[],
    onProgress?: ProgressCallback,
  ): Promise<Float32Array[]> {
    const out = texts.map((text) => this.#embed(text))
    onProgress?.({ done: texts.length, total: texts.length })
    return Promise.resolve(out)
  }

  embedQuery(text: string): Promise<Float32Array> {
    return Promise.resolve(this.#embed(text))
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }

  #embed(text: string): Float32Array {
    const vector = new Float32Array(this.model.dim)

    for (const token of tokenize(text)) {
      const bucket = fnv1a(token) % this.model.dim
      vector[bucket] = (vector[bucket] ?? 0) + 1
      // A second, differently seeded bucket reduces collision damage.
      const echo = fnv1a(`~${token}`) % this.model.dim
      vector[echo] = (vector[echo] ?? 0) + 0.5
    }

    return l2Normalize(vector)
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '')
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}
