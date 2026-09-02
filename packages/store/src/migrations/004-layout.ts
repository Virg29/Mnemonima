import type { Migration } from '../migrate.js'

/**
 * Where a note sits on the graph — DESIGN.md 13.2.
 *
 * The layout was recomputed on every render: seed positions from a hash of the
 * id, then force-directed settling. Reproducible, and worth nothing to anybody
 * who had arranged the graph by hand — a drag survived until the next screen
 * change, and creating a link threw it away at the moment it was being used.
 *
 * A table of its own rather than columns on `notes`, for two reasons. A
 * position is not part of a note: it says nothing that would survive an export
 * to markdown, and it must not produce a revision, or an agent's session log
 * would fill with somebody tidying the picture. And a note that has never been
 * moved has no row, which is what tells the layout to place it rather than
 * pin it.
 */
const SQL = `
CREATE TABLE note_layout (
  note_id    TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const migration004: Migration = {
  version: 4,
  name: 'layout',
  up: (db) => {
    db.exec(SQL)
  },
}
