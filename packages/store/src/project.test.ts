import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, LanguageGateError, NotFoundError } from '@mnemonima/core'
import {
  createProject,
  fileInUseError,
  openProject,
  projectStats,
  removeProject,
} from './project.js'
import { getMeta, META, nextNoteId } from './meta.js'
import {
  PROJECT_DATA_DIR,
  legacyProjectDbPath,
  projectDataDir,
  projectDbPath,
} from './paths.js'
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

describe('the project data directory', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  it('puts everything it generates under one subdirectory', () => {
    const dir = path.join(sandbox.projects, 'vault')
    const project = createProject({ name: 'Shader Lab', dir })
    project.db.close()

    // The directory the operator named gains exactly one entry.
    expect(fs.readdirSync(dir)).toEqual([PROJECT_DATA_DIR])
    expect(fs.existsSync(path.join(dir, PROJECT_DATA_DIR, 'mnemonima.db'))).toBe(true)
    expect(projectDbPath(dir)).toBe(path.join(projectDataDir(dir), 'mnemonima.db'))
  })

  it('leaves whatever else is in that directory alone', () => {
    const dir = path.join(sandbox.projects, 'vault')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), '# Mine\n')

    const project = createProject({ name: 'Shader Lab', dir })
    project.db.close()

    expect(fs.readdirSync(dir).sort()).toEqual([PROJECT_DATA_DIR, 'README.md'])
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# Mine\n')
  })

  it('refuses a directory holding a database from the old layout', () => {
    const dir = path.join(sandbox.projects, 'vault')
    fs.mkdirSync(dir, { recursive: true })

    // A real database, written where the previous layout kept it.
    const older = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'seed') })
    older.db.close()
    fs.copyFileSync(
      projectDbPath(path.join(sandbox.projects, 'seed')),
      legacyProjectDbPath(dir),
    )

    try {
      createProject({ name: 'Vault', dir })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError)
      // Never silently create an empty second database beside the real one.
      expect((error as BadRequestError).hint).toContain(PROJECT_DATA_DIR)
      expect(fs.existsSync(projectDbPath(dir))).toBe(false)
    }
  })

  it('removes the subdirectory with the data, but only when it is empty', () => {
    const dir = path.join(sandbox.projects, 'vault')
    const project = createProject({ name: 'Shader Lab', dir })
    project.db.close()

    // An export beside the database may be a git repository with history:
    // deleting a database is not consent to delete that.
    const kept = path.join(projectDataDir(dir), 'export')
    fs.mkdirSync(kept, { recursive: true })
    fs.writeFileSync(path.join(kept, 'SL-0001 Note.md'), '# Note\n')

    removeProject('Shader Lab', { deleteData: true })
    expect(fs.existsSync(projectDbPath(dir))).toBe(false)
    expect(fs.existsSync(kept)).toBe(true)

    fs.rmSync(kept, { recursive: true })
    const again = createProject({ name: 'Shader Lab', dir })
    again.db.close()
    removeProject('Shader Lab', { deleteData: true })

    expect(fs.existsSync(projectDataDir(dir))).toBe(false)
  })
})

describe('keeping out of the operator git repository', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  it('ignores itself from the inside, without touching their .gitignore', () => {
    const dir = path.join(sandbox.projects, 'repo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n')

    const project = createProject({ name: 'Shader Lab', dir })
    project.db.close()

    const ours = path.join(projectDataDir(dir), '.gitignore')
    expect(fs.readFileSync(ours, 'utf8')).toContain('*')

    // Theirs is their file. We add one entry to their directory and nothing
    // else, and the entry hides itself.
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('build/\n')
  })

  it('leaves an existing one alone, because editing it was deliberate', () => {
    const dir = path.join(sandbox.projects, 'repo')
    const data = projectDataDir(dir)
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, '.gitignore'), '*\n!export/\n')

    const project = createProject({ name: 'Shader Lab', dir })
    project.db.close()

    expect(fs.readFileSync(path.join(data, '.gitignore'), 'utf8')).toBe('*\n!export/\n')
  })
})

describe('removing a project whose files are held open', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  it('explains a locked file instead of reporting a bug of ours', () => {
    // Whether an open handle blocks an unlink is the platform's business —
    // Windows allows it for a normally opened file and refuses it for the one
    // SQLite holds — so the translation is what gets tested, not the lock.
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const translated = fileInUseError({ code }, 'C:/kb/.mnemonima/mnemonima.db', 'Shader Lab')

      expect(translated).toBeInstanceOf(BadRequestError)
      expect(translated?.exitCode).toBe(2)
      expect(translated?.hint).toContain('daemon unload "Shader Lab"')
    }
  })

  it('leaves a failure that is not ours to explain alone', () => {
    expect(fileInUseError({ code: 'ENOSPC' }, 'x', 'Shader Lab')).toBeNull()
    expect(fileInUseError(new Error('something else'), 'x', 'Shader Lab')).toBeNull()
  })

  it('unregisters only after the files are gone', () => {
    const dir = path.join(sandbox.projects, 'free')
    const project = createProject({ name: 'Shader Lab', dir })
    project.db.close()

    const result = removeProject('Shader Lab', { deleteData: true })

    expect(result.deletedFiles.length).toBeGreaterThan(0)
    expect(listEntries().map((entry) => entry.name)).not.toContain('Shader Lab')
    expect(fs.existsSync(projectDbPath(dir))).toBe(false)
  })

  it('keeps the entry when the data could not be deleted', () => {
    const dir = path.join(sandbox.projects, 'held')
    const project = createProject({ name: 'Shader Lab', dir })
    project.db.close()

    // A directory where the database file should be: rmSync refuses it, which
    // stands in for any deletion that cannot go through.
    fs.rmSync(projectDbPath(dir))
    fs.mkdirSync(projectDbPath(dir))

    expect(() => removeProject('Shader Lab', { deleteData: true })).toThrow()

    // The half that matters: still registered, so it can be reached and retried
    // rather than orphaned on disk with no command that knows about it.
    expect(listEntries().map((entry) => entry.name)).toContain('Shader Lab')
  })
})
