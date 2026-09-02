import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundError } from '@mnemonima/core'
import { createNote, createProject, createSandbox, updateNote } from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { diffRevisions, readRevision } from './revisions.js'

describe('reading and comparing revisions', () => {
  let sandbox: Sandbox
  let db: Db
  let id: string

  beforeEach(() => {
    sandbox = createSandbox()
    db = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') }).db

    id = createNote(db, {
      title: 'Shaders',
      body: '# Shaders\n\nOne.\n',
      author: 'test',
    }).id

    updateNote(db, id, { body: '# Shaders\n\nOne.\nTwo.\n', author: 'test' })
    updateNote(db, id, { body: '# Shaders\n\nOne.\nTwo.\nThree.\n', author: 'test' })
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('reads an old body back without changing anything', () => {
    // The gap this closes: before it, the only route to an old body was
    // `revert`, so looking meant editing.
    const first = readRevision(db, id, 1)

    expect(first.body).toBe('# Shaders\n\nOne.\n')
    expect(readRevision(db, id).body).toBe('# Shaders\n\nOne.\nTwo.\nThree.\n')
  })

  it('reads the note as it stands for revision 0', () => {
    const now = readRevision(db, id, 0)

    expect(now.rev).toBeNull()
    expect(now.body).toBe('# Shaders\n\nOne.\nTwo.\nThree.\n')
  })

  it('refuses a revision that does not exist, and says which do', () => {
    try {
      readRevision(db, id, 99)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError)
      expect((error as NotFoundError).hint).toContain('1, 2, 3')
    }
  })

  it('compares two revisions', () => {
    const result = diffRevisions(db, id, { from: 1, to: 3 })

    expect(result.diff.added).toBe(2)
    expect(result.diff.removed).toBe(0)
  })

  it('answers "what was the last edit" when neither end is given', () => {
    const result = diffRevisions(db, id)

    expect(result.from.rev).toBe(2)
    expect(result.to.rev).toBeNull()
    expect(result.diff.added).toBe(1)
  })

  it('compares a revision with the note as it stands', () => {
    updateNote(db, id, { body: '# Shaders\n\nRewritten.\n', author: 'test' })

    const result = diffRevisions(db, id, { from: 1 })

    expect(result.to.rev).toBeNull()
    expect(result.diff.identical).toBe(false)
  })

  it('has nothing to compare the first revision with, and says so', () => {
    const other = createNote(db, { title: 'Uniforms', body: 'Body.', author: 'test' }).id

    expect(() => diffRevisions(db, other)).toThrow(NotFoundError)
  })

  it('reports no change between a revision and itself', () => {
    expect(diffRevisions(db, id, { from: 2, to: 2 }).diff.identical).toBe(true)
  })
})
