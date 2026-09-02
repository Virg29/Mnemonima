import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  createProject,
  createSandbox,
  getConfig,
  listAliases,
  listNotes,
  requireNote,
  setConfig,
} from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { adoptVault, findMarkdown } from './adopt.js'
import { buildResolver, syncNoteLinks } from './links.js'
import { writeNewNote } from './notes.js'

/**
 * Adopting a foreign vault.
 *
 * The shape of the fixture is the shape of the case that motivated this: a
 * directory of markdown with no frontmatter, whose notes link to each other by
 * filename, in nested folders, with a file in another language and two files
 * sharing a basename.
 */

describe('adopt', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let vault: string
  let projectDir: string

  const write = (relative: string, body: string): void => {
    const file = path.join(vault, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }

  beforeEach(() => {
    sandbox = createSandbox()
    vault = path.join(sandbox.projects, 'vault')
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)

    write(
      'mechanics/aspects.md',
      '# Mechanic: aspects\n\nThe forty-eight aspects. See [the wand](wand.md).\n',
    )
    write('mechanics/wand.md', '# Mechanic: the wand\n\nIt draws vis from the aura.\n')
    write('notes/plan.md', '# The plan\n\nSee [aspects](../mechanics/aspects.md#the-lock).\n')
    write('.obsidian/workspace.md', '# Not a note\n\nEditor state.\n')
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('walks the vault in a deterministic order and skips editor state', () => {
    const found = findMarkdown(vault).map((file) => path.relative(vault, file).replace(/\\/g, '/'))

    // Sorted, because ids are handed out in this order and a second machine
    // has to produce the same ones.
    expect(found).toEqual(['mechanics/aspects.md', 'mechanics/wand.md', 'notes/plan.md'])
  })

  it('changes nothing on a dry run, which is the default', () => {
    const report = adoptVault(db, config, projectDir, vault)

    expect(report.dryRun).toBe(true)
    expect(report.created).toBe(3)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(0)
  })

  it('creates a note per file and keeps the body exactly as written', () => {
    const report = adoptVault(db, config, projectDir, vault, { dryRun: false })

    expect(report.created).toBe(3)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)

    const first = requireNote(db, 'SL-0001')
    expect(first.title).toBe('Mechanic: aspects')
    expect(first.body).toContain('[the wand](wand.md)')
  })

  it('keeps the original filename as an alias', () => {
    adoptVault(db, config, projectDir, vault, { dryRun: false })

    // The point of it: this is what makes a link by filename resolve.
    expect(listAliases(db, 'SL-0001').map((alias) => alias.alias)).toContain('aspects')
  })

  it('makes the vault own links resolve, which is the whole exercise', () => {
    adoptVault(db, config, projectDir, vault, { dryRun: false })

    for (const note of listNotes(db, { status: 'any', limit: -1 })) {
      syncNoteLinks(db, note.id, note.body, buildResolver(db))
    }

    const resolve = buildResolver(db).resolve
    expect(resolve('wand.md').resolved).toBe(true)
    expect(resolve('../mechanics/aspects.md#the-lock')).toEqual({ dst: 'SL-0001', resolved: true })
  })

  it('does not duplicate on a second run', () => {
    adoptVault(db, config, projectDir, vault, { dryRun: false })
    const second = adoptVault(db, config, projectDir, vault, { dryRun: false })

    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(3)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)
  })

  it('updates the note a changed file belongs to, rather than making another', () => {
    adoptVault(db, config, projectDir, vault, { dryRun: false })
    write('mechanics/wand.md', '# Mechanic: the wand\n\nRewritten upstream.\n')

    const second = adoptVault(db, config, projectDir, vault, { dryRun: false })

    expect(second.updated).toBe(1)
    expect(second.unchanged).toBe(2)
    expect(requireNote(db, 'SL-0002').body).toContain('Rewritten upstream')
    expect(requireNote(db, 'SL-0002').rev).toBe(2)
  })

  it('follows a file that moved as a new note, and says so', () => {
    // The source path is the identity, so a move reads as a new file. Better
    // that than guessing a rename and merging two notes into one.
    adoptVault(db, config, projectDir, vault, { dryRun: false })
    fs.renameSync(path.join(vault, 'notes/plan.md'), path.join(vault, 'notes/roadmap.md'))

    const second = adoptVault(db, config, projectDir, vault, { dryRun: false })
    expect(second.created).toBe(1)
  })

  describe('a vault that is not all English', () => {
    beforeEach(() => {
      write('mechanics/nodes.md', '# Aura nodes\n\nУзлы ауры и как они гаснут.\n')
    })

    it('skips it by default and names the reason', () => {
      const report = adoptVault(db, config, projectDir, vault, { dryRun: false })

      expect(report.skipped).toBe(1)
      const skipped = report.files.find((file) => file.action === 'skipped')
      expect(skipped?.reason).toContain('Cyrillic')
      expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)
    })

    it('brings it in when asked, rather than losing it', () => {
      const report = adoptVault(db, config, projectDir, vault, { dryRun: false, importAnyway: true })

      expect(report.skipped).toBe(0)
      expect(report.created).toBe(4)
      expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(4)
    })
  })

  it('reports basenames two files share instead of guessing', () => {
    write('mechanics/README.md', '# Mechanics\n\nAn index.\n')
    write('notes/README.md', '# Notes\n\nAnother index.\n')

    const report = adoptVault(db, config, projectDir, vault)
    const collision = report.collisions.find((entry) => entry.name === 'readme')

    // `[text](README.md)` is ambiguous, and picking one would point half the
    // links at the wrong note.
    expect(collision?.paths).toEqual(['mechanics/README.md', 'notes/README.md'])
  })

  it('never adopts its own export, however it is pointed at itself', () => {
    // Measured, and it doubled a vault: 241 files came back as 482 notes. The
    // export lands inside the directory being adopted whenever an operator
    // points `export.path` at their own docs tree, which is the obvious thing
    // to do when moving a project onto this.
    const exported = { ...config, export: { ...config.export, path: '../vault/exported' } }
    write('exported/SL-0001 Mechanic aspects.md', '# Mechanic: aspects\n\nA generated copy.\n')

    const report = adoptVault(db, exported, projectDir, vault, { dryRun: false })

    expect(report.created).toBe(3)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)
  })

  it('refuses a root that is not a directory', () => {
    expect(() => adoptVault(db, config, projectDir, path.join(vault, 'mechanics/aspects.md'))).toThrow(
      BadRequestError,
    )
  })
})

describe('adopting into a project that already holds the notes', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let vault: string
  let projectDir: string

  const write = (relative: string, body: string): void => {
    const file = path.join(vault, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }

  beforeEach(() => {
    sandbox = createSandbox()
    vault = path.join(sandbox.projects, 'vault')
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)

    write('mechanics/aspects.md', '# Mechanic: aspects\n\nThe forty-eight aspects.\n')
    write('mechanics/wand.md', '# Mechanic: the wand\n\nIt draws vis from the aura.\n')
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('takes over a note of the same title instead of duplicating it', () => {
    // The migration case: notes were written before `adopt` existed, and other
    // things already reference their ids.
    const first = writeNewNote(db, config, '# Mechanic: aspects\n\nAn older draft.\n', {
      author: 'cli',
    }).note.id

    const report = adoptVault(db, config, projectDir, vault, { dryRun: false })

    expect(report.claimed).toBe(1)
    expect(report.created).toBe(1)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(2)

    // Same id, same history, new body.
    expect(requireNote(db, first).body).toContain('forty-eight')
    expect(requireNote(db, first).rev).toBe(2)
  })

  it('leaves a note no file matches completely alone', () => {
    // A decision record written in mnemonima with no file behind it: adopting
    // must not touch it, and must not delete it.
    const own = writeNewNote(db, config, '# Where the knowledge lives\n\nA record.\n', {
      author: 'cli',
    }).note.id

    adoptVault(db, config, projectDir, vault, { dryRun: false })

    expect(requireNote(db, own).rev).toBe(1)
    expect(requireNote(db, own).body).toContain('A record')
  })

  it('claims a note once, however many files share a heading', () => {
    writeNewNote(db, config, '# Mechanic: aspects\n\nAn older draft.\n', { author: 'cli' })
    write('notes/aspects-again.md', '# Mechanic: aspects\n\nA second file, same heading.\n')

    const report = adoptVault(db, config, projectDir, vault, { dryRun: false })

    expect(report.claimed).toBe(1)
    expect(report.created).toBe(2)
  })

  it('says what it would claim before it does anything', () => {
    writeNewNote(db, config, '# Mechanic: aspects\n\nAn older draft.\n', { author: 'cli' })

    const report = adoptVault(db, config, projectDir, vault)
    const claimed = report.files.find((file) => file.action === 'claimed')

    expect(report.dryRun).toBe(true)
    expect(claimed?.noteId).toBe('SL-0001')
    expect(requireNote(db, 'SL-0001').body).toContain('older draft')
  })

  it('takes only the paths it was told to', () => {
    write('generated/one.md', '# Generated one\n\nMachine output.\n')
    write('generated/two.md', '# Generated two\n\nMachine output.\n')

    const report = adoptVault(db, config, projectDir, vault, {
      dryRun: false,
      only: ['mechanics'],
    })

    expect(report.created).toBe(2)
    expect(report.files.every((file) => file.sourcePath.startsWith('mechanics/'))).toBe(true)
  })

  it('keeps paths whole so a link across two kept subtrees resolves', () => {
    write('notes/plan.md', '# The plan\n\nSee [warp](../mechanics/wand.md).\n')
    write('generated/noise.md', '# Noise\n\nNot wanted.\n')

    adoptVault(db, config, projectDir, vault, {
      dryRun: false,
      only: ['mechanics', 'notes'],
    })

    for (const note of listNotes(db, { status: 'any', limit: -1 })) {
      syncNoteLinks(db, note.id, note.body, buildResolver(db))
    }

    // Adopted from the root, so `../mechanics/wand` still means what it says.
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)
    expect(buildResolver(db).resolve('../mechanics/wand', 'SL-0003').resolved).toBe(true)
  })
})

describe('deriving the title', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let vault: string
  let projectDir: string

  beforeEach(() => {
    sandbox = createSandbox()
    vault = path.join(sandbox.projects, 'vault')
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db
    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)

    fs.mkdirSync(vault, { recursive: true })
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('reads a heading the same way the writer does', () => {
    // Caught by a dry run on a real project: the writer takes the title from
    // mdast and gets `What else belongs in api/`, while a regular expression
    // over the source keeps the backticks. The mismatch meant a note that was
    // already there went unrecognised and would have been duplicated.
    const body = '# What else belongs in `api/`\n\nA list.\n'
    fs.writeFileSync(path.join(vault, 'plan.md'), body)

    const existing = writeNewNote(db, config, body, { author: 'cli' }).note
    expect(existing.title).toBe('What else belongs in api/')

    const report = adoptVault(db, config, projectDir, vault, { dryRun: false })

    expect(report.claimed).toBe(1)
    expect(report.created).toBe(0)
  })
})
