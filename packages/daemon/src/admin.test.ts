import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_MODEL_ID } from '@mnemonima/core'
import { createProject, createSandbox, getConfig, setConfig } from '@mnemonima/store'
import type { Sandbox } from '@mnemonima/store'
import { createServer } from './server.js'

/**
 * The administration half of the daemon: configuration, spaces, integrity and
 * the revision log — the endpoints the UI needs and the CLI never used.
 *
 * The point of most of these is the search lab. A weight has to be tryable
 * without being saved, so the override path is checked from both sides: that it
 * changes the answer, and that it leaves the stored configuration alone.
 */

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour.
`

const GARDEN = `# Vegetable bed

Raised beds warm earlier in spring and drain better after rain.
`

describe('daemon administration', () => {
  let sandbox: Sandbox
  let server: ReturnType<typeof createServer>

  const request = async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await server.app.fetch(
      new Request(`http://127.0.0.1${route}`, {
        method,
        headers: {
          authorization: `Bearer ${server.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  beforeEach(() => {
    sandbox = createSandbox()

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    const config = getConfig(project.db)
    config.model.active = TEST_MODEL_ID
    config.export.enabled = false
    setConfig(project.db, config)
    project.db.close()

    server = createServer({ version: 'test', snapshots: false })
  })

  afterEach(() => {
    server.pool.closeAll()
    sandbox.cleanup()
  })

  const write = (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
    request('POST', '/projects/Shader%20Lab/notes', { author: 'test', body })

  describe('configuration', () => {
    it('reports the effective settings and every settable path', async () => {
      const response = await request('GET', '/projects/Shader%20Lab/config')
      const config = response.body['config'] as Record<string, Record<string, unknown>>

      expect(config['search']?.['mode']).toBe('hybrid')
      expect(response.body['paths']).toContain('search.hybridWeights.text')
      // A group is not a settable path.
      expect(response.body['paths']).not.toContain('search.hybridWeights')
    })

    it('changes one setting and persists it', async () => {
      const updated = await request('PUT', '/projects/Shader%20Lab/config', {
        set: { 'search.limits.resultK': 3 },
      })

      const config = updated.body['config'] as Record<string, Record<string, unknown>>
      expect((config['search']?.['limits'] as Record<string, unknown>)['resultK']).toBe(3)

      const read = await request('GET', '/projects/Shader%20Lab/config')
      const stored = read.body['config'] as Record<string, Record<string, unknown>>
      expect((stored['search']?.['limits'] as Record<string, unknown>)['resultK']).toBe(3)
    })

    it('refuses a group path and writes nothing', async () => {
      const refused = await request('PUT', '/projects/Shader%20Lab/config', {
        set: { 'search.limits': { resultK: 3 } },
      })

      expect(refused.status).toBe(400)
      expect(refused.body['hint']).toBeTruthy()

      const read = await request('GET', '/projects/Shader%20Lab/config')
      const stored = read.body['config'] as Record<string, Record<string, unknown>>
      expect((stored['search']?.['limits'] as Record<string, unknown>)['resultK']).toBe(10)
    })

    it('applies nothing when one path in the body is bad', async () => {
      const refused = await request('PUT', '/projects/Shader%20Lab/config', {
        set: { 'search.limits.resultK': 3, 'search.limits.nonsense': 1 },
      })

      expect(refused.status).toBe(400)

      const read = await request('GET', '/projects/Shader%20Lab/config')
      const stored = read.body['config'] as Record<string, Record<string, unknown>>
      expect((stored['search']?.['limits'] as Record<string, unknown>)['resultK']).toBe(10)
    })

    it('asks for a "set" object when the body has none', async () => {
      const refused = await request('PUT', '/projects/Shader%20Lab/config', { resultK: 3 })

      expect(refused.status).toBe(400)
      expect(String(refused.body['hint'])).toContain('set')
    })
  })

  describe('search overrides', () => {
    beforeEach(async () => {
      await write(SHADERS)
      await write(GARDEN)
      await request('POST', '/projects/Shader%20Lab/index', {})
    })

    it('honours an override for one query only', async () => {
      const limited = await request('POST', '/projects/Shader%20Lab/search', {
        query: 'shader',
        mode: 'lexical',
        overrides: { 'search.limits.resultK': 1 },
      })

      expect((limited.body['hits'] as unknown[]).length).toBe(1)

      // The next query, with no override, is back to the stored setting.
      const normal = await request('POST', '/projects/Shader%20Lab/search', {
        query: 'shader',
        mode: 'lexical',
      })
      expect((normal.body['hits'] as unknown[]).length).toBeGreaterThanOrEqual(1)

      const read = await request('GET', '/projects/Shader%20Lab/config')
      const stored = read.body['config'] as Record<string, Record<string, unknown>>
      expect((stored['search']?.['limits'] as Record<string, unknown>)['resultK']).toBe(10)
    })

    it('moves the score when a weight moves, without touching the index', async () => {
      const body = { query: 'fragment shader', mode: 'hybrid' as const }

      const textOnly = await request('POST', '/projects/Shader%20Lab/search', {
        ...body,
        overrides: { 'search.hybridWeights.text': 1, 'search.hybridWeights.vector': 0 },
      })
      const vectorOnly = await request('POST', '/projects/Shader%20Lab/search', {
        ...body,
        overrides: { 'search.hybridWeights.text': 0, 'search.hybridWeights.vector': 1 },
      })

      const why = (result: Record<string, unknown>): Record<string, number> =>
        ((result['hits'] as Record<string, unknown>[])[0]?.['why'] ?? {}) as Record<string, number>

      expect(why(textOnly.body)['vector']).toBe(0)
      expect(why(vectorOnly.body)['text']).toBe(0)
      expect(why(textOnly.body)['text']).toBeGreaterThan(0)
    })

    it('refuses an override that names an unknown setting', async () => {
      const refused = await request('POST', '/projects/Shader%20Lab/search', {
        query: 'shader',
        mode: 'lexical',
        overrides: { 'search.hybridWeights.txt': 1 },
      })

      expect(refused.status).toBe(400)
      expect(refused.body['hint']).toBeTruthy()
    })
  })

  describe('spaces', () => {
    it('lists what a space holds and which one answers', async () => {
      await write(SHADERS)
      await request('POST', '/projects/Shader%20Lab/index', {})

      const response = await request('GET', '/projects/Shader%20Lab/spaces')
      const spaces = response.body['spaces'] as Record<string, unknown>[]

      expect(spaces.length).toBe(1)
      expect(spaces[0]?.['isActive']).toBe(true)
      expect(response.body['active']).toBe(spaces[0]?.['id'])
      expect(Number(spaces[0]?.['chunks'])).toBeGreaterThan(0)
    })

    it('refuses to activate a space that does not exist', async () => {
      const refused = await request('POST', '/projects/Shader%20Lab/spaces/nope/activate')
      expect(refused.status).toBe(404)
    })
  })

  describe('integrity and history', () => {
    it('reports a dangling link as information, not as an error', async () => {
      await write('# Source\n\nSee [[SL-9999]].\n')

      const report = await request('GET', '/projects/Shader%20Lab/doctor')

      expect(report.status).toBe(200)
      expect((report.body['dangling'] as unknown[]).length).toBe(1)
    })

    it('shows the graph with a phantom node for a dangling target', async () => {
      await write(SHADERS)
      await write('# Source\n\nSee [[SL-9999]].\n')

      const graph = await request('GET', '/projects/Shader%20Lab/graph')
      const phantoms = graph.body['phantoms'] as Record<string, unknown>[]
      const edges = graph.body['edges'] as Record<string, unknown>[]

      expect(phantoms.map((node) => node['id'])).toEqual(['SL-9999'])
      expect(edges.some((edge) => edge['resolved'] === false)).toBe(true)
    })

    it('lists the revisions of one note and refuses an unknown id', async () => {
      await write(SHADERS)
      await request('PUT', '/projects/Shader%20Lab/notes/SL-0001', {
        author: 'test',
        body: '# Shaders introduction\n\nRewritten.\n',
      })

      const history = await request('GET', '/projects/Shader%20Lab/notes/SL-0001/revisions')
      expect((history.body['revisions'] as unknown[]).length).toBe(2)

      const missing = await request('GET', '/projects/Shader%20Lab/notes/SL-9999/revisions')
      expect(missing.status).toBe(404)
    })

    it('lists the batches an agent session left behind', async () => {
      await request('POST', '/projects/Shader%20Lab/notes', {
        author: 'mcp:test',
        batchId: 'mcp-20260101T000000-abc123',
        body: SHADERS,
      })

      const batches = await request('GET', '/projects/Shader%20Lab/batches')
      const list = batches.body['batches'] as Record<string, unknown>[]

      expect(list.length).toBe(1)
      expect(list[0]?.['author']).toBe('mcp:test')
    })
  })

  describe('the registry', () => {
    it('creates a project and lists it', async () => {
      const created = await request('POST', '/projects', {
        name: 'Garden',
        dir: path.join(sandbox.projects, 'garden'),
      })

      expect(created.status).toBe(201)
      // The prefix is derived from the name: one word gives its first letters.
      expect(created.body['prefix']).toBe('GAR')

      const listed = await request('GET', '/projects')
      const names = (listed.body['projects'] as Record<string, unknown>[]).map(
        (entry) => entry['name'],
      )
      expect(names).toContain('Garden')
    })

    it('refuses a project with no directory', async () => {
      const refused = await request('POST', '/projects', { name: 'Garden' })

      expect(refused.status).toBe(400)
      expect(refused.body['hint']).toBeTruthy()
    })
  })
})

describe('automatic indexing', () => {
  let sandbox: Sandbox
  let server: ReturnType<typeof createServer>

  const request = async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await server.app.fetch(
      new Request(`http://127.0.0.1${route}`, {
        method,
        headers: {
          authorization: `Bearer ${server.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

    return (await response.json()) as Record<string, unknown>
  }

  /** The debounce is a second at its shortest, so waiting is unavoidable. */
  const settle = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  const write = (body: string): Promise<Record<string, unknown>> =>
    request('POST', '/projects/Shader%20Lab/notes', { author: 'test', body })

  const hits = async (query: string): Promise<unknown[]> => {
    const found = await request('POST', '/projects/Shader%20Lab/search', {
      query,
      mode: 'lexical',
    })
    return (found['hits'] as unknown[] | undefined) ?? []
  }

  beforeEach(async () => {
    sandbox = createSandbox()

    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    const config = getConfig(project.db)
    config.model.active = TEST_MODEL_ID
    config.index.debounceSec = 1
    config.export.enabled = false
    setConfig(project.db, config)
    project.db.close()

    server = createServer({ version: 'test', snapshots: false })

    // A seed note and one explicit run, so an active space exists: searching a
    // project that has never been indexed is a 404, which is a different story.
    await write(`# Rasterization

Rasterization decides which pixels a triangle covers.
`)
    await request('POST', '/projects/Shader%20Lab/index', {})
    server.indexer.stop()
  })

  afterEach(async () => {
    // A run in flight would reopen the database the sandbox is about to delete.
    server.indexer.stop()
    while (server.indexer.busy()) await settle(50)

    server.pool.closeAll()
    sandbox.cleanup()
  })

  it('indexes a written note without being asked', async () => {
    await write(`# Depth testing

The depth test discards a fragment.
`)

    // Written, but not yet indexed: the run is waiting for the writing to stop.
    expect(await hits('discards')).toEqual([])
    expect(server.indexer.pending()).toEqual(['Shader Lab'])

    await settle(1800)

    expect((await hits('discards')).length).toBe(1)
  })

  it('indexes a burst of writes once', async () => {
    await write(`# One

The first paragraph.
`)
    await write(`# Two

The second paragraph.
`)
    await write(`# Three

The third paragraph.
`)

    // Three writes, one pending run: the timer resets rather than stacking.
    expect(server.indexer.pending()).toEqual(['Shader Lab'])

    await settle(1800)

    expect((await hits('paragraph')).length).toBe(3)
  })

  it('does nothing when it is switched off', async () => {
    const project = server.pool.acquire('Shader Lab')
    const config = getConfig(project.handle.db)
    config.index.auto = false
    setConfig(project.handle.db, config)
    server.pool.release('Shader Lab')

    await write(`# Depth testing

The depth test discards a fragment.
`)
    expect(server.indexer.pending()).toEqual([])

    await settle(1500)

    // Still unindexed, which is what "off" has to mean.
    expect(await hits('discards')).toEqual([])
  })
})

describe('the export target', () => {
  let sandbox: Sandbox
  let server: ReturnType<typeof createServer>

  const request = async (method: string, route: string): Promise<Record<string, unknown>> => {
    const response = await server.app.fetch(
      new Request(`http://127.0.0.1${route}`, {
        method,
        headers: { authorization: `Bearer ${server.token}` },
      }),
    )
    return (await response.json()) as Record<string, unknown>
  }

  beforeEach(() => {
    sandbox = createSandbox()
    const project = createProject({ name: 'Shader Lab', dir: path.join(sandbox.projects, 'sl') })
    project.db.close()
    server = createServer({ version: 'test', snapshots: false })
  })

  afterEach(() => {
    server.pool.closeAll()
    sandbox.cleanup()
  })

  it('reports where the export lands and whether it is there', async () => {
    const view = await request('GET', '/projects/Shader%20Lab/config')
    const target = view['exportTarget'] as { directory: string; exists: boolean }

    // A relative `export.path` tells the operator nothing on its own.
    expect(path.isAbsolute(target.directory)).toBe(true)
    expect(target.exists).toBe(false)
  })

  it('creates it when asked, which is the operator saying yes', async () => {
    const created = await request('POST', '/projects/Shader%20Lab/export/directory')
    const target = created['exportTarget'] as { directory: string; exists: boolean }

    expect(target.exists).toBe(true)
    expect(fs.existsSync(target.directory)).toBe(true)
  })
})
