import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_MODEL_ID, lemmaKey } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  addAlias,
  addNoteTerm,
  createProject,
  createSandbox,
  getConfig,
  listAliases,
  listTags,
  listRevisions,
  noteTerms,
  requireNote,
  setConfig,
  setNoteTags,
} from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { exportFilename, idFromFilename, parseFile, renderFrontmatter } from './frontmatter.js'
import { exportProject, importProject } from './bridge.js'
import { writeNewNote, writeNoteBody } from './notes.js'

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour.
`

const GARDENING = `# Tomato planting

Tomatoes want full sun and a deep bed of compost before the last frost.
`

describe('frontmatter', () => {
  const note = {
    frontmatter: {
      id: 'SL-0042',
      title: 'Shaders introduction',
      status: 'active' as const,
      rev: 7,
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
      bodyHash: 'sha256:abc',
      tags: ['graphics', 'glsl'],
      aliases: ['shader intro'],
      keywordsManual: ['fragment shader'],
      phrasesManual: ['how a fragment shader runs'],
    },
    generated: {
      keywordsAuto: ['uniform'],
      phrasesAuto: [],
      outline: '1. Shaders introduction',
      links: ['SL-0007'],
      backlinks: ['SL-0003'],
    },
    body: '# Shaders introduction\n\nBody text.',
  }

  it('round-trips the authoritative half', () => {
    const parsed = parseFile(renderFrontmatter(note))

    expect(parsed.frontmatter).toMatchObject({
      id: 'SL-0042',
      title: 'Shaders introduction',
      status: 'active',
      rev: 7,
      bodyHash: 'sha256:abc',
      tags: ['graphics', 'glsl'],
      aliases: ['shader intro'],
      keywordsManual: ['fragment shader'],
      phrasesManual: ['how a fragment shader runs'],
    })
    expect(parsed.body).toBe('# Shaders introduction\n\nBody text.')
  })

  it('writes the generated half but never reads it back', () => {
    const rendered = renderFrontmatter(note)

    expect(rendered).toContain('keywords_auto')
    expect(rendered).toContain('backlinks')
    expect(rendered).toContain('discarded on import')

    // Nothing generated appears on the parsed side, whatever the file says.
    const parsed = parseFile(rendered) as unknown as Record<string, unknown>
    expect(JSON.stringify(parsed)).not.toContain('uniform')
  })

  it('treats a file without frontmatter as a body alone', () => {
    const parsed = parseFile('# Just a note\n\nNo frontmatter here.')

    expect(parsed.frontmatter).toBeNull()
    expect(parsed.body).toContain('Just a note')
  })

  it('tolerates a single tag written as a string, the way Obsidian does', () => {
    const parsed = parseFile('---\nid: SL-0001\ntags: graphics\n---\n\nBody.\n')
    expect(parsed.frontmatter?.tags).toEqual(['graphics'])
  })

  it('rejects frontmatter that is not valid YAML', () => {
    expect(() => parseFile('---\nid: [unclosed\n---\n\nBody.\n')).toThrow()
  })

  it('names files id first, so resolution never depends on the title', () => {
    expect(exportFilename('SL-0042', 'Shaders introduction')).toBe('SL-0042 Shaders introduction.md')
    expect(exportFilename('SL-0042', 'a/b: c?')).toBe('SL-0042 a b c.md')
    expect(exportFilename('SL-0042', '')).toBe('SL-0042.md')

    expect(idFromFilename('SL-0042 Shaders introduction.md')).toBe('SL-0042')
    expect(idFromFilename('notes about shaders.md')).toBeNull()
  })
})

describe('the markdown bridge', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let projectDir: string

  beforeEach(() => {
    sandbox = createSandbox()
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    // Git is exercised on its own; the bridge tests are about the files.
    config.export.commit = false
    setConfig(db, config)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const addNote = (body: string): string =>
    writeNewNote(db, config, body, { author: 'test' }).note.id

  const exportDir = (): string => path.join(projectDir, 'export')
  const read = (file: string): string => fs.readFileSync(path.join(exportDir(), file), 'utf8')

  it('writes a file per note and reports what changed', () => {
    addNote(SHADERS)
    addNote(GARDENING)

    const first = exportProject(db, config, projectDir)
    expect(first.created).toHaveLength(2)
    expect(first.updated).toEqual([])

    const second = exportProject(db, config, projectDir)
    expect(second.created).toEqual([])
    expect(second.unchanged).toHaveLength(2)
  })

  it('exports archived notes too, so they survive the round trip', () => {
    const id = addNote(SHADERS)
    writeNoteBody(db, config, id, SHADERS, { author: 'test' })
    db.prepare("UPDATE notes SET status = 'archived' WHERE id = ?").run(id)

    exportProject(db, config, projectDir)
    expect(read('SL-0001 Shaders introduction.md')).toContain('status: archived')
  })

  it('removes the old file when a note is renamed', () => {
    const id = addNote(SHADERS)
    exportProject(db, config, projectDir)

    writeNoteBody(db, config, id, SHADERS, { title: 'Shaders, revisited', author: 'test' })
    const report = exportProject(db, config, projectDir)

    expect(report.removed).toEqual(['SL-0001 Shaders introduction.md'])
    expect(fs.existsSync(path.join(exportDir(), 'SL-0001 Shaders, revisited.md'))).toBe(true)
  })

  it('leaves files it did not write alone', () => {
    addNote(SHADERS)
    exportProject(db, config, projectDir)

    const stray = path.join(exportDir(), 'my own notes.md')
    fs.writeFileSync(stray, '# Mine\n', 'utf8')

    exportProject(db, config, projectDir)
    expect(fs.existsSync(stray)).toBe(true)
  })

  it('carries tags, aliases and manual terms across a full round trip', () => {
    const id = addNote(SHADERS)
    setNoteTags(db, id, ['graphics', 'glsl'])
    addAlias(db, id, 'shader intro')
    addNoteTerm(db, id, {
      term: 'fragment shader',
      lemma: lemmaKey('fragment shader'),
      kind: 'keyword',
      score: 1,
      source: 'manual',
    })

    exportProject(db, config, projectDir)

    // Wipe the metadata, then bring it back from the file.
    setNoteTags(db, id, [])
    for (const alias of listAliases(db, id)) db.prepare('DELETE FROM aliases WHERE note_id = ?').run(alias.noteId)
    db.prepare('DELETE FROM note_terms WHERE note_id = ?').run(id)

    importProject(db, config, projectDir)

    expect(listTags(db, id)).toEqual(['glsl', 'graphics'])
    expect(listAliases(db, id).map((entry) => entry.alias)).toEqual(['shader intro'])
    expect(noteTerms(db, id).map((term) => term.term)).toContain('fragment shader')
  })

  it('brings an edited body back and records it as an import', () => {
    const id = addNote(SHADERS)
    exportProject(db, config, projectDir)

    const file = path.join(exportDir(), 'SL-0001 Shaders introduction.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('single colour', 'single colour value'))

    const report = importProject(db, config, projectDir)

    expect(report.updated).toEqual([id])
    expect(requireNote(db, id).body).toContain('single colour value')
    expect(listRevisions(db, id)[0]?.op).toBe('import')
  })

  it('creates a note for a file the database has never seen', () => {
    addNote(SHADERS)
    exportProject(db, config, projectDir)

    fs.writeFileSync(
      path.join(exportDir(), 'SL-0050 Imported.md'),
      '---\nid: SL-0050\ntitle: Imported\nrev: 1\n---\n\n# Imported\n\nWritten by hand.\n',
      'utf8',
    )

    const report = importProject(db, config, projectDir)
    expect(report.created).toEqual(['SL-0050'])
    expect(requireNote(db, 'SL-0050').title).toBe('Imported')
  })

  it('ignores edits to the generated half', () => {
    const id = addNote(SHADERS)
    exportProject(db, config, projectDir)

    const file = path.join(exportDir(), 'SL-0001 Shaders introduction.md')
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('outline:', 'outline: nonsense\nignored_outline:'),
    )

    importProject(db, config, projectDir)
    expect(requireNote(db, id).outline).not.toContain('nonsense')
  })

  it('skips a file with no frontmatter and says why', () => {
    addNote(SHADERS)
    exportProject(db, config, projectDir)
    fs.writeFileSync(path.join(exportDir(), 'foreign.md'), '# Foreign\n\nNo frontmatter.\n', 'utf8')

    const report = importProject(db, config, projectDir)
    expect(report.skipped[0]?.file).toBe('foreign.md')
    expect(report.skipped[0]?.reason).toContain('adopt')
  })

  it('changes nothing on a dry run', () => {
    const id = addNote(SHADERS)
    exportProject(db, config, projectDir)

    const file = path.join(exportDir(), 'SL-0001 Shaders introduction.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('single colour', 'something else'))

    const report = importProject(db, config, projectDir, { dryRun: true })

    expect(report.updated).toEqual([id])
    expect(requireNote(db, id).body).toContain('single colour')
  })
})

describe('import conflicts', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let projectDir: string

  beforeEach(() => {
    sandbox = createSandbox()
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    config.export.commit = false
    setConfig(db, config)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  /** Export, edit the file, then change the note again so both sides moved. */
  function diverge(): { id: string; file: string } {
    const id = writeNewNote(db, config, SHADERS, { author: 'test' }).note.id
    exportProject(db, config, projectDir)

    const file = path.join(projectDir, 'export', 'SL-0001 Shaders introduction.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('single colour', 'the file version'))

    writeNoteBody(db, config, id, SHADERS.replace('single colour', 'the database version'), {
      author: 'test',
    })

    return { id, file }
  }

  it('reports and changes nothing by default', () => {
    const { id } = diverge()
    const report = importProject(db, config, projectDir)

    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]?.resolution).toBe('reported')
    expect(requireNote(db, id).body).toContain('the database version')
  })

  it('keeps the database when told to', () => {
    const { id } = diverge()
    const report = importProject(db, config, projectDir, { onConflict: 'db' })

    expect(report.conflicts[0]?.resolution).toBe('kept-database')
    expect(requireNote(db, id).body).toContain('the database version')
  })

  it('takes the file when told to', () => {
    const { id } = diverge()
    const report = importProject(db, config, projectDir, { onConflict: 'file' })

    expect(report.conflicts[0]?.resolution).toBe('took-file')
    expect(requireNote(db, id).body).toContain('the file version')
  })

  it('keeps both, losing nothing, and links the copy to the original', () => {
    const { id } = diverge()
    const report = importProject(db, config, projectDir, { onConflict: 'both' })

    const copyId = report.conflicts[0]?.copyId
    expect(report.conflicts[0]?.resolution).toBe('kept-both')
    expect(copyId).toBeDefined()

    expect(requireNote(db, id).body).toContain('the database version')
    const copy = requireNote(db, copyId!)
    expect(copy.body).toContain('the file version')
    expect(copy.title).toContain('conflict copy')
    expect(copy.body).toContain(id)
  })

  it('is not a conflict when only the file moved', () => {
    const id = writeNewNote(db, config, SHADERS, { author: 'test' }).note.id
    exportProject(db, config, projectDir)

    const file = path.join(projectDir, 'export', 'SL-0001 Shaders introduction.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('single colour', 'an edit'))

    const report = importProject(db, config, projectDir)
    expect(report.conflicts).toEqual([])
    expect(report.updated).toEqual([id])
  })
})
