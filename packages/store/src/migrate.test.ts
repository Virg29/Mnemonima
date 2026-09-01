import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MnemonimaError } from '@mnemonima/core'
import { openDatabase } from './db.js'
import type { Db } from './db.js'
import { latestSchemaVersion, migrate, schemaVersion } from './migrate.js'
import { createSandbox } from './testing.js'
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
    expect(result.applied).toEqual(['1-init'])
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
