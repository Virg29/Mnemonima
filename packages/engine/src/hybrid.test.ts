import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, NotFoundError, TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { createProject, createSandbox, getConfig, setConfig } from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { createEmbedder } from './embedder.js'
import type { ResolvedEmbedder } from './embedder.js'
import { indexProject } from './indexer.js'
import { writeNewNote } from './notes.js'
import { searchNotes } from './search.js'

/**
 * Hybrid search — the stage-two behaviour.
 *
 * The offline model is a hashing vectoriser, so its "semantic" scores are
 * lexical. That is enough to test everything structural: mode routing, the
 * arithmetic of the fusion, whether `why` decomposes into the total, and the
 * paths that never touch a vector at all. Judging retrieval *quality* is what
 * the eval harness is for, and it needs a real model.
 */

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour.

## Fragment stage

Interpolated attributes arrive from the vertex stage and feed the shader.
`

const UNIFORMS = `# Uniform buffers

A uniform buffer holds constants that stay the same for a whole draw call.

## Layout rules

Standard layout pads every member to a sixteen byte boundary, and gl_FragColor
is written once.
`

const GARDENING = `# Tomato planting

Tomatoes want full sun and a deep bed of compost before the last frost.
`

describe('search modes', () => {
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

  it('hybrid uses both signals and reports each one', async () => {
    await seed()

    const result = await searchNotes(db, config, embedder, 'uniform buffer layout')
    const hit = result.hits[0]

    expect(result.mode).toBe('hybrid')
    expect(hit?.title).toBe('Uniform buffers')
    expect(hit?.why.text).toBeGreaterThan(0)
    expect(hit?.why.vector).toBeGreaterThan(0)
  })

  it('why decomposes exactly into the score', async () => {
    await seed()

    const result = await searchNotes(db, config, embedder, 'fragment shader pixel')

    for (const hit of result.hits) {
      const parts =
        hit.why.text + hit.why.vector + hit.why.meta + hit.why.multiChunk + hit.why.graph
      expect(parts).toBeCloseTo(hit.score, 5)
    }
  })

  it('lexical contributes no vector score and needs no embedder', async () => {
    await seed()

    const result = await searchNotes(db, config, null, 'rasterized', { mode: 'lexical' })

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0]?.title).toBe('Shaders introduction')
    expect(result.hits.every((hit) => hit.why.vector === 0)).toBe(true)
  })

  it('semantic contributes no text or metadata score', async () => {
    await seed()

    const result = await searchNotes(db, config, embedder, 'fragment shader pixel', {
      mode: 'semantic',
    })

    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.every((hit) => hit.why.text === 0)).toBe(true)
    expect(result.hits.every((hit) => hit.why.meta === 0)).toBe(true)
  })

  it('refuses a vector mode when no embedder was supplied', async () => {
    await seed()

    await expect(
      searchNotes(db, config, null, 'shader', { mode: 'semantic' }),
    ).rejects.toBeInstanceOf(BadRequestError)
  })

  it('weights override the configured balance', async () => {
    await seed()

    const textOnly = await searchNotes(db, config, embedder, 'rasterized', {
      weights: { text: 1, vector: 0 },
    })
    const lexical = await searchNotes(db, config, null, 'rasterized', { mode: 'lexical' })

    expect(textOnly.weights).toEqual({ text: 1, vector: 0 })
    expect(textOnly.hits.map((hit) => hit.id)).toEqual(lexical.hits.map((hit) => hit.id))
  })

  it('rejects weights that are both zero', async () => {
    await seed()

    await expect(
      searchNotes(db, config, embedder, 'shader', { weights: { text: 0, vector: 0 } }),
    ).rejects.toBeInstanceOf(BadRequestError)
  })

  it('finds a note on metadata alone', async () => {
    const id = addNote(SHADERS)
    // An alias shares no words with the body, so only the note index can match.
    db.prepare('INSERT INTO aliases (note_id, alias, source) VALUES (?, ?, ?)').run(
      id,
      'photosynthesis primer',
      'manual',
    )
    await indexProject(db, config, embedder)

    const result = await searchNotes(db, config, null, 'photosynthesis', { mode: 'lexical' })
    const hit = result.hits[0]

    expect(hit?.id).toBe(id)
    expect(hit?.why.meta).toBeGreaterThan(0)
    expect(hit?.why.matchedChunks).toBe(0)
    expect(hit?.snippets).toHaveLength(0)
  })

  it('stays silent on metadata when the query does not match it as a whole', async () => {
    await seed()

    // Metadata fields are short, so "at least one term matched" would hand the
    // best of several irrelevant notes the full metadata score after
    // normalisation. Every term has to be there.
    const unrelated = await searchNotes(db, config, embedder, 'how does a pixel get its colour')
    expect(unrelated.hits.every((hit) => hit.why.meta === 0)).toBe(true)

    const onTopic = await searchNotes(db, config, embedder, 'uniform buffer layout rules')
    expect(onTopic.hits[0]?.title).toBe('Uniform buffers')
    expect(onTopic.hits[0]?.why.meta).toBeGreaterThan(0)
  })

  it('does not let stop words carry the text score', async () => {
    await seed()

    // Orama counts a document that matched *any* term as a hit, and BM25 is
    // normalised per result set, so "in a warm bed" used to hand the full text
    // score to whichever unrelated note matched "in" and "a" best.
    const result = await searchNotes(db, config, embedder, 'growing vegetables in a warm bed')
    const shaders = result.hits.find((hit) => hit.title === 'Shaders introduction')

    expect(shaders?.why.text ?? 0).toBe(0)
  })

  it('is deterministic across runs', async () => {
    await seed()

    const first = await searchNotes(db, config, embedder, 'shader colour')
    const second = await searchNotes(db, config, embedder, 'shader colour')

    expect(first.hits.map((hit) => [hit.id, hit.score])).toEqual(
      second.hits.map((hit) => [hit.id, hit.score]),
    )
  })

  it('honours the result limit', async () => {
    await seed()

    const capped = await searchNotes(db, config, embedder, 'shader', { limit: 1 })
    expect(capped.hits.length).toBeLessThanOrEqual(1)
  })
})

describe('exact and id modes', () => {
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

  const addNote = (body: string): string =>
    writeNewNote(db, config, body, { author: 'test' }).note.id

  it('greps note bodies without any index', async () => {
    addNote(SHADERS)
    addNote(UNIFORMS)

    // Deliberately never indexed: exact search must work before the first run.
    const result = await searchNotes(db, config, null, 'gl_FragColor', { mode: 'exact' })

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.title).toBe('Uniform buffers')
    expect(result.hits[0]?.snippets[0]?.headingPath).toMatch(/^line \d+$/)
  })

  it('matches case-insensitively and treats the query as literal text', async () => {
    addNote(UNIFORMS)

    expect((await searchNotes(db, config, null, 'GL_FRAGCOLOR', { mode: 'exact' })).hits).toHaveLength(1)
    // A regex metacharacter is literal unless the query is delimited.
    expect((await searchNotes(db, config, null, 'gl_Frag.olor', { mode: 'exact' })).hits).toHaveLength(0)
  })

  it('treats /pattern/flags as a regular expression', async () => {
    addNote(UNIFORMS)

    const result = await searchNotes(db, config, null, '/gl_Frag\\w+/', { mode: 'exact' })
    expect(result.hits).toHaveLength(1)
  })

  it('reports a malformed regular expression', async () => {
    addNote(UNIFORMS)

    await expect(
      searchNotes(db, config, null, '/gl_Frag(/', { mode: 'exact' }),
    ).rejects.toBeInstanceOf(BadRequestError)
  })

  it('ranks a note with more occurrences higher', async () => {
    addNote('# Repeats\n\nshader shader\n\nshader again\n')
    addNote('# Once\n\nshader appears once here.\n')

    const result = await searchNotes(db, config, null, 'shader', { mode: 'exact' })
    expect(result.hits[0]?.title).toBe('Repeats')
  })

  it('looks a note up by id', async () => {
    const id = addNote(SHADERS)

    const result = await searchNotes(db, config, null, id, { mode: 'id' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.id).toBe(id)
  })

  it('reports an unknown id', async () => {
    await expect(
      searchNotes(db, config, null, 'SL-9999', { mode: 'id' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

})
