import type { Chunk, ChunkKind, ChunkSpec, ChunkStrategy } from '@mnemonima/core'
import type { Db } from './db.js'

/**
 * Chunk repository.
 *
 * One Orama document will be one chunk, and one note produces chunks under two
 * strategies at once (DESIGN.md 6.2). Chunks are always replaced per note and
 * per space rather than patched: recomputing them is cheap, and reconciling
 * shifted boundaries in place is not.
 */

interface ChunkRow {
  id: number
  space_id: string
  note_id: string
  strategy: string
  ord: number
  heading_path: string | null
  kind: string
  text: string
  text_hash: string
  tokens: number
}

function toChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    spaceId: row.space_id,
    noteId: row.note_id,
    strategy: row.strategy as ChunkStrategy,
    ord: row.ord,
    headingPath: row.heading_path,
    kind: row.kind as ChunkKind,
    text: row.text,
    textHash: row.text_hash,
    tokens: row.tokens,
  }
}

export function replaceNoteChunks(
  db: Db,
  spaceId: string,
  noteId: string,
  specs: readonly ChunkSpec[],
): void {
  const insert = db.prepare(
    'INSERT INTO chunks (space_id, note_id, strategy, ord, heading_path, kind, text, text_hash, tokens)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )

  db.transaction(() => {
    db.prepare('DELETE FROM chunks WHERE space_id = ? AND note_id = ?').run(spaceId, noteId)
    for (const spec of specs) {
      insert.run(
        spaceId,
        noteId,
        spec.strategy,
        spec.ord,
        spec.headingPath,
        spec.kind,
        spec.text,
        spec.textHash,
        spec.tokens,
      )
    }
  })()
}

export function deleteNoteChunks(db: Db, spaceId: string, noteId: string): number {
  return db.prepare('DELETE FROM chunks WHERE space_id = ? AND note_id = ?').run(spaceId, noteId)
    .changes
}

export function listNoteChunks(db: Db, spaceId: string, noteId: string): Chunk[] {
  const rows = db
    .prepare('SELECT * FROM chunks WHERE space_id = ? AND note_id = ? ORDER BY strategy, ord')
    .all(spaceId, noteId) as ChunkRow[]
  return rows.map(toChunk)
}

export function listSpaceChunks(db: Db, spaceId: string): Chunk[] {
  const rows = db
    .prepare('SELECT * FROM chunks WHERE space_id = ? ORDER BY note_id, strategy, ord')
    .all(spaceId) as ChunkRow[]
  return rows.map(toChunk)
}

export function countChunks(db: Db, spaceId?: string): number {
  const row =
    spaceId === undefined
      ? (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number })
      : (db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE space_id = ?').get(spaceId) as {
          n: number
        })
  return row.n
}

/** Note ids that have at least one chunk in this space. */
export function indexedNoteIds(db: Db, spaceId: string): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT note_id AS id FROM chunks WHERE space_id = ?')
    .all(spaceId) as { id: string }[]
  return new Set(rows.map((row) => row.id))
}
