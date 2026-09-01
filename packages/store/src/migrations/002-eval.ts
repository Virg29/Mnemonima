import type { Migration } from '../migrate.js'

/**
 * Eval run history — DESIGN.md 9.
 *
 * Kept in the project database rather than beside the golden set, because the
 * question it answers is "did that change help", and the answer is only
 * meaningful next to the configuration and the space it was measured against.
 * A file of numbers with no record of what produced them is a file of numbers.
 *
 * `metrics_json` rather than a column per metric: stage 10 may add a
 * cross-encoder and with it a fourth, and widening a table for every metric
 * anyone ever wants is how a schema becomes a museum. The three that matter are
 * columns as well, so history can be ordered and compared without parsing.
 */
const SQL = `
CREATE TABLE eval_runs (
  id           INTEGER PRIMARY KEY,
  space_id     TEXT,
  queries      INTEGER NOT NULL,
  recall_k     INTEGER NOT NULL,
  ndcg_k       INTEGER NOT NULL,
  recall       REAL NOT NULL,
  mrr          REAL NOT NULL,
  ndcg         REAL NOT NULL,
  p50_ms       INTEGER NOT NULL,
  p95_ms       INTEGER NOT NULL,
  -- The weights this run was measured with, so a number can be reproduced.
  config_json  TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_eval_runs_created ON eval_runs(created_at DESC);
`

export const migration002: Migration = {
  version: 2,
  name: 'eval',
  up: (db) => {
    db.exec(SQL)
  },
}
