import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, NotFoundError, TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  createProject,
  createSandbox,
  getConfig,
  getNote,
  listBatches,
  listRevisions,
  outgoingLinks,
  requireNote,
  setConfig,
} from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { revertNote, undoBatch, newBatchId } from './undo.js'
import { writeNewNote, writeNoteBody } from './notes.js'

describe('revert', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig

  beforeEach(() => {
    sandbox = createSandbox()
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('restores an earlier body as a new revision', () => {
    const id = writeNewNote(db, config, '# One\n\nFirst body.\n', { author: 'test' }).note.id
    writeNoteBody(db, config, id, '# One\n\nSecond body.\n', { author: 'test' })

    const result = revertNote(db, config, id, 1, 'test')

    expect(result).toMatchObject({ noteId: id, fromRev: 2, toRev: 1, newRev: 3 })
    expect(requireNote(db, id).body).toContain('First body')
    // History is never rewritten; the revert is just another entry.
    expect(listRevisions(db, id).map((entry) => entry.rev)).toEqual([3, 2, 1])
  })

  it('rebuilds the links of the restored body', () => {
    writeNewNote(db, config, '# Target\n\nBody.\n', { author: 'test' })
    const id = writeNewNote(db, config, '# Source\n\nSee [[SL-0001]].\n', { author: 'test' }).note.id

    writeNoteBody(db, config, id, '# Source\n\nNo links now.\n', { author: 'test' })
    expect(outgoingLinks(db, id)).toEqual([])

    revertNote(db, config, id, 1, 'test')
    expect(outgoingLinks(db, id).map((link) => link.dst)).toEqual(['SL-0001'])
  })

  it('refuses a revision that does not exist, and says which do', () => {
    const id = writeNewNote(db, config, '# One\n\nBody.\n', { author: 'test' }).note.id

    try {
      revertNote(db, config, id, 9, 'test')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError)
      expect((error as NotFoundError).hint).toContain('1')
    }
  })

  it('refuses to revert to the revision it is already at', () => {
    const id = writeNewNote(db, config, '# One\n\nBody.\n', { author: 'test' }).note.id
    expect(() => revertNote(db, config, id, 1, 'test')).toThrow(BadRequestError)
  })
})

describe('undo a batch', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig

  beforeEach(() => {
    sandbox = createSandbox()
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const batch = 'mcp-20260101T000000-abc123'

  it('puts an edited note back to what it was before the batch', () => {
    const id = writeNewNote(db, config, '# One\n\nWritten by a human.\n', { author: 'cli' }).note.id

    writeNoteBody(db, config, id, '# One\n\nRewritten by an agent.\n', {
      author: 'mcp:agent',
      batchId: batch,
    })
    expect(requireNote(db, id).body).toContain('agent')

    const report = undoBatch(db, config, batch, 'cli')

    expect(report.actions).toEqual([{ noteId: id, action: 'restored', toRev: 1 }])
    expect(requireNote(db, id).body).toContain('Written by a human')
  })

  it('archives a note the batch created rather than deleting it', () => {
    const id = writeNewNote(db, config, '# Agent note\n\nBody.\n', {
      author: 'mcp:agent',
      batchId: batch,
    }).note.id

    const report = undoBatch(db, config, batch, 'cli')

    expect(report.actions).toEqual([{ noteId: id, action: 'archived' }])
    // The note and its history survive; only its visibility goes.
    expect(getNote(db, id)?.status).toBe('archived')
    expect(listRevisions(db, id).length).toBeGreaterThan(1)
  })

  it('takes back several notes at once and leaves other writes alone', () => {
    const untouched = writeNewNote(db, config, '# Mine\n\nHuman body.\n', { author: 'cli' }).note.id
    const edited = writeNewNote(db, config, '# Edited\n\nBefore.\n', { author: 'cli' }).note.id

    writeNoteBody(db, config, edited, '# Edited\n\nAfter.\n', {
      author: 'mcp:agent',
      batchId: batch,
    })
    const invented = writeNewNote(db, config, '# Invented\n\nBody.\n', {
      author: 'mcp:agent',
      batchId: batch,
    }).note.id

    const report = undoBatch(db, config, batch, 'cli')

    expect(report.actions.map((action) => action.noteId).sort()).toEqual([edited, invented].sort())
    expect(requireNote(db, edited).body).toContain('Before')
    expect(getNote(db, invented)?.status).toBe('archived')
    expect(requireNote(db, untouched).body).toContain('Human body')
  })

  it('is itself recorded, so an undo can be undone', () => {
    const id = writeNewNote(db, config, '# One\n\nOriginal.\n', { author: 'cli' }).note.id
    writeNoteBody(db, config, id, '# One\n\nAgent version.\n', {
      author: 'mcp:agent',
      batchId: batch,
    })

    undoBatch(db, config, batch, 'cli')
    const afterUndo = requireNote(db, id)

    expect(afterUndo.body).toContain('Original')
    // Revision 2 is what the agent wrote; reverting to it brings it back.
    revertNote(db, config, id, 2, 'cli')
    expect(requireNote(db, id).body).toContain('Agent version')
  })

  it('reports an unknown batch with somewhere to look', () => {
    try {
      undoBatch(db, config, 'no-such-batch', 'cli')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError)
      expect((error as NotFoundError).hint).toContain('--batches')
    }
  })

  it('lists batches so one can be named', () => {
    writeNewNote(db, config, '# One\n\nBody.\n', { author: 'mcp:agent', batchId: batch })
    writeNewNote(db, config, '# Two\n\nBody.\n', { author: 'mcp:agent', batchId: batch })
    writeNewNote(db, config, '# Three\n\nBody.\n', { author: 'cli' })

    const batches = listBatches(db)

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ batchId: batch, author: 'mcp:agent', notes: 2, revisions: 2 })
  })

  it('builds a batch id an operator can read', () => {
    const id = newBatchId('mcp', Date.parse('2026-09-01T10:15:00Z'), 'a1b2c3')
    expect(id).toBe('mcp-20260901T101500-a1b2c3')
  })
})
