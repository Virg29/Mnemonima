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

  const write = (relative: string, body: string): void => {
    const file = path.join(vault, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }

  beforeEach(() => {
    sandbox = createSandbox()
    vault = path.join(sandbox.projects, 'vault')

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
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
    const report = adoptVault(db, config, vault)

    expect(report.dryRun).toBe(true)
    expect(report.created).toBe(3)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(0)
  })

  it('creates a note per file and keeps the body exactly as written', () => {
    const report = adoptVault(db, config, vault, { dryRun: false })

    expect(report.created).toBe(3)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)

    const first = requireNote(db, 'SL-0001')
    expect(first.title).toBe('Mechanic: aspects')
    expect(first.body).toContain('[the wand](wand.md)')
  })

  it('keeps the original filename as an alias', () => {
    adoptVault(db, config, vault, { dryRun: false })

    // The point of it: this is what makes a link by filename resolve.
    expect(listAliases(db, 'SL-0001').map((alias) => alias.alias)).toContain('aspects')
  })

  it('makes the vault own links resolve, which is the whole exercise', () => {
    adoptVault(db, config, vault, { dryRun: false })

    for (const note of listNotes(db, { status: 'any', limit: -1 })) {
      syncNoteLinks(db, note.id, note.body, buildResolver(db))
    }

    const resolve = buildResolver(db).resolve
    expect(resolve('wand.md').resolved).toBe(true)
    expect(resolve('../mechanics/aspects.md#the-lock')).toEqual({ dst: 'SL-0001', resolved: true })
  })

  it('does not duplicate on a second run', () => {
    adoptVault(db, config, vault, { dryRun: false })
    const second = adoptVault(db, config, vault, { dryRun: false })

    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(3)
    expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)
  })

  it('updates the note a changed file belongs to, rather than making another', () => {
    adoptVault(db, config, vault, { dryRun: false })
    write('mechanics/wand.md', '# Mechanic: the wand\n\nRewritten upstream.\n')

    const second = adoptVault(db, config, vault, { dryRun: false })

    expect(second.updated).toBe(1)
    expect(second.unchanged).toBe(2)
    expect(requireNote(db, 'SL-0002').body).toContain('Rewritten upstream')
    expect(requireNote(db, 'SL-0002').rev).toBe(2)
  })

  it('follows a file that moved as a new note, and says so', () => {
    // The source path is the identity, so a move reads as a new file. Better
    // that than guessing a rename and merging two notes into one.
    adoptVault(db, config, vault, { dryRun: false })
    fs.renameSync(path.join(vault, 'notes/plan.md'), path.join(vault, 'notes/roadmap.md'))

    const second = adoptVault(db, config, vault, { dryRun: false })
    expect(second.created).toBe(1)
  })

  describe('a vault that is not all English', () => {
    beforeEach(() => {
      write('mechanics/nodes.md', '# Aura nodes\n\nУзлы ауры и как они гаснут.\n')
    })

    it('skips it by default and names the reason', () => {
      const report = adoptVault(db, config, vault, { dryRun: false })

      expect(report.skipped).toBe(1)
      const skipped = report.files.find((file) => file.action === 'skipped')
      expect(skipped?.reason).toContain('Cyrillic')
      expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(3)
    })

    it('brings it in when asked, rather than losing it', () => {
      const report = adoptVault(db, config, vault, { dryRun: false, importAnyway: true })

      expect(report.skipped).toBe(0)
      expect(report.created).toBe(4)
      expect(listNotes(db, { status: 'any', limit: -1 })).toHaveLength(4)
    })
  })

  it('reports basenames two files share instead of guessing', () => {
    write('mechanics/README.md', '# Mechanics\n\nAn index.\n')
    write('notes/README.md', '# Notes\n\nAnother index.\n')

    const report = adoptVault(db, config, vault)
    const collision = report.collisions.find((entry) => entry.name === 'readme')

    // `[text](README.md)` is ambiguous, and picking one would point half the
    // links at the wrong note.
    expect(collision?.paths).toEqual(['mechanics/README.md', 'notes/README.md'])
  })

  it('refuses a root that is not a directory', () => {
    expect(() => adoptVault(db, config, path.join(vault, 'mechanics/aspects.md'))).toThrow(
      BadRequestError,
    )
  })
})
