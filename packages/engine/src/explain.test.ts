import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundError, TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { addAlias, createProject, createSandbox, getConfig, setConfig } from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { createEmbedder } from './embedder.js'
import type { ResolvedEmbedder } from './embedder.js'
import { indexProject } from './indexer.js'
import { writeNewNote } from './notes.js'
import { explainNote } from './search.js'

/**
 * Why one note came back for one query.
 *
 * The offline model is a hashing vectoriser, so its "meaning" is lexical. That
 * is enough for everything structural here: which passages are marked as having
 * scored, what the lexical pass was actually looking for, and which of the
 * note's own names the query hit.
 */

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour.

## Fragment stage

Interpolated attributes arrive from the vertex stage and feed the shader.

## Depth

The depth test rejects a fragment before the shader ever runs on it.
`

describe('explaining a hit', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let embedder: ResolvedEmbedder
  let id: string

  beforeEach(async () => {
    sandbox = createSandbox()

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    config.search.limits.minSimilarity = 0
    setConfig(db, config)

    embedder = await createEmbedder(config)

    id = writeNewNote(db, config, SHADERS, { author: 'test' }).note.id
    await indexProject(db, config, embedder)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const explain = (query: string) => explainNote(db, config, embedder, id, query)

  it('returns the words the lexical pass looked for, without the stop words', async () => {
    const result = await explain('how does a fragment shader run')

    expect(result.words).toContain('fragment')
    expect(result.words).toContain('shader')
    // Underlining "how" and "a" would point at words that scored nothing:
    // they are dropped before the query reaches BM25.
    expect(result.words).not.toContain('how')
    expect(result.words).not.toContain('a')
  })

  it('marks the best passage of each strategy as the one that scored', async () => {
    const result = await explain('fragment shader')

    const scoring = result.passages.filter((passage) => passage.scoring)

    // Fusion reads the best chunk per strategy and nothing else (DESIGN.md
    // 8.4); the rest reach the score only through the multi-chunk count.
    expect(scoring.length).toBeLessThanOrEqual(2)
    expect(new Set(scoring.map((passage) => passage.strategy)).size).toBe(scoring.length)

    for (const passage of scoring) {
      const others = result.passages.filter(
        (other) => other.strategy === passage.strategy && !other.scoring,
      )
      for (const other of others) expect(passage.combined).toBeGreaterThanOrEqual(other.combined)
    }
  })

  it('returns more passages than a result list would show', async () => {
    // The point of a route of its own: a hit carries two snippets, and marking
    // a body needs every passage that matched.
    const result = await explain('fragment shader')

    expect(result.passages.length).toBeGreaterThan(2)
  })

  it('says which of the names a note answers to the query hit', async () => {
    addAlias(db, id, 'shaders')

    const result = await explain('shaders introduction')

    const fields = result.fields.map((field) => field.field)
    expect(fields).toContain('title')
    expect(fields).toContain('alias')
  })

  it('has no fields when the query shares nothing with the names', async () => {
    // Not a word from the body either: terms are extracted from it, so any
    // word the note uses can turn up as one of its own names.
    expect((await explain('tomato compost')).fields).toEqual([])
  })

  it('gives every passage both halves of its score', async () => {
    const result = await explain('fragment shader')

    for (const passage of result.passages) {
      expect(passage.textScore).toBeGreaterThanOrEqual(0)
      expect(passage.vectorScore).toBeGreaterThanOrEqual(0)
    }
  })

  it('attributes nothing to words in a purely semantic search', async () => {
    // The honest case: a cosine does not decompose into words, so the passage
    // that scored has a text component of exactly zero and the bar is all one
    // colour.
    const result = await explainNote(db, config, embedder, id, 'fragment shader', {
      mode: 'semantic',
    })

    for (const passage of result.passages) expect(passage.textScore).toBe(0)
  })

  it('refuses a note that does not exist, and says how to look', async () => {
    await expect(explainNote(db, config, embedder, 'SL-9999', 'anything')).rejects.toThrow(
      NotFoundError,
    )
  })
})
