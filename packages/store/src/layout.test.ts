import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from './db.js'
import { clearLayout, listLayout, readLayout, saveLayout } from './layout.js'
import { createNote, deleteNote, requireNote } from './notes.js'
import { createProject } from './project.js'
import { createSandbox } from './testing.js'
import type { Sandbox } from './testing.js'

describe('the graph layout', () => {
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

  const write = (title: string) => createNote(db, { title, body: `# ${title}`, author: 'test' })

  it('remembers a position and reads it back', () => {
    const note = write('Shaders')

    expect(saveLayout(db, [{ noteId: note.id, x: 12.5, y: -3.25 }])).toBe(1)
    expect(readLayout(db).get(note.id)).toEqual({ x: 12.5, y: -3.25 })
  })

  it('has nothing for a note that has never been placed', () => {
    const note = write('Shaders')

    // The absence is the signal: everything stored is pinned, everything else
    // is arranged around it.
    expect(readLayout(db).has(note.id)).toBe(false)
  })

  it('writes only the notes it was given', () => {
    const first = write('Shaders')
    const second = write('Uniforms')

    saveLayout(db, [
      { noteId: first.id, x: 1, y: 1 },
      { noteId: second.id, x: 2, y: 2 },
    ])
    saveLayout(db, [{ noteId: first.id, x: 9, y: 9 }])

    const layout = readLayout(db)
    expect(layout.get(first.id)).toEqual({ x: 9, y: 9 })
    expect(layout.get(second.id)).toEqual({ x: 2, y: 2 })
  })

  it('moving a note writes no revision', () => {
    // The rule the table exists to keep: a position is not part of a note, so
    // arranging the picture must not show up in its history.
    const note = write('Shaders')
    const before = requireNote(db, note.id).rev

    saveLayout(db, [{ noteId: note.id, x: 4, y: 4 }])

    expect(requireNote(db, note.id).rev).toBe(before)
  })

  it('skips a position for a note that does not exist', () => {
    const note = write('Shaders')

    // The page can be a few seconds behind a deletion, and losing one
    // coordinate is not worth failing the whole batch over.
    const saved = saveLayout(db, [
      { noteId: note.id, x: 1, y: 1 },
      { noteId: 'SL-9999', x: 2, y: 2 },
    ])

    expect(saved).toBe(1)
    expect(readLayout(db).size).toBe(1)
  })

  it('skips a coordinate that is not a number', () => {
    const note = write('Shaders')

    expect(saveLayout(db, [{ noteId: note.id, x: Number.NaN, y: 0 }])).toBe(0)
    expect(readLayout(db).size).toBe(0)
  })

  it('forgets the placement when the note is deleted outright', () => {
    const note = write('Shaders')
    saveLayout(db, [{ noteId: note.id, x: 1, y: 1 }])

    deleteNote(db, note.id, { author: 'test', hard: true })

    expect(readLayout(db).size).toBe(0)
  })

  it('keeps the placement of an archived note', () => {
    // Archiving retires a note rather than removing it, and unarchiving is a
    // thing an operator does. Forgetting where it sat would move it on the
    // way back.
    const note = write('Shaders')
    saveLayout(db, [{ noteId: note.id, x: 1, y: 1 }])

    deleteNote(db, note.id, { author: 'test' })

    expect(readLayout(db).get(note.id)).toEqual({ x: 1, y: 1 })
  })

  it('clears everything, so the next render arranges from scratch', () => {
    const first = write('Shaders')
    const second = write('Uniforms')
    saveLayout(db, [
      { noteId: first.id, x: 1, y: 1 },
      { noteId: second.id, x: 2, y: 2 },
    ])

    expect(clearLayout(db)).toBe(2)
    expect(readLayout(db).size).toBe(0)
  })

  it('clears one note without touching the others', () => {
    const first = write('Shaders')
    const second = write('Uniforms')
    saveLayout(db, [
      { noteId: first.id, x: 1, y: 1 },
      { noteId: second.id, x: 2, y: 2 },
    ])

    expect(clearLayout(db, [first.id])).toBe(1)
    expect(listLayout(db).map((row) => row.noteId)).toEqual([second.id])
  })
})
