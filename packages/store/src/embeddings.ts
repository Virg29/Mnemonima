import { decodeVector, encodeVector } from '@mnemonima/core'
import type { Db } from './db.js'

/**
 * Embedding cache — DESIGN.md 5, 6.5.
 *
 * Rows are keyed by `(space_id, text_hash)`, not by chunk id. Identical text in
 * two notes, or in the fine and coarse cut of the same note, is embedded once
 * and stored once. Because the hash covers the chunk *text* rather than its
 * position, editing one paragraph re-embeds one or two chunks even though every
 * later boundary shifted.
 *
 * Vectors are packed little-endian Float32 BLOBs, already L2-normalised.
 */

export interface EmbeddingEntry {
  readonly textHash: string
  readonly vector: Float32Array
}

export function hasEmbedding(db: Db, spaceId: string, textHash: string): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM embeddings WHERE space_id = ? AND text_hash = ?')
    .get(spaceId, textHash)
  return row !== undefined
}

/** Subset of `hashes` that is not cached yet, in input order and de-duplicated. */
export function missingHashes(db: Db, spaceId: string, hashes: readonly string[]): string[] {
  const check = db.prepare(
    'SELECT 1 AS present FROM embeddings WHERE space_id = ? AND text_hash = ?',
  )

  const seen = new Set<string>()
  const missing: string[] = []

  for (const hash of hashes) {
    if (seen.has(hash)) continue
    seen.add(hash)
    if (check.get(spaceId, hash) === undefined) missing.push(hash)
  }

  return missing
}

export function putEmbeddings(db: Db, spaceId: string, entries: readonly EmbeddingEntry[]): void {
  const insert = db.prepare(
    'INSERT INTO embeddings (space_id, text_hash, vec) VALUES (?, ?, ?)' +
      ' ON CONFLICT(space_id, text_hash) DO UPDATE SET vec = excluded.vec',
  )

  db.transaction(() => {
    for (const entry of entries) insert.run(spaceId, entry.textHash, encodeVector(entry.vector))
  })()
}

export function getEmbedding(
  db: Db,
  spaceId: string,
  textHash: string,
  dim: number,
): Float32Array | null {
  const row = db
    .prepare('SELECT vec FROM embeddings WHERE space_id = ? AND text_hash = ?')
    .get(spaceId, textHash) as { vec: Uint8Array } | undefined

  return row === undefined ? null : decodeVector(row.vec, dim)
}

export function countEmbeddings(db: Db, spaceId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM embeddings WHERE space_id = ?')
    .get(spaceId) as { n: number }
  return row.n
}

export interface ChunkVector {
  readonly chunkId: number
  readonly noteId: string
  readonly strategy: string
  readonly headingPath: string | null
  readonly kind: string
  readonly text: string
  readonly vector: Float32Array
}

/**
 * Every chunk of a space with its vector attached, for brute-force search.
 *
 * At the project's ceiling — 10k notes, two strategies, roughly 160k chunks —
 * this is about 250 MB of Float32 and a query is one pass of dot products
 * (DESIGN.md 8.7). An approximate index is not needed at that scale; when it
 * is, it replaces this function and nothing else.
 */
export function loadChunkVectors(db: Db, spaceId: string, dim: number): ChunkVector[] {
  const rows = db
    .prepare(
      'SELECT c.id, c.note_id, c.strategy, c.heading_path, c.kind, c.text, e.vec' +
        ' FROM chunks c JOIN embeddings e' +
        ' ON e.space_id = c.space_id AND e.text_hash = c.text_hash' +
        ' WHERE c.space_id = ?' +
        ' ORDER BY c.note_id, c.strategy, c.ord',
    )
    .all(spaceId) as {
    id: number
    note_id: string
    strategy: string
    heading_path: string | null
    kind: string
    text: string
    vec: Uint8Array
  }[]

  return rows.map((row) => ({
    chunkId: row.id,
    noteId: row.note_id,
    strategy: row.strategy,
    headingPath: row.heading_path,
    kind: row.kind,
    text: row.text,
    vector: decodeVector(row.vec, dim),
  }))
}

/**
 * Deletes cached vectors no chunk refers to any more. Safe to skip: an orphan
 * costs disk, never correctness, and it becomes a cache hit again if the same
 * text comes back.
 */
export function pruneOrphanEmbeddings(db: Db, spaceId: string): number {
  return db
    .prepare(
      'DELETE FROM embeddings WHERE space_id = ? AND text_hash NOT IN' +
        ' (SELECT text_hash FROM chunks WHERE space_id = ?)',
    )
    .run(spaceId, spaceId).changes
}
