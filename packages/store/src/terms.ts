import { BadRequestError } from '@mnemonima/core'
import type { Term, TermKind, TermSource } from '@mnemonima/core'
import type { Db } from './db.js'

/**
 * Term repository — DESIGN.md 7.2.
 *
 * The project vocabulary is one table shared by two sources. Terms an extractor
 * proposed carry `source = 'auto'` and can be replaced on the next index run;
 * terms the operator entered carry `source = 'manual'`, are pinned, and are
 * never pruned or outranked by a guess.
 *
 * `blocked` is the other half of the same idea: a term the operator has decided
 * is noise stays out of every future extraction without having to be argued
 * with again.
 */

interface TermRow {
  id: number
  term: string
  lemma: string
  source: string
  pinned: number
  blocked: number
  weight: number
  df: number
  created_at: number
}

function toTerm(row: TermRow): Term {
  return {
    id: row.id,
    term: row.term,
    lemma: row.lemma,
    source: row.source as TermSource,
    pinned: row.pinned === 1,
    blocked: row.blocked === 1,
    weight: row.weight,
    df: row.df,
    createdAt: row.created_at,
  }
}

export interface UpsertTermInput {
  readonly term: string
  readonly lemma: string
  readonly source: TermSource
  readonly pinned?: boolean
  readonly blocked?: boolean
  readonly weight?: number
}

/**
 * Inserts or updates a term and returns its id.
 *
 * A manual entry promotes an existing automatic one rather than duplicating it:
 * the operator confirming what an extractor guessed is exactly the promotion the
 * design describes, and it must not create a second row.
 */
export function upsertTerm(db: Db, input: UpsertTermInput): number {
  const term = input.term.trim()
  if (term === '') {
    throw new BadRequestError('term must not be empty', {
      details: {},
      hint: 'give the word or phrase you want the project to know about',
    })
  }

  const existing = db.prepare('SELECT * FROM terms WHERE term = ?').get(term) as
    | TermRow
    | undefined

  if (existing === undefined) {
    const result = db
      .prepare(
        'INSERT INTO terms (term, lemma, source, pinned, blocked, weight, df, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      )
      .run(
        term,
        input.lemma,
        input.source,
        input.pinned === true || input.source === 'manual' ? 1 : 0,
        input.blocked === true ? 1 : 0,
        input.weight ?? 1,
        Date.now(),
      )

    return Number(result.lastInsertRowid)
  }

  const promoted = input.source === 'manual' || existing.source === 'manual'

  db.prepare('UPDATE terms SET lemma = ?, source = ?, pinned = ?, blocked = ?, weight = ? WHERE id = ?').run(
    input.lemma,
    promoted ? 'manual' : existing.source,
    input.pinned === true || promoted ? 1 : existing.pinned,
    input.blocked === true ? 1 : existing.blocked,
    input.weight ?? existing.weight,
    existing.id,
  )

  return existing.id
}

export interface NoteTermInput {
  readonly term: string
  readonly lemma: string
  readonly kind: TermKind
  readonly score: number
  readonly source: TermSource
}

/** Replaces the terms of one note. Automatic terms are derived, so never patched. */
export function setNoteTerms(db: Db, noteId: string, entries: readonly NoteTermInput[]): void {
  const link = db.prepare(
    'INSERT INTO note_terms (note_id, term_id, kind, score, source) VALUES (?, ?, ?, ?, ?)' +
      ' ON CONFLICT(note_id, term_id) DO UPDATE SET' +
      ' kind = excluded.kind, score = excluded.score, source = excluded.source',
  )

  db.transaction(() => {
    db.prepare('DELETE FROM note_terms WHERE note_id = ?').run(noteId)
    for (const entry of entries) {
      const termId = upsertTerm(db, { term: entry.term, lemma: entry.lemma, source: entry.source })
      link.run(noteId, termId, entry.kind, entry.score, entry.source)
    }
  })()
}

export interface ListTermsOptions {
  readonly source?: TermSource | 'any'
  readonly includeBlocked?: boolean
  readonly limit?: number
}

export function listTerms(db: Db, options: ListTermsOptions = {}): Term[] {
  const source = options.source ?? 'any'
  const clauses: string[] = []
  const params: unknown[] = []

  if (source !== 'any') {
    clauses.push('source = ?')
    params.push(source)
  }
  if (options.includeBlocked !== true) clauses.push('blocked = 0')

  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  const rows = db
    .prepare(`SELECT * FROM terms ${where} ORDER BY df DESC, term LIMIT ?`)
    .all(...params, options.limit ?? 200) as TermRow[]

  return rows.map(toTerm)
}

export function findTerm(db: Db, term: string): Term | null {
  const row = db.prepare('SELECT * FROM terms WHERE term = ?').get(term.trim()) as
    | TermRow
    | undefined
  return row === undefined ? null : toTerm(row)
}

export function requireTerm(db: Db, term: string): Term {
  const found = findTerm(db, term)
  if (found !== null) return found

  throw new BadRequestError(`this project has no term "${term}"`, {
    details: { term },
    hint: 'run `mnemonima terms list` to see the vocabulary, or add it with `terms add`',
  })
}

export function setTermFlags(
  db: Db,
  term: string,
  flags: { pinned?: boolean; blocked?: boolean; weight?: number },
): Term {
  const current = requireTerm(db, term)

  db.prepare('UPDATE terms SET pinned = ?, blocked = ?, weight = ? WHERE id = ?').run(
    flags.pinned === undefined ? (current.pinned ? 1 : 0) : flags.pinned ? 1 : 0,
    flags.blocked === undefined ? (current.blocked ? 1 : 0) : flags.blocked ? 1 : 0,
    flags.weight ?? current.weight,
    current.id,
  )

  return requireTerm(db, term)
}

export function deleteTerm(db: Db, term: string): number {
  return db.prepare('DELETE FROM terms WHERE term = ?').run(term.trim()).changes
}

/** Terms the operator has ruled out; extraction skips them for good. */
export function blockedLemmas(db: Db): Set<string> {
  const rows = db.prepare('SELECT lemma FROM terms WHERE blocked = 1').all() as { lemma: string }[]
  return new Set(rows.map((row) => row.lemma))
}

/** The gazetteer: manual terms, matched literally in every note body. */
export function manualTerms(db: Db): Term[] {
  const rows = db
    .prepare("SELECT * FROM terms WHERE source = 'manual' AND blocked = 0 ORDER BY LENGTH(term) DESC")
    .all() as TermRow[]
  return rows.map(toTerm)
}

/** Refreshes `df` from what the notes actually carry. */
export function recomputeTermFrequencies(db: Db): void {
  db.prepare(
    'UPDATE terms SET df = (SELECT COUNT(DISTINCT note_id) FROM note_terms WHERE term_id = terms.id)',
  ).run()
}

export interface PromotionCandidate {
  readonly term: string
  readonly lemma: string
  readonly df: number
  readonly bestScore: number
}

/**
 * Automatic terms that have earned a look: frequent enough across the project
 * and confident enough on at least one note. Promotion itself stays manual —
 * the operator pins or blocks them.
 */
export function promotionCandidates(
  db: Db,
  minDf: number,
  minScore: number,
  limit = 50,
): PromotionCandidate[] {
  const rows = db
    .prepare(
      'SELECT t.term, t.lemma, t.df, MAX(nt.score) AS best FROM terms t' +
        ' JOIN note_terms nt ON nt.term_id = t.id' +
        " WHERE t.source = 'auto' AND t.blocked = 0 AND t.pinned = 0 AND t.df >= ?" +
        ' GROUP BY t.id HAVING best >= ? ORDER BY t.df DESC, best DESC LIMIT ?',
    )
    .all(minDf, minScore, limit) as { term: string; lemma: string; df: number; best: number }[]

  return rows.map((row) => ({ term: row.term, lemma: row.lemma, df: row.df, bestScore: row.best }))
}

/** Terms of one note, highest score first, for `get` and the UI. */
export function noteTerms(db: Db, noteId: string): (Term & { kind: TermKind; score: number })[] {
  const rows = db
    .prepare(
      'SELECT t.*, nt.kind AS nt_kind, nt.score AS nt_score FROM note_terms nt' +
        ' JOIN terms t ON t.id = nt.term_id WHERE nt.note_id = ?' +
        ' ORDER BY nt.score DESC, t.term',
    )
    .all(noteId) as (TermRow & { nt_kind: TermKind; nt_score: number })[]

  return rows.map((row) => ({ ...toTerm(row), kind: row.nt_kind, score: row.nt_score }))
}

export function countTerms(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM terms').get() as { n: number }
  return row.n
}

/**
 * Attaches one term to a note without disturbing the rest.
 *
 * `setNoteTerms` replaces everything, which is right for an extraction pass and
 * wrong for an import: a term promoted since the export must not be dropped
 * because an older file did not list it.
 */
export function addNoteTerm(db: Db, noteId: string, entry: NoteTermInput): void {
  db.transaction(() => {
    const termId = upsertTerm(db, { term: entry.term, lemma: entry.lemma, source: entry.source })
    db.prepare(
      'INSERT INTO note_terms (note_id, term_id, kind, score, source) VALUES (?, ?, ?, ?, ?)' +
        ' ON CONFLICT(note_id, term_id) DO UPDATE SET' +
        ' kind = excluded.kind, score = excluded.score, source = excluded.source',
    ).run(noteId, termId, entry.kind, entry.score, entry.source)
  })()
}
