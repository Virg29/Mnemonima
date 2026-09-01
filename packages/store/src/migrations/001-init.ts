import type { Migration } from '../migrate.js'

/**
 * Initial schema — DESIGN.md 3.1.
 *
 * SQLite is the source of truth: note bodies, metadata, chunks, vectors,
 * terms and revisions all live here. Orama is hydrated from it at daemon start.
 */
const SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  body_hash  TEXT NOT NULL,
  outline    TEXT,
  lang       TEXT NOT NULL DEFAULT 'en',
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'draft', 'archived')),
  rev        INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_status ON notes(status);
CREATE INDEX idx_notes_updated ON notes(updated_at);

CREATE TABLE aliases (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  alias   TEXT NOT NULL,
  source  TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  PRIMARY KEY (note_id, alias)
);
CREATE INDEX idx_aliases_alias ON aliases(alias);

CREATE TABLE tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tag);

-- dst has no foreign key on purpose: a link to a note that does not exist is
-- preserved exactly as written (DESIGN.md 3.4).
CREATE TABLE links (
  src      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  dst      TEXT NOT NULL,
  anchor   TEXT NOT NULL DEFAULT '',
  heading  TEXT,
  kind     TEXT NOT NULL CHECK (kind IN ('wikilink', 'mdlink', 'manual')),
  resolved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (src, dst, anchor)
);
CREATE INDEX idx_links_dst ON links(dst);

CREATE TABLE terms (
  id         INTEGER PRIMARY KEY,
  term       TEXT NOT NULL UNIQUE,
  lemma      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
  pinned     INTEGER NOT NULL DEFAULT 0,
  blocked    INTEGER NOT NULL DEFAULT 0,
  weight     REAL NOT NULL DEFAULT 1.0,
  df         INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_terms_lemma ON terms(lemma);

CREATE TABLE note_terms (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('keyword', 'phrase')),
  score   REAL NOT NULL,
  source  TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
  PRIMARY KEY (note_id, term_id)
);
CREATE INDEX idx_note_terms_term ON note_terms(term_id);

-- An embedding space is addressed by the hash of everything that invalidates
-- it: model, dimensions, prefixes, normalization, chunker version, strategies.
CREATE TABLE spaces (
  id              TEXT PRIMARY KEY,
  model           TEXT NOT NULL,
  dim             INTEGER NOT NULL,
  chunker_version TEXT NOT NULL,
  config_json     TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  strategy     TEXT NOT NULL CHECK (strategy IN ('fine', 'coarse')),
  ord          INTEGER NOT NULL,
  heading_path TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('prose', 'code')),
  text         TEXT NOT NULL,
  text_hash    TEXT NOT NULL,
  tokens       INTEGER NOT NULL
);
CREATE INDEX idx_chunks_note ON chunks(space_id, note_id);
CREATE INDEX idx_chunks_hash ON chunks(space_id, text_hash);

-- Keyed by (space, text_hash) rather than chunk id: identical text across notes
-- and across chunking strategies is embedded once and stored once.
CREATE TABLE embeddings (
  space_id  TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  text_hash TEXT NOT NULL,
  vec       BLOB NOT NULL,
  PRIMARY KEY (space_id, text_hash)
);

-- Every write creates a revision. Mandatory because the MCP server has full
-- write access (DESIGN.md 10.3): batch_id makes a whole agent session undoable.
CREATE TABLE note_revisions (
  note_id    TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  op         TEXT NOT NULL
             CHECK (op IN ('create', 'update', 'delete', 'import', 'adopt')),
  author     TEXT NOT NULL,
  batch_id   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, rev)
);
CREATE INDEX idx_revisions_batch ON note_revisions(batch_id);
CREATE INDEX idx_revisions_created ON note_revisions(created_at);

CREATE TABLE orama_snapshots (
  space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('notes', 'chunks')),
  index_version TEXT NOT NULL,
  blob          BLOB NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (space_id, kind)
);
`

export const migration001: Migration = {
  version: 1,
  name: 'init',
  up(db) {
    db.exec(SQL)
  },
}
