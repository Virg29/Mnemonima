import { BadRequestError } from './errors.js'

/**
 * Vector helpers.
 *
 * Vectors are L2-normalised before they are stored, so similarity at query time
 * is a plain dot product rather than a full cosine (DESIGN.md 6.3). Storage is
 * a packed little-endian Float32 BLOB: 384 dimensions cost 1536 bytes, against
 * roughly 4 KB as JSON.
 */

export const FLOAT32_BYTES = 4

export function encodeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function decodeVector(blob: Uint8Array, dim: number): Float32Array {
  const expected = dim * FLOAT32_BYTES
  if (blob.byteLength !== expected) {
    throw new BadRequestError(
      `stored vector is ${blob.byteLength} bytes but the space expects ${expected} ` +
        `(${dim} dimensions)`,
      {
        details: { got: blob.byteLength, expected, dim },
        hint: 'the embedding space and the index disagree: run `mnemonima index --full`',
      },
    )
  }

  // Copy rather than view: a BLOB from SQLite carries no alignment guarantee,
  // and Float32Array requires a 4-byte aligned offset.
  const out = new Float32Array(dim)
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  for (let i = 0; i < dim; i += 1) out[i] = view.getFloat32(i * FLOAT32_BYTES, true)
  return out
}

export function l2Norm(vector: Float32Array): number {
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] ?? 0
    sum += value * value
  }
  return Math.sqrt(sum)
}

/** Returns a new normalised vector. A zero vector is returned unchanged. */
export function l2Normalize(vector: Float32Array): Float32Array {
  const norm = l2Norm(vector)
  if (norm === 0) return new Float32Array(vector)

  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] ?? 0) / norm
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new BadRequestError(`vector length mismatch: ${a.length} vs ${b.length}`, {
      details: { a: a.length, b: b.length },
    })
  }

  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/** Full cosine similarity. Prefer {@link dot} when both inputs are normalised. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const denominator = l2Norm(a) * l2Norm(b)
  return denominator === 0 ? 0 : dot(a, b) / denominator
}
