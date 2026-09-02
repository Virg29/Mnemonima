import type { Db } from './db.js'

/**
 * Node positions on the graph — DESIGN.md 13.2.
 *
 * Presentational state, kept beside the notes rather than inside them: moving a
 * note on a picture is not an edit of the note, so it writes no revision and
 * changes no `rev`. An agent reading `history` should see what was written, not
 * who tidied the graph.
 *
 * A note with no row has never been placed, and that absence is the signal the
 * layout needs: everything stored is pinned, everything else is arranged around
 * it by the force-directed pass.
 */

export interface Position {
  readonly x: number
  readonly y: number
}

export interface PlacedNote extends Position {
  readonly noteId: string
  readonly updatedAt: number
}

interface RawRow {
  note_id: string
  x: number
  y: number
  updated_at: number
}

/** Every stored position, by note id. */
export function readLayout(db: Db): Map<string, Position> {
  const rows = db.prepare('SELECT * FROM note_layout').all() as RawRow[]

  return new Map(rows.map((row) => [row.note_id, { x: row.x, y: row.y }]))
}

export function listLayout(db: Db): PlacedNote[] {
  const rows = db.prepare('SELECT * FROM note_layout ORDER BY note_id').all() as RawRow[]

  return rows.map((row) => ({ noteId: row.note_id, x: row.x, y: row.y, updatedAt: row.updated_at }))
}

/**
 * Upserts the positions given, and only those.
 *
 * A partial write on purpose: the page sends what moved, not the whole picture,
 * so two windows on the same project each keep their own drags instead of the
 * slower one flattening the other's.
 *
 * A position for a note that does not exist is skipped rather than refused. The
 * page may be a few seconds behind a deletion, and losing one coordinate is not
 * worth failing a whole batch over.
 */
export function saveLayout(db: Db, positions: Iterable<PlacedNote | (Position & { noteId: string })>): number {
  const insert = db.prepare(
    'INSERT INTO note_layout (note_id, x, y, updated_at) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT(note_id) DO UPDATE SET x = excluded.x, y = excluded.y,' +
      ' updated_at = excluded.updated_at',
  )
  const exists = db.prepare('SELECT 1 FROM notes WHERE id = ?')

  let saved = 0
  const now = Date.now()

  db.transaction(() => {
    for (const position of positions) {
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) continue
      if (exists.get(position.noteId) === undefined) continue

      insert.run(position.noteId, position.x, position.y, now)
      saved += 1
    }
  })()

  return saved
}

/** Forgets the placements, so the next render arranges the graph from scratch. */
export function clearLayout(db: Db, noteIds?: readonly string[]): number {
  if (noteIds === undefined) {
    return db.prepare('DELETE FROM note_layout').run().changes
  }

  const remove = db.prepare('DELETE FROM note_layout WHERE note_id = ?')

  let removed = 0
  db.transaction(() => {
    for (const noteId of noteIds) removed += remove.run(noteId).changes
  })()

  return removed
}
