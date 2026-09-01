import type { Migration } from '../migrate.js'

/**
 * Where an adopted note came from — DESIGN.md 14.1, point 7.
 *
 * `adopt` has to be idempotent: running it twice over the same vault must
 * update the notes it made rather than make them again. Matching on the body
 * alone cannot do that — an edited file has a different body and is still the
 * same file — and matching on the title cannot either, because two vaults
 * happily contain two "README".
 *
 * So the source path is remembered. It is the only durable identity a foreign
 * file has, and it is kept out of `aliases` on purpose: an alias is a name the
 * note answers to in search, and `docs/mechanics/aspects.md` is not one.
 */
const SQL = `
CREATE TABLE adopted (
  note_id     TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  -- Relative to the adopted root, with forward slashes, so a vault adopted on
  -- Windows and again on Linux is the same vault.
  source_path TEXT NOT NULL,
  body_hash   TEXT NOT NULL,
  adopted_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_adopted_path ON adopted(source_path);
`

export const migration003: Migration = {
  version: 3,
  name: 'adopt',
  up: (db) => {
    db.exec(SQL)
  },
}
