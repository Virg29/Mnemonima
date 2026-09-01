import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_MODEL_ID, lemmaKey } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  createProject,
  createSandbox,
  findTerm,
  getConfig,
  listTerms,
  noteTerms,
  promotionCandidates,
  setConfig,
  setTermFlags,
  upsertTerm,
} from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { createEmbedder } from './embedder.js'
import type { ResolvedEmbedder } from './embedder.js'
import { indexProject } from './indexer.js'
import { writeNewNote } from './notes.js'
import { searchNotes } from './search.js'
import { matchGazetteer } from './terms.js'

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour to
the framebuffer. The rasterizer decides which pixels a triangle covers.

## Fragment stage

Interpolated attributes arrive from the vertex stage. The depth test can discard
a fragment before the fragment shader ever runs.

\`\`\`glsl
void main() { gl_FragColor = vec4(1.0); }
\`\`\`
`

const UNIFORMS = `# Uniform buffers

A uniform buffer holds constants that stay the same for a whole draw call.

## Layout rules

Standard layout pads every member to a sixteen byte boundary.
`

const GARDENING = `# Tomato planting

Tomatoes want full sun and a deep bed of compost before the last frost. Compost
improves both drainage and water retention.
`

describe('term extraction', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let embedder: ResolvedEmbedder

  beforeEach(async () => {
    sandbox = createSandbox()

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    config.search.limits.minSimilarity = 0
    setConfig(db, config)

    embedder = await createEmbedder(config)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const addNote = (body: string): string =>
    writeNewNote(db, config, body, { author: 'test' }).note.id

  const seed = async (): Promise<void> => {
    addNote(SHADERS)
    addNote(UNIFORMS)
    addNote(GARDENING)
    await indexProject(db, config, embedder)
  }

  it('extracts the subject of a note and not its markup', async () => {
    const id = addNote(SHADERS)
    await indexProject(db, config, embedder)

    const terms = noteTerms(db, id).map((term) => term.term)

    expect(terms).toContain('shader')
    // Markdown syntax must never reach a term: extraction reads the plain
    // rendering, not the source.
    expect(terms.every((term) => !term.includes('#'))).toBe(true)
  })

  it('keeps the head noun as well as the phrase it sits in', async () => {
    const id = addNote(SHADERS)
    await indexProject(db, config, embedder)

    const lemmas = noteTerms(db, id).map((term) => term.lemma)

    expect(lemmas).toContain('shader')
    expect(lemmas.some((lemma) => lemma.includes(' ') && lemma.includes('shader'))).toBe(true)
  })

  it('ignores fenced code, which would otherwise swamp the prose', async () => {
    const id = addNote(SHADERS)
    await indexProject(db, config, embedder)

    const terms = noteTerms(db, id).map((term) => term.term.toLowerCase())
    expect(terms.some((term) => term.includes('gl_fragcolor') || term.includes('vec4'))).toBe(false)
  })

  it('records the term for the note that is actually about it', async () => {
    await seed()

    const gardening = noteTerms(db, 'SL-0003').map((term) => term.lemma)
    expect(gardening).toContain('compost')
    expect(gardening).not.toContain('shader')
  })

  it('is idempotent: re-indexing does not accumulate terms', async () => {
    await seed()
    const before = listTerms(db, { limit: 500 }).length

    await indexProject(db, config, embedder, { full: true })

    expect(listTerms(db, { limit: 500 }).length).toBe(before)
  })

  it('counts how many notes carry each term', async () => {
    addNote('# One\n\nThe fragment shader writes a colour.\n')
    addNote('# Two\n\nAnother fragment shader, another colour.\n')
    await indexProject(db, config, embedder)

    expect(findTerm(db, 'shader')?.df).toBe(2)
  })
})

describe('the manual vocabulary', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let embedder: ResolvedEmbedder

  beforeEach(async () => {
    sandbox = createSandbox()

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
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

  it('attaches a manual term wherever it literally appears', async () => {
    const id = addNote(SHADERS)
    upsertTerm(db, { term: 'depth test', lemma: lemmaKey('depth test'), source: 'manual' })

    await indexProject(db, config, embedder)

    const manual = noteTerms(db, id).filter((term) => term.source === 'manual')
    expect(manual.map((term) => term.term)).toEqual(['depth test'])
    expect(manual[0]?.score).toBe(1)
  })

  it('attaches a manual term even with automatic extraction switched off', async () => {
    const id = addNote(SHADERS)
    upsertTerm(db, { term: 'depth test', lemma: lemmaKey('depth test'), source: 'manual' })

    config.keywords.autoEnabled = false
    setConfig(db, config)
    await indexProject(db, config, embedder)

    const terms = noteTerms(db, id)
    expect(terms.map((term) => term.term)).toEqual(['depth test'])
  })

  it('keeps a blocked term out of every note', async () => {
    const id = addNote(SHADERS)
    await indexProject(db, config, embedder)
    expect(noteTerms(db, id).map((term) => term.lemma)).toContain('shader')

    setTermFlags(db, 'shader', { blocked: true })
    await indexProject(db, config, embedder, { full: true })

    expect(noteTerms(db, id).map((term) => term.lemma)).not.toContain('shader')
  })

  it('promotes an automatic term to manual rather than duplicating it', async () => {
    addNote(SHADERS)
    await indexProject(db, config, embedder)

    const before = listTerms(db, { limit: 500 }).length
    upsertTerm(db, { term: 'shader', lemma: 'shader', source: 'manual' })

    expect(listTerms(db, { limit: 500 }).length).toBe(before)
    expect(findTerm(db, 'shader')?.source).toBe('manual')
    expect(findTerm(db, 'shader')?.pinned).toBe(true)
  })

  it('surfaces automatic terms worth a decision', async () => {
    addNote('# One\n\nThe fragment shader writes a colour.\n')
    addNote('# Two\n\nAnother fragment shader, another colour.\n')
    await indexProject(db, config, embedder)

    const candidates = promotionCandidates(db, 2, 0)
    expect(candidates.map((entry) => entry.term)).toContain('shader')

    // Pinned terms are already decided and drop off the list.
    setTermFlags(db, 'shader', { pinned: true })
    expect(promotionCandidates(db, 2, 0).map((entry) => entry.term)).not.toContain('shader')
  })

  it('matches gazetteer terms only on whole words', () => {
    const gazetteer = [{ term: 'shade', lemma: 'shade', words: 1 }]

    expect(matchGazetteer('a shader runs', gazetteer)).toEqual([])
    expect(matchGazetteer('the shade of a tree', gazetteer)).toEqual(['shade'])
  })
})

describe('the knobs', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let embedder: ResolvedEmbedder

  beforeEach(async () => {
    sandbox = createSandbox()

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    config.search.limits.minSimilarity = 0
    setConfig(db, config)

    embedder = await createEmbedder(config)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const addNote = (body: string): string =>
    writeNewNote(db, config, body, { author: 'test' }).note.id

  it('autoEnabled false leaves only what you entered by hand', async () => {
    const id = addNote(SHADERS)
    config.keywords.autoEnabled = false
    setConfig(db, config)

    await indexProject(db, config, embedder)
    expect(noteTerms(db, id)).toEqual([])
  })

  it('topNKeywords caps how many survive', async () => {
    const id = addNote(SHADERS)
    config.keywords.topNKeywords = 3
    config.keywords.minScore = 0
    setConfig(db, config)

    await indexProject(db, config, embedder)

    const keywords = noteTerms(db, id).filter((term) => term.kind === 'keyword')
    expect(keywords.length).toBeLessThanOrEqual(3)
  })

  it('minScore raises the bar', async () => {
    const id = addNote(SHADERS)

    config.keywords.minScore = 0
    setConfig(db, config)
    await indexProject(db, config, embedder, { full: true })
    const permissive = noteTerms(db, id).length

    config.keywords.minScore = 0.95
    setConfig(db, config)
    await indexProject(db, config, embedder, { full: true })
    const strict = noteTerms(db, id).length

    expect(strict).toBeLessThan(permissive)
  })

  it('autoWeight scales how much automatic terms count in search', async () => {
    addNote(SHADERS)
    await indexProject(db, config, embedder)

    const full = await searchNotes(db, config, null, 'shader', { mode: 'lexical' })

    config.keywords.autoWeight = 0
    const silenced = await searchNotes(db, config, null, 'shader', { mode: 'lexical' })

    expect(full.hits[0]?.why.meta).toBeGreaterThan(0)
    expect(silenced.hits[0]?.why.meta ?? 0).toBeLessThanOrEqual(full.hits[0]?.why.meta ?? 0)
  })

  it('feeds the terms into the note index, so a term finds its note', async () => {
    const id = addNote(GARDENING)
    addNote(SHADERS)
    await indexProject(db, config, embedder)

    const result = await searchNotes(db, config, null, 'compost', { mode: 'lexical' })
    expect(result.hits[0]?.id).toBe(id)
    expect(result.hits[0]?.why.meta).toBeGreaterThan(0)
  })
})
