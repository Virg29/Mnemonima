import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, NotFoundError } from '@mnemonima/core'
import type { Db } from './db.js'
import {
  countNotes,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  listRevisions,
  requireNote,
  updateNote,
} from './notes.js'
import { createProject } from './project.js'
import { createSandbox } from './testing.js'
import type { Sandbox } from './testing.js'

describe('notes', () => {
  let sandbox: Sandbox
  let db: Db

  beforeEach(() => {
    sandbox = createSandbox()
    db = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') }).db
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const write = (title: string, body: string) =>
    createNote(db, { title, body, author: 'test' })

  it('allocates consecutive ids and starts at revision 1', () => {
    const first = write('Shaders', 'body')
    const second = write('Uniforms', 'body')

    expect(first.id).toBe('SL-0001')
    expect(second.id).toBe('SL-0002')
    expect(first.rev).toBe(1)
    expect(countNotes(db)).toBe(2)
  })

  it('accepts an explicit id and refuses a duplicate', () => {
    createNote(db, { id: 'SL-0100', title: 'Pinned', body: 'body', author: 'test' })

    expect(() =>
      createNote(db, { id: 'SL-0100', title: 'Again', body: 'body', author: 'test' }),
    ).toThrow(BadRequestError)
  })

  it('bumps the revision and the body hash on update', () => {
    const created = write('Shaders', 'first body')
    const updated = updateNote(db, created.id, { body: 'second body', author: 'test' })

    expect(updated.rev).toBe(2)
    expect(updated.bodyHash).not.toBe(created.bodyHash)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.createdAt)
  })

  it('rejects a write against a stale revision', () => {
    const created = write('Shaders', 'body')
    updateNote(db, created.id, { body: 'newer', author: 'other' })

    expect(() =>
      updateNote(db, created.id, { body: 'mine', author: 'test', expectedRev: created.rev }),
    ).toThrow(BadRequestError)
  })

  it('records a revision for every write, with its author', () => {
    const created = write('Shaders', 'body')
    updateNote(db, created.id, { body: 'v2', author: 'mcp:claude', batchId: 'batch-1' })
    updateNote(db, created.id, { body: 'v3', author: 'ui' })

    const revisions = listRevisions(db, created.id)

    expect(revisions.map((revision) => revision.rev)).toEqual([3, 2, 1])
    expect(revisions.map((revision) => revision.op)).toEqual(['update', 'update', 'create'])
    expect(revisions[1]?.author).toBe('mcp:claude')
    expect(revisions[1]?.batchId).toBe('batch-1')
  })

  it('keeps the old body in the revision log, which is what makes undo possible', () => {
    const created = write('Shaders', 'original')
    updateNote(db, created.id, { body: 'replacement', author: 'test' })

    const first = db
      .prepare('SELECT body FROM note_revisions WHERE note_id = ? AND rev = 1')
      .get(created.id) as { body: string }

    expect(first.body).toBe('original')
  })

  it('archives by default and keeps the row', () => {
    const created = write('Shaders', 'body')
    const archived = deleteNote(db, created.id, { author: 'test' })

    expect(archived.status).toBe('archived')
    expect(getNote(db, created.id)).not.toBeNull()
    expect(listNotes(db, { status: 'active' })).toHaveLength(0)
    expect(listNotes(db, { status: 'any' })).toHaveLength(1)
  })

  it('hard delete removes the row but keeps the audit trail', () => {
    const created = write('Shaders', 'body')
    deleteNote(db, created.id, { author: 'test', hard: true })

    expect(getNote(db, created.id)).toBeNull()
    expect(listRevisions(db, created.id).some((revision) => revision.op === 'delete')).toBe(true)
  })

  it('reports a missing note with a usable hint', () => {
    try {
      requireNote(db, 'SL-9999')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError)
      expect((error as NotFoundError).hint).toBeDefined()
    }
  })

  it('lists in id order and honours limit and offset', () => {
    write('A', 'body')
    write('B', 'body')
    write('C', 'body')

    expect(listNotes(db, { limit: 2 }).map((note) => note.id)).toEqual(['SL-0001', 'SL-0002'])
    expect(listNotes(db, { limit: 2, offset: 2 }).map((note) => note.id)).toEqual(['SL-0003'])
  })
})

describe('explicit note ids', () => {
  let sandbox: Sandbox
  let db: Db

  beforeEach(() => {
    sandbox = createSandbox()
    db = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'ids') }).db
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('rejects an id that is not in the PREFIX-NNNN shape', () => {
    for (const id of ['SL-1', 'sl-0001', 'SL0001', 'Shaders introduction']) {
      expect(() => createNote(db, { id, title: 'T', body: 'body', author: 'test' })).toThrow(
        BadRequestError,
      )
    }
  })

  it("rejects an id carrying another project's prefix", () => {
    try {
      createNote(db, { id: 'XX-0001', title: 'T', body: 'body', author: 'test' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).hint).toContain('SL-0001')
    }
  })

  it('moves the counter past an explicit id so the next automatic one is free', () => {
    createNote(db, { id: 'SL-0003', title: 'Pinned', body: 'body', author: 'test' })

    // Without the counter bump this allocated SL-0003 and failed on a duplicate,
    // breaking a later command that had nothing to do with the explicit id.
    const next = createNote(db, { title: 'Next', body: 'body', author: 'test' })
    expect(next.id).toBe('SL-0004')
  })

  it('leaves the counter alone for an id below it', () => {
    createNote(db, { title: 'One', body: 'body', author: 'test' })
    createNote(db, { title: 'Two', body: 'body', author: 'test' })
    createNote(db, { id: 'SL-0100', title: 'Far', body: 'body', author: 'test' })

    expect(createNote(db, { title: 'Next', body: 'body', author: 'test' }).id).toBe('SL-0101')
  })

  it('records archiving as a delete, not as an edit', () => {
    const created = createNote(db, { title: 'Shaders', body: 'body', author: 'test' })
    deleteNote(db, created.id, { author: 'mcp:claude' })

    const latest = listRevisions(db, created.id)[0]
    expect(latest?.op).toBe('delete')
    expect(latest?.author).toBe('mcp:claude')
  })
})
