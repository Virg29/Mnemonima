import { createHash } from 'node:crypto'

/**
 * Content hashing. Two rules the rest of the system depends on:
 *
 *  - `hashText` is what keys the embedding cache. It hashes the *text of a
 *    chunk*, never its position, so editing one paragraph re-embeds one or two
 *    chunks even when every later chunk boundary shifts (DESIGN.md 6.5).
 *  - Hashing is stable across platforms: line endings are normalised first, so
 *    a note written on Windows and one written on Linux hash identically.
 */

export function normaliseText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Hash of a chunk's embedding input. Keys the `embeddings` table. */
export function hashText(text: string): string {
  return sha256(normaliseText(text))
}

/** Hash of a note body. Detects whether a note changed at all. */
export function hashBody(body: string): string {
  return sha256(normaliseText(body))
}

/**
 * Order-independent hash of a plain object. Used to derive embedding space ids
 * so that reordering keys in a config never invents a new space.
 */
export function hashObject(value: unknown): string {
  return sha256(stableStringify(value))
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)

  return `{${entries.join(',')}}`
}
