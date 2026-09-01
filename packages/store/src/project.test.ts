import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, LanguageGateError, NotFoundError } from '@mnemonima/core'
import { createProject, openProject, projectStats, removeProject } from './project.js'
import { getMeta, META, nextNoteId } from './meta.js'
import { listEntries } from './registry.js'
import { createSandbox } from './testing.js'
import type { Sandbox } from './testing.js'

describe('createProject', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  const dirFor = (name: string): string => path.join(sandbox.projects, name)

  it('creates the database, seeds meta and registers the project', () => {
    const project = createProject({ name: 'Shader Lab', dir: dirFor('shaders') })

    expect(project.created).toBe(true)
    expect(project.prefix).toBe('SL')
    expect(fs.existsSync(project.dbPath)).toBe(true)
    expect(getMeta(project.db, META.PROJECT_NAME)).toBe('Shader Lab')
    expect(getMeta(project.db, META.ID_COUNTER)).toBe('0')
    expect(getMeta(project.db, META.CONFIG)).not.toBeNull()

    project.db.close()

    const entries = listEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('Shader Lab')
    expect(entries[0]?.prefix).toBe('SL')
  })

  it('accepts an explicit prefix and uppercases it', () => {
    const project = createProject({ name: 'Shader Lab', dir: dirFor('p'), prefix: 'gfx' })
    expect(project.prefix).toBe('GFX')
    project.db.close()
  })

  it('rejects a non-English project name', () => {
    expect(() => createProject({ name: 'Шейдеры', dir: dirFor('ru') })).toThrow(LanguageGateError)
  })

  it('rejects an empty project name', () => {
    expect(() => createProject({ name: '   ', dir: dirFor('empty') })).toThrow(BadRequestError)
  })

  it('rejects a duplicate name without --force', () => {
    createProject({ name: 'Shader Lab', dir: dirFor('a') }).db.close()

    expect(() => createProject({ name: 'Shader Lab', dir: dirFor('b') })).toThrow(BadRequestError)
  })

  it('re-points an existing entry with --force', () => {
    createProject({ name: 'Shader Lab', dir: dirFor('a') }).db.close()

    const moved = createProject({ name: 'Shader Lab', dir: dirFor('b'), force: true })
    moved.db.close()

    expect(listEntries()).toHaveLength(1)
    expect(listEntries()[0]?.dir).toBe(path.resolve(dirFor('b')))
  })

  it('adopts an existing database instead of recreating it', () => {
    const first = createProject({ name: 'Shader Lab', dir: dirFor('a') })
    first.db.close()

    const second = createProject({ name: 'Shader Lab', dir: dirFor('a'), force: true })
    expect(second.created).toBe(false)
    expect(second.migrations.applied).toEqual([])
    second.db.close()
  })

  it('leaves no directory or database behind when the request is rejected', () => {
    const cases: { name: string; dir: string; prefix?: string }[] = [
      { name: 'Temp One', dir: dirFor('bad-prefix'), prefix: 'toolongprefix' },
      { name: 'a', dir: dirFor('bad-name') },
      { name: 'Шейдеры', dir: dirFor('non-english') },
    ]

    for (const options of cases) {
      expect(() => createProject(options)).toThrow()
      expect(fs.existsSync(options.dir)).toBe(false)
    }

    expect(listEntries()).toHaveLength(0)
  })

  it("refuses to adopt a directory another project already owns", () => {
    const shared = dirFor('shared')
    createProject({ name: 'Shader Lab', dir: shared }).db.close()

    try {
      createProject({ name: 'Second Name', dir: shared, force: true })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toContain('Shader Lab')
    }

    // The original entry and its database name must be untouched.
    expect(listEntries()).toHaveLength(1)
    const project = createProject({ name: 'Shader Lab', dir: shared, force: true })
    expect(project.name).toBe('Shader Lab')
    project.db.close()
  })

  it('refuses to change the prefix of an existing database', () => {
    createProject({ name: 'Shader Lab', dir: dirFor('a') }).db.close()

    expect(() =>
      createProject({ name: 'Shader Lab', dir: dirFor('a'), prefix: 'XYZ', force: true }),
    ).toThrow(BadRequestError)
  })
})

describe('openProject', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  it('opens a registered project', () => {
    createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') }).db.close()

    const project = openProject('Shader Lab')
    expect(project.prefix).toBe('SL')
    expect(projectStats(project.db)).toEqual({
      notes: 0,
      chunks: 0,
      terms: 0,
      activeSpace: null,
    })
    project.db.close()
  })

  it('resolves the name case-insensitively', () => {
    createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') }).db.close()

    const project = openProject('shader lab')
    expect(project.name).toBe('Shader Lab')
    project.db.close()
  })

  it('reports an unknown project', () => {
    expect(() => openProject('nope')).toThrow(NotFoundError)
  })

  it('reports a registered project whose database went missing', () => {
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') })
    const dbPath = project.dbPath
    project.db.close()
    fs.rmSync(dbPath)

    expect(() => openProject('Shader Lab')).toThrow(NotFoundError)
  })
})

describe('removeProject', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  it('unregisters but keeps the data by default', () => {
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') })
    const dbPath = project.dbPath
    project.db.close()

    const result = removeProject('Shader Lab')

    expect(result.deletedFiles).toEqual([])
    expect(fs.existsSync(dbPath)).toBe(true)
    expect(listEntries()).toHaveLength(0)
  })

  it('deletes the database when asked', () => {
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') })
    const dbPath = project.dbPath
    project.db.close()

    const result = removeProject('Shader Lab', { deleteData: true })

    expect(result.deletedFiles).toContain(dbPath)
    expect(fs.existsSync(dbPath)).toBe(false)
  })

  it('reports an unknown project', () => {
    expect(() => removeProject('nope')).toThrow(NotFoundError)
  })
})

describe('note id allocation', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  it('hands out consecutive padded ids', () => {
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') })

    expect(nextNoteId(project.db)).toBe('SL-0001')
    expect(nextNoteId(project.db)).toBe('SL-0002')
    expect(getMeta(project.db, META.ID_COUNTER)).toBe('2')

    project.db.close()
  })

  it('never reuses an id after the note is gone', () => {
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'a') })

    nextNoteId(project.db)
    nextNoteId(project.db)
    project.db.prepare('DELETE FROM notes').run()

    expect(nextNoteId(project.db)).toBe('SL-0003')
    project.db.close()
  })
})
