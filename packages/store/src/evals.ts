import type { Db } from './db.js'

/**
 * The eval run log — DESIGN.md 9.
 *
 * One row per run, so the UI can answer "did that change help" rather than only
 * "how is it now". The configuration is stored alongside, because a metric
 * without the weights that produced it cannot be reproduced or argued with.
 */

export interface EvalRunInput {
  readonly spaceId: string | null
  readonly queries: number
  readonly recallK: number
  readonly ndcgK: number
  readonly recall: number
  readonly mrr: number
  readonly ndcg: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly config: unknown
  readonly metrics: unknown
  readonly note: string | null
}

export interface EvalRunRow extends Omit<EvalRunInput, 'config' | 'metrics'> {
  readonly id: number
  readonly createdAt: number
  readonly config: unknown
  readonly metrics: unknown
}

interface RawRow {
  id: number
  space_id: string | null
  queries: number
  recall_k: number
  ndcg_k: number
  recall: number
  mrr: number
  ndcg: number
  p50_ms: number
  p95_ms: number
  config_json: string
  metrics_json: string
  note: string | null
  created_at: number
}

function toRow(raw: RawRow): EvalRunRow {
  return {
    id: raw.id,
    spaceId: raw.space_id,
    queries: raw.queries,
    recallK: raw.recall_k,
    ndcgK: raw.ndcg_k,
    recall: raw.recall,
    mrr: raw.mrr,
    ndcg: raw.ndcg,
    p50Ms: raw.p50_ms,
    p95Ms: raw.p95_ms,
    config: JSON.parse(raw.config_json),
    metrics: JSON.parse(raw.metrics_json),
    note: raw.note,
    createdAt: raw.created_at,
  }
}

export function recordEvalRun(db: Db, input: EvalRunInput): EvalRunRow {
  const createdAt = Date.now()

  const result = db
    .prepare(
      'INSERT INTO eval_runs (space_id, queries, recall_k, ndcg_k, recall, mrr, ndcg,' +
        ' p50_ms, p95_ms, config_json, metrics_json, note, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.spaceId,
      input.queries,
      input.recallK,
      input.ndcgK,
      input.recall,
      input.mrr,
      input.ndcg,
      Math.round(input.p50Ms),
      Math.round(input.p95Ms),
      JSON.stringify(input.config),
      JSON.stringify(input.metrics),
      input.note,
      createdAt,
    )

  return requireEvalRun(db, Number(result.lastInsertRowid))
}

export function requireEvalRun(db: Db, id: number): EvalRunRow {
  const raw = db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as RawRow
  return toRow(raw)
}

/** Newest first, which is the order the question "did that help" is asked in. */
export function listEvalRuns(db: Db, limit = 20): EvalRunRow[] {
  const rows = db
    .prepare('SELECT * FROM eval_runs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as RawRow[]

  return rows.map(toRow)
}
