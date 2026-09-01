import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LanguageGateError, TEST_MODEL_ID, resolveModel } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  countEmbeddings,
  createProject,
  createSandbox,
  deleteNote,
  getConfig,
  listNoteChunks,
  requireActiveSpace,
  setConfig,
} from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { createEmbedder } from './embedder.js'
import type { ResolvedEmbedder } from './embedder.js'
import { indexProject } from './indexer.js'
import { writeNewNote, writeNoteBody } from './notes.js'
import { searchNotes } from './search.js'

/**
 * End-to-end coverage of the stage-one pipeline: author, chunk, embed, search.
 * It runs on the deterministic hashing model, so it needs no download and its
 * rankings are reproducible.
 */

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour.

## Fragment stage

Interpolated attributes arrive from the vertex stage and feed the shader.
`

const UNIFORMS = `# Uniform buffers

A uniform buffer holds constants that stay the same for a whole draw call.

## Layout rules

Standard layout pads every member to a sixteen byte boundary.
`

const GARDENING = `# Tomato planting

Tomatoes want full sun and a deep bed of compost before the last frost.
`

describe('indexing and search', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let embedder: ResolvedEmbedder

  beforeEach(async () => {
    sandbox = createSandbox()

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'shaders') })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)

    embedder = await createEmbedder(config)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const addNote = (body: string): string =>
    writeNewNote(db, config, body, { author: 'test' }).note.id

  it('chunks each note with both strategies and embeds every unique text', async () => {
    addNote(SHADERS)
    const report = await indexProject(db, config, embedder)

    expect(report.notesTotal).toBe(1)
    expect(report.notesChunked).toBe(1)
    expect(report.chunks).toBeGreaterThan(1)
    expect(report.embedded).toBe(report.uniqueTexts)
    expect(report.reused).toBe(0)
    expect(report.active).toBe(true)

    expect(countEmbeddings(db, report.spaceId)).toBe(report.uniqueTexts)
  })

  it('is idempotent: a second run embeds nothing', async () => {
    addNote(SHADERS)
    await indexProject(db, config, embedder)

    const second = await indexProject(db, config, embedder)

    expect(second.embedded).toBe(0)
    expect(second.notesChunked).toBe(0)
    expect(second.notesUnchanged).toBe(1)
    expect(second.reused).toBe(second.uniqueTexts)
  })

  it('re-embeds only what changed when one paragraph is edited', async () => {
    const id = addNote(SHADERS)
    const first = await indexProject(db, config, embedder)

    writeNoteBody(
      db,
      config,
      id,
      SHADERS.replace('writes a single colour', 'writes a single colour value'),
      { author: 'test' },
    )

    const second = await indexProject(db, config, embedder)

    expect(second.notesChunked).toBe(1)
    expect(second.embedded).toBeGreaterThan(0)
    expect(second.embedded).toBeLessThan(first.uniqueTexts)
    expect(second.reused).toBeGreaterThan(0)
  })

  it('rebuilds everything with --full', async () => {
    addNote(SHADERS)
    const first = await indexProject(db, config, embedder)
    const forced = await indexProject(db, config, embedder, { full: true })

    expect(forced.embedded).toBe(first.uniqueTexts)
  })

  it('builds a different space when the chunking configuration changes', async () => {
    addNote(SHADERS)
    const first = await indexProject(db, config, embedder)

    config.chunking.strategies.fine.targetTokens = 90
    const second = await indexProject(db, config, embedder)

    expect(second.spaceId).not.toBe(first.spaceId)
    expect(requireActiveSpace(db).id).toBe(second.spaceId)
  })

  it('drops chunks of a note that shrank', async () => {
    const id = addNote(SHADERS)
    const first = await indexProject(db, config, embedder)
    const before = listNoteChunks(db, first.spaceId, id).length

    writeNoteBody(db, config, id, '# Shaders introduction\n\nOne line now.\n', { author: 'test' })
    const second = await indexProject(db, config, embedder)

    expect(listNoteChunks(db, second.spaceId, id).length).toBeLessThan(before)
  })

  it('retires an archived note: its chunks go and search stops returning it', async () => {
    const kept = addNote(SHADERS)
    const doomed = addNote(GARDENING)
    const first = await indexProject(db, config, embedder)

    expect(listNoteChunks(db, first.spaceId, doomed).length).toBeGreaterThan(0)

    deleteNote(db, doomed, { author: 'test' })
    const second = await indexProject(db, config, embedder)

    expect(second.notesDropped).toBe(1)
    expect(listNoteChunks(db, second.spaceId, doomed)).toHaveLength(0)
    expect(listNoteChunks(db, second.spaceId, kept).length).toBeGreaterThan(0)

    const result = await searchNotes(db, config, embedder, 'tomatoes compost sun', {
      mode: 'semantic',
      minSimilarity: 0,
    })
    expect(result.hits.map((hit) => hit.id)).not.toContain(doomed)
  })

  it('hides an archived note from search even before the next index run', async () => {
    addNote(GARDENING)
    await indexProject(db, config, embedder)

    const before = await searchNotes(db, config, embedder, 'tomatoes compost sun', {
      mode: 'semantic',
      minSimilarity: 0,
    })
    expect(before.hits.length).toBe(1)

    deleteNote(db, before.hits[0]!.id, { author: 'test' })

    const after = await searchNotes(db, config, embedder, 'tomatoes compost sun', {
      mode: 'semantic',
      minSimilarity: 0,
    })
    expect(after.hits).toHaveLength(0)
  })

  it('ranks the topically closest note first', async () => {
    addNote(SHADERS)
    addNote(UNIFORMS)
    addNote(GARDENING)
    await indexProject(db, config, embedder)

    const result = await searchNotes(db, config, embedder, 'uniform buffer layout rules', {
      mode: 'semantic',
      minSimilarity: 0,
    })

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.title).toBe('Uniform buffers')
  })

  it('reports why a note matched', async () => {
    addNote(SHADERS)
    await indexProject(db, config, embedder)

    const result = await searchNotes(db, config, embedder, 'fragment shader rasterized pixel', {
      mode: 'semantic',
      minSimilarity: 0,
    })
    const hit = result.hits[0]

    expect(hit?.why.vector).toBeGreaterThan(0)
    expect(hit?.why.matchedChunks).toBeGreaterThan(0)
    expect(['fine', 'coarse']).toContain(hit?.why.bestStrategy)
    expect(hit?.snippets.length).toBeGreaterThan(0)
  })

  it('is deterministic across runs', async () => {
    addNote(SHADERS)
    addNote(UNIFORMS)
    await indexProject(db, config, embedder)

    const first = await searchNotes(db, config, embedder, 'shader pixel', { mode: 'semantic', minSimilarity: 0 })
    const second = await searchNotes(db, config, embedder, 'shader pixel', { mode: 'semantic', minSimilarity: 0 })

    expect(first.hits.map((hit) => hit.id)).toEqual(second.hits.map((hit) => hit.id))
    expect(first.hits.map((hit) => hit.score)).toEqual(second.hits.map((hit) => hit.score))
  })

  it('honours the similarity floor and the result limit', async () => {
    addNote(SHADERS)
    addNote(UNIFORMS)
    addNote(GARDENING)
    await indexProject(db, config, embedder)

    const wide = await searchNotes(db, config, embedder, 'shader', { mode: 'semantic', minSimilarity: 0 })
    const narrow = await searchNotes(db, config, embedder, 'shader', { mode: 'semantic', minSimilarity: 0.99 })
    const capped = await searchNotes(db, config, embedder, 'shader', {
      mode: 'semantic',
      minSimilarity: 0,
      limit: 1,
    })

    expect(narrow.hits.length).toBeLessThanOrEqual(wide.hits.length)
    expect(capped.hits.length).toBeLessThanOrEqual(1)
  })

  it('refuses a non-English query before doing any work', async () => {
    addNote(SHADERS)
    await indexProject(db, config, embedder)

    await expect(
      searchNotes(db, config, embedder, 'шейдеры', { mode: 'semantic' }),
    ).rejects.toBeInstanceOf(LanguageGateError)
  })

  it('refuses a non-English note body', () => {
    expect(() => writeNewNote(db, config, '# Заметка\n\nтекст', { author: 'test' })).toThrow(
      LanguageGateError,
    )
  })

  it('derives the outline from the note headings', () => {
    const { note } = writeNewNote(db, config, SHADERS, { author: 'test' })
    expect(note.outline).toBe('1. Shaders introduction\n  1.1. Fragment stage')
  })

  it('fails when no active space exists yet', async () => {
    addNote(SHADERS)
    await expect(searchNotes(db, config, embedder, 'shaders', { mode: 'semantic' })).rejects.toThrow()
  })

  it('describes the test model as offline so nothing is downloaded', () => {
    expect(resolveModel(TEST_MODEL_ID).offline).toBe(true)
  })
})
