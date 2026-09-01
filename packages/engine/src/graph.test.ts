import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, NotFoundError, TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  addAlias,
  createProject,
  createSandbox,
  danglingLinks,
  getConfig,
  incomingLinks,
  orphanNoteIds,
  outgoingLinks,
  setConfig,
} from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { createEmbedder } from './embedder.js'
import type { ResolvedEmbedder } from './embedder.js'
import { runDoctor, fixDoctorFindings } from './doctor.js'
import { loadGraph, neighboursOf } from './graph.js'
import { indexProject } from './indexer.js'
import { rebuildLinks } from './links.js'
import { writeNewNote, writeNoteBody } from './notes.js'
import { addRelatedLink, removeRelatedLink } from './related.js'
import { searchNotes } from './search.js'

describe('the link graph', () => {
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

  it('records outgoing links as soon as a note is written', () => {
    const target = addNote('# GPU pipeline\n\nThe stages of the pipeline.\n')
    const source = addNote(`# Shaders\n\nSee [[${target}]] for the stage before.\n`)

    const out = outgoingLinks(db, source)
    expect(out).toHaveLength(1)
    expect(out[0]?.dst).toBe(target)
    expect(out[0]?.resolved).toBe(true)
  })

  it('derives backlinks without touching the target note', () => {
    const target = addNote('# GPU pipeline\n\nStages.\n')
    const source = addNote(`# Shaders\n\nSee [[${target}]].\n`)

    expect(incomingLinks(db, target).map((link) => link.src)).toEqual([source])
    // The target's own body says nothing about the link.
    expect(outgoingLinks(db, target)).toEqual([])
  })

  it('keeps a link to an id that does not exist, exactly as written', () => {
    const source = addNote('# Shaders\n\nSee [[EXTERNAL-9999]] for the rest.\n')

    const out = outgoingLinks(db, source)
    expect(out[0]?.dst).toBe('EXTERNAL-9999')
    expect(out[0]?.resolved).toBe(false)
    expect(danglingLinks(db)).toHaveLength(1)
  })

  it('resolves a forward reference once the target arrives', () => {
    const source = addNote('# Shaders\n\nSee [[SL-0002]].\n')
    expect(outgoingLinks(db, source)[0]?.resolved).toBe(false)

    addNote('# GPU pipeline\n\nStages.\n')
    rebuildLinks(db)

    expect(outgoingLinks(db, source)[0]?.resolved).toBe(true)
  })

  it('resolves by alias and by title before falling back', () => {
    const target = addNote('# GPU pipeline\n\nStages.\n')
    addAlias(db, target, 'the pipeline')

    const byTitle = addNote('# A\n\nSee [[GPU pipeline]].\n')
    const byAlias = addNote('# B\n\nSee [[the pipeline]].\n')
    rebuildLinks(db)

    expect(outgoingLinks(db, byTitle)[0]).toMatchObject({ dst: target, resolved: true })
    expect(outgoingLinks(db, byAlias)[0]).toMatchObject({ dst: target, resolved: true })
  })

  it('rewrites links when the body changes', () => {
    const first = addNote('# One\n\nBody.\n')
    const second = addNote('# Two\n\nBody.\n')
    const source = addNote(`# Source\n\nSee [[${first}]].\n`)

    writeNoteBody(db, config, source, `# Source\n\nSee [[${second}]] instead.\n`, { author: 'test' })

    expect(outgoingLinks(db, source).map((link) => link.dst)).toEqual([second])
    expect(incomingLinks(db, first)).toEqual([])
  })

  it('lists neighbours in both directions', () => {
    const middle = addNote('# Middle\n\nBody.\n')
    const behind = addNote('# Behind\n\nBody.\n')
    writeNoteBody(db, config, middle, `# Middle\n\nSee [[${behind}]].\n`, { author: 'test' })
    const ahead = addNote(`# Ahead\n\nSee [[${middle}]].\n`)

    const graph = loadGraph(db)
    const neighbours = neighboursOf(db, graph, middle)

    expect(neighbours.map((entry) => [entry.id, entry.relation]).sort()).toEqual(
      [
        [ahead, 'backlinks'],
        [behind, 'links'],
      ].sort(),
    )
  })

  it('reports orphans, and stops once a note is linked', () => {
    const lonely = addNote('# Lonely\n\nNothing points here.\n')
    const other = addNote('# Other\n\nBody.\n')

    expect(orphanNoteIds(db)).toEqual([lonely, other].sort())

    writeNoteBody(db, config, other, `# Other\n\nSee [[${lonely}]].\n`, { author: 'test' })
    expect(orphanNoteIds(db)).toEqual([])
  })

  it('boosts a note whose neighbour also matched', async () => {
    const partner = addNote('# Rasterization\n\nRasterized pixels are produced here.\n')
    const source = addNote(
      `# Shaders\n\nA fragment shader writes a colour.\n\n## Related\n\n- [[${partner}]]\n`,
    )
    await indexProject(db, config, embedder)

    const result = await searchNotes(db, config, embedder, 'rasterized pixels shader colour')
    const hit = result.hits.find((entry) => entry.id === source)

    expect(hit?.why.graph).toBeGreaterThan(0)
    expect(result.hits.find((entry) => entry.id === partner)?.why.graph).toBeGreaterThan(0)
  })

  it('pulls in a note several results point at, marked with via', async () => {
    const hub = addNote('# Colour theory\n\nUnrelated wording entirely.\n')
    const first = addNote(`# Shaders\n\nA fragment shader.\n\n## Related\n\n- [[${hub}]]\n`)
    const second = addNote(`# Pixels\n\nA fragment shader too.\n\n## Related\n\n- [[${hub}]]\n`)
    await indexProject(db, config, embedder)

    // Lexical: the hub shares no words with the query, so it can only arrive
    // through the graph.
    const result = await searchNotes(db, config, null, 'fragment shader', { mode: 'lexical' })
    const expanded = result.hits.find((entry) => entry.id === hub)

    expect(expanded?.via).toEqual([first, second].sort())
    expect(expanded?.why.graph).toBeGreaterThan(0)
    expect(expanded?.snippets).toHaveLength(0)
  })

  it('walks the graph outwards in graph mode', async () => {
    const far = addNote('# Far\n\nBody.\n')
    const near = addNote(`# Near\n\nSee [[${far}]].\n`)
    const origin = addNote(`# Origin\n\nSee [[${near}]].\n`)
    await indexProject(db, config, embedder)

    const shallow = await searchNotes(db, config, null, origin, { mode: 'graph', depth: 1 })
    expect(shallow.hits.map((hit) => hit.id)).toEqual([near])

    const deep = await searchNotes(db, config, null, origin, { mode: 'graph', depth: 2 })
    expect(deep.hits.map((hit) => hit.id)).toEqual([near, far])
    expect(deep.hits[1]?.via).toEqual([near])
    expect(deep.hits[0]?.score).toBeGreaterThan(deep.hits[1]?.score ?? 0)
  })

  it('reports an unknown origin in graph mode', async () => {
    await expect(
      searchNotes(db, config, null, 'SL-9999', { mode: 'graph' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('attaches neighbours to every hit with expandLinks', async () => {
    const partner = addNote('# Rasterization\n\nRasterized pixels.\n')
    addNote(`# Shaders\n\nA fragment shader.\n\n## Related\n\n- [[${partner}]]\n`)
    await indexProject(db, config, embedder)

    const plain = await searchNotes(db, config, embedder, 'fragment shader')
    expect(plain.hits[0]?.neighbours).toBeNull()

    const expanded = await searchNotes(db, config, embedder, 'fragment shader', { expandLinks: 1 })
    expect(expanded.hits[0]?.neighbours?.length).toBeGreaterThan(0)
  })
})

describe('link and unlink', () => {
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

  it('appends to a Related section and creates the section when absent', () => {
    const target = addNote('# GPU pipeline\n\nStages.\n')
    const source = addNote('# Shaders\n\nA fragment shader.\n')

    addRelatedLink(db, config, source, target, null, 'test')

    const body = outgoingLinksBody(db, source)
    expect(body).toContain('## Related')
    expect(body).toContain(`- [[${target} GPU pipeline]]`)
    expect(outgoingLinks(db, source)[0]?.dst).toBe(target)
  })

  it('adds to an existing Related section rather than making a second one', () => {
    const first = addNote('# One\n\nBody.\n')
    const second = addNote('# Two\n\nBody.\n')
    const source = addNote('# Source\n\nBody.\n')

    addRelatedLink(db, config, source, first, null, 'test')
    addRelatedLink(db, config, source, second, 'the other one', 'test')

    const body = outgoingLinksBody(db, source)
    expect(body.match(/## Related/g)).toHaveLength(1)
    expect(body).toContain(`|the other one]]`)
    expect(outgoingLinks(db, source)).toHaveLength(2)
  })

  it('refuses a duplicate edge and a self link', () => {
    const target = addNote('# Target\n\nBody.\n')
    const source = addNote('# Source\n\nBody.\n')

    addRelatedLink(db, config, source, target, null, 'test')

    expect(() => addRelatedLink(db, config, source, target, null, 'test')).toThrow(BadRequestError)
    expect(() => addRelatedLink(db, config, source, source, null, 'test')).toThrow(BadRequestError)
  })

  it('removes a link from the Related section', () => {
    const target = addNote('# Target\n\nBody.\n')
    const source = addNote('# Source\n\nBody.\n')

    addRelatedLink(db, config, source, target, null, 'test')
    removeRelatedLink(db, config, source, target, 'test')

    expect(outgoingLinks(db, source)).toEqual([])
  })

  it('refuses to cut a link out of the prose', () => {
    const target = addNote('# Target\n\nBody.\n')
    const source = addNote(`# Source\n\nAs explained in [[${target}]], this matters.\n`)

    try {
      removeRelatedLink(db, config, source, target, 'test')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).hint).toContain('edit it by hand')
    }
  })

  it('reports a link that does not exist', () => {
    const target = addNote('# Target\n\nBody.\n')
    const source = addNote('# Source\n\nBody.\n')

    expect(() => removeRelatedLink(db, config, source, target, 'test')).toThrow(BadRequestError)
  })
})

describe('doctor', () => {
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

  it('reports a clean project as clean', () => {
    const target = addNote('# Target\n\nBody.\n')
    addNote(`# Source\n\nSee [[${target}]].\n`)

    const report = runDoctor(db)

    expect(report.dangling).toEqual([])
    expect(report.orphans).toEqual([])
    expect(report.idCounterBehind).toBeNull()
    expect(report.duplicateAliases).toEqual([])
  })

  it('reports dangling links, orphans and unindexed notes', () => {
    addNote('# Source\n\nSee [[EXTERNAL-1234]].\n')

    const report = runDoctor(db)

    expect(report.dangling).toEqual([{ src: 'SL-0001', target: 'EXTERNAL-1234', anchor: null }])
    expect(report.orphans).toEqual(['SL-0001'])
    // Nothing has been indexed, so there is no active space to compare against.
    expect(report.activeSpace).toBeNull()
  })

  it('notices an id counter that fell behind and raises it', () => {
    addNote('# One\n\nBody.\n')
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'id_counter'").run()

    expect(runDoctor(db).idCounterBehind).toEqual({ counter: 0, highest: 1 })

    const fixed = fixDoctorFindings(db)
    expect(fixed.idCounterRaisedTo).toBe('SL-0001')
    expect(runDoctor(db).idCounterBehind).toBeNull()
  })

  it('resolves links that became valid, without touching the rest', () => {
    const source = addNote('# Source\n\nSee [[SL-0002]].\n')
    expect(runDoctor(db).dangling).toHaveLength(1)

    addNote('# Target\n\nBody.\n')
    const fixed = fixDoctorFindings(db)

    expect(fixed.linksResolved).toBe(1)
    expect(outgoingLinks(db, source)[0]?.resolved).toBe(true)
  })

  it('reports duplicate aliases', () => {
    const first = addNote('# One\n\nBody.\n')
    const second = addNote('# Two\n\nBody.\n')
    addAlias(db, first, 'the same')
    addAlias(db, second, 'the same')

    expect(runDoctor(db).duplicateAliases).toEqual([
      { alias: 'the same', notes: [first, second] },
    ])
  })

  it('reports an attachment path that does not exist', () => {
    addNote('# With image\n\n![diagram](assets/missing.png)\n')

    const report = runDoctor(db, { dir: path.join(sandbox.projects, 'sl') })
    expect(report.missingAttachments).toEqual([{ noteId: 'SL-0001', target: 'assets/missing.png' }])
  })
})

function outgoingLinksBody(db: Db, id: string): string {
  const row = db.prepare('SELECT body FROM notes WHERE id = ?').get(id) as { body: string }
  return row.body
}
