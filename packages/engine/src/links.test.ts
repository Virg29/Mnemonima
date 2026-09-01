import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { addAlias, createProject, createSandbox, getConfig, setConfig } from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { buildResolver, fileReferenceName } from './links.js'
import { writeNewNote } from './notes.js'

/**
 * Resolving a link target.
 *
 * The file-reference branch exists because of a real import: 29 notes arrived
 * from a directory of markdown, linking to each other as `[text](aspects.md)`,
 * and all 118 of those links came in dangling. The only thing wrong with them
 * was the suffix.
 */

describe('reading a file reference out of a target', () => {
  it('takes the basename without its suffix', () => {
    expect(fileReferenceName('aspects.md')).toBe('aspects')
    expect(fileReferenceName('./aspects.md')).toBe('aspects')
    expect(fileReferenceName('../mechanics/aspects.md')).toBe('aspects')
    expect(fileReferenceName('docs\\mechanics\\aspects.markdown')).toBe('aspects')
  })

  it('drops an anchor and a query', () => {
    expect(fileReferenceName('aspects.md#the-lock')).toBe('aspects')
    expect(fileReferenceName('aspects.md?plain=1')).toBe('aspects')
  })

  it('is not fooled by something that is not a file at all', () => {
    // A title with a dot in it must not be shortened into a different title.
    expect(fileReferenceName('Mechanic: aspects')).toBeNull()
    expect(fileReferenceName('version 1.2 of the plan')).toBeNull()
    expect(fileReferenceName('SL-0042')).toBeNull()
    expect(fileReferenceName('')).toBeNull()
  })

  it('leaves a URL alone', () => {
    // An external link is not a note reference, whatever it ends with.
    expect(fileReferenceName('https://example.com/notes/aspects.md')).toBeNull()
    expect(fileReferenceName('mailto:someone@example.com')).toBeNull()
  })
})

describe('resolving a target against a project', () => {
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

    writeNewNote(db, config, '# Mechanic: aspects\n\nThe forty-eight aspects.\n', { author: 't' })
    writeNewNote(db, config, '# GPU pipeline\n\nThe vertex stage.\n', { author: 't' })
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('still prefers an id, then an alias, then the exact title', () => {
    const resolve = buildResolver(db).resolve

    expect(resolve('SL-0001')).toEqual({ dst: 'SL-0001', resolved: true })
    expect(resolve('GPU pipeline')).toEqual({ dst: 'SL-0002', resolved: true })
  })

  it('resolves a filename through the alias the original name became', () => {
    // What `adopt` sets up: the file was `aspects.md`, the note is titled
    // differently, and every link in the vault points at the filename.
    addAlias(db, 'SL-0001', 'aspects')

    const resolve = buildResolver(db).resolve
    expect(resolve('aspects.md')).toEqual({ dst: 'SL-0001', resolved: true })
    expect(resolve('../mechanics/aspects.md#the-lock')).toEqual({ dst: 'SL-0001', resolved: true })
  })

  it('resolves a filename that matches a title', () => {
    const resolve = buildResolver(db).resolve
    expect(resolve('GPU pipeline.md')).toEqual({ dst: 'SL-0002', resolved: true })
  })

  it('resolves the filename our own export writes', () => {
    // `SL-0001 Mechanic: aspects.md` — the id leads, so it never depends on
    // the title matching (DESIGN.md 5.1).
    const resolve = buildResolver(db).resolve
    expect(resolve('SL-0001 Mechanic: aspects.md')).toEqual({ dst: 'SL-0001', resolved: true })
  })

  it('tries the whole target before taking it apart', () => {
    // A note genuinely called `notes.md` wins over a file of the same name.
    writeNewNote(db, config, '# notes.md\n\nA note whose title is a filename.\n', { author: 't' })
    addAlias(db, 'SL-0002', 'notes')

    expect(buildResolver(db).resolve('notes.md')).toEqual({ dst: 'SL-0003', resolved: true })
  })

  it('keeps an unresolvable target exactly as written', () => {
    const resolve = buildResolver(db).resolve

    expect(resolve('nothing-like-this.md')).toEqual({
      dst: 'nothing-like-this.md',
      resolved: false,
    })
    expect(resolve('SL-9999')).toEqual({ dst: 'SL-9999', resolved: false })
  })
})
