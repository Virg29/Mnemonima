import type { Db } from './db.js'

/**
 * The record of where an adopted note came from — DESIGN.md 14.1.
 *
 * Read by a second `adopt` over the same vault to decide whether a file is new,
 * unchanged, or an edit of a note that already exists.
 */

export interface AdoptedRow {
  readonly noteId: string
  readonly sourcePath: string
  readonly bodyHash: string
  readonly adoptedAt: number
}

interface RawRow {
  note_id: string
  source_path: string
  body_hash: string
  adopted_at: number
}

const toRow = (raw: RawRow): AdoptedRow => ({
  noteId: raw.note_id,
  sourcePath: raw.source_path,
  bodyHash: raw.body_hash,
  adoptedAt: raw.adopted_at,
})

/** Forward slashes, so the same vault adopted on two platforms is one vault. */
export function normaliseSourcePath(sourcePath: string): string {
  return sourcePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function recordAdopted(
  db: Db,
  noteId: string,
  sourcePath: string,
  bodyHash: string,
): AdoptedRow {
  const path = normaliseSourcePath(sourcePath)

  db.prepare(
    'INSERT INTO adopted (note_id, source_path, body_hash, adopted_at) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT(note_id) DO UPDATE SET source_path = excluded.source_path,' +
      ' body_hash = excluded.body_hash, adopted_at = excluded.adopted_at',
  ).run(noteId, path, bodyHash, Date.now())

  return requireAdopted(db, noteId)
}

export function requireAdopted(db: Db, noteId: string): AdoptedRow {
  return toRow(db.prepare('SELECT * FROM adopted WHERE note_id = ?').get(noteId) as RawRow)
}

export function adoptedByPath(db: Db): Map<string, AdoptedRow> {
  const rows = db.prepare('SELECT * FROM adopted').all() as RawRow[]

  const byPath = new Map<string, AdoptedRow>()
  for (const raw of rows) {
    const row = toRow(raw)
    byPath.set(row.sourcePath, row)
  }

  return byPath
}
