import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MnemonimaError } from '@mnemonima/core'
import { openDatabase } from './db.js'
import type { Db } from './db.js'
import { latestSchemaVersion, migrate, schemaVersion } from './migrate.js'
import { createSandbox } from './testing.js'
import { listEvalRuns, recordEvalRun } from './evals.js'
import type { EvalRunRow } from './evals.js'
import type { Sandbox } from './testing.js'

describe('migrations', () => {
  let sandbox: Sandbox
  let db: Db

  beforeEach(() => {
    sandbox = createSandbox()
    db = openDatabase(path.join(sandbox.projects, 'migrate', 'mnemonima.db'))
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('starts at version 0', () => {
    expect(schemaVersion(db)).toBe(0)
  })

  it('applies every migration and records the version', () => {
    const result = migrate(db)

    expect(result.from).toBe(0)
    expect(result.to).toBe(latestSchemaVersion())
    // Named rather than counted, so adding one is a deliberate edit here and
    // an accidental reordering fails instead of passing quietly.
    expect(result.applied).toEqual(['1-init', '2-eval', '3-adopt', '4-layout'])
    expect(schemaVersion(db)).toBe(latestSchemaVersion())
  })

  it('creates the full schema', () => {
    migrate(db)

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((row) => row.name)

    for (const table of [
      'meta',
      'notes',
      'aliases',
      'tags',
      'links',
      'terms',
      'note_terms',
      'spaces',
      'chunks',
      'embeddings',
      'note_revisions',
      'orama_snapshots',
    ]) {
      expect(tables).toContain(table)
    }
  })

  it('is idempotent', () => {
    migrate(db)
    const second = migrate(db)

    expect(second.applied).toEqual([])
    expect(second.from).toBe(latestSchemaVersion())
  })

  it('refuses a database written by a newer build', () => {
    migrate(db)
    db.pragma(`user_version = ${latestSchemaVersion() + 1}`)

    expect(() => migrate(db)).toThrow(MnemonimaError)
  })

  it('enforces foreign keys and the status check constraint', () => {
    migrate(db)

    expect(() =>
      db
        .prepare(
          'INSERT INTO aliases (note_id, alias, source) VALUES (?, ?, ?)',
        )
        .run('SL-0001', 'ghost', 'manual'),
    ).toThrow()

    const now = Date.now()
    db.prepare(
      'INSERT INTO notes (id, title, body, body_hash, lang, status, rev, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('SL-0001', 'Shaders', 'body', 'hash', 'en', 'active', 1, now, now)

    expect(() =>
      db
        .prepare(
          'INSERT INTO notes (id, title, body, body_hash, lang, status, rev, created_at, updated_at)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('SL-0002', 'Bad', 'body', 'hash', 'en', 'nonsense', 1, now, now),
    ).toThrow()
  })

  it('keeps dangling links: dst has no foreign key', () => {
    migrate(db)

    const now = Date.now()
    db.prepare(
      'INSERT INTO notes (id, title, body, body_hash, lang, status, rev, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('SL-0001', 'Shaders', 'body', 'hash', 'en', 'active', 1, now, now)

    expect(() =>
      db
        .prepare('INSERT INTO links (src, dst, anchor, kind, resolved) VALUES (?, ?, ?, ?, ?)')
        .run('SL-0001', 'EXTERNAL-9999', '', 'wikilink', 0),
    ).not.toThrow()
  })
})

describe('the eval run log', () => {
  let sandbox: Sandbox
  let db: Db

  beforeEach(() => {
    sandbox = createSandbox()
    db = openDatabase(path.join(sandbox.projects, 'runs.db'))
    migrate(db)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const run = (ndcg: number, note: string | null = null): EvalRunRow =>
    recordEvalRun(db, {
      spaceId: 'space-1',
      queries: 24,
      recallK: 5,
      ndcgK: 10,
      recall: 0.8,
      mrr: 0.7,
      ndcg,
      p50Ms: 31.4,
      p95Ms: 88.6,
      config: { search: { hybridWeights: { text: 0.5, vector: 0.5 } } },
      metrics: { negatives: 0 },
      note,
    })

  it('keeps the configuration that produced the numbers', () => {
    // A metric without the weights behind it cannot be reproduced or argued
    // with, which is the only thing a history is for.
    const row = run(0.64, 'baseline')

    expect(row.ndcg).toBe(0.64)
    expect(row.note).toBe('baseline')
    expect((row.config as { search: { hybridWeights: { text: number } } }).search.hybridWeights.text)
      .toBe(0.5)
  })

  it('rounds latency to whole milliseconds', () => {
    expect(run(0.5).p50Ms).toBe(31)
    expect(run(0.5).p95Ms).toBe(89)
  })

  it('lists newest first, which is how the question is asked', () => {
    run(0.60, 'before')
    run(0.71, 'after')

    const rows = listEvalRuns(db, 10)
    expect(rows.map((row) => row.note)).toEqual(['after', 'before'])
  })

  it('honours the limit', () => {
    for (let index = 0; index < 5; index += 1) run(0.5)
    expect(listEvalRuns(db, 2)).toHaveLength(2)
  })
})
