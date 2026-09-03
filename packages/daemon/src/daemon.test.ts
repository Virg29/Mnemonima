import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_MODEL_ID } from '@mnemonima/core'
import { createProject, createSandbox, getConfig, setConfig } from '@mnemonima/store'
import type { Sandbox } from '@mnemonima/store'
import { createEmbedder, indexProject, writeNewNote } from '@mnemonima/engine'
import { ProjectPool } from './pool.js'
import {
  clearDaemonState,
  findRunning,
  idleTimeoutMs,
  isAlive,
  readDaemonState,
  stopDaemon,
  writeDaemonState,
} from './state.js'
import type { DaemonState } from './state.js'
import { createServer } from './server.js'
import type { DaemonStatus } from './server.js'

/**
 * The daemon is exercised through `app.fetch` rather than a real socket: the
 * routing, the auth and the pool are what matter, and binding a port would make
 * the suite slower and flakier for nothing.
 */

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour.
`

const GARDENING = `# Tomato planting

Tomatoes want full sun and a deep bed of compost before the last frost.
`

async function seedProject(sandbox: Sandbox, name: string, dir: string, bodies: string[]) {
  const project = createProject({ name, dir: path.join(sandbox.projects, dir) })

  const config = getConfig(project.db)
  config.model.active = TEST_MODEL_ID
  config.search.limits.minSimilarity = 0
  setConfig(project.db, config)

  for (const body of bodies) writeNewNote(project.db, config, body, { author: 'test' })

  const embedder = await createEmbedder(config)
  await indexProject(project.db, config, embedder)
  project.db.close()
}

describe('the project pool', () => {
  let sandbox: Sandbox

  beforeEach(async () => {
    sandbox = createSandbox()
    await seedProject(sandbox, 'Shader Lab', 'sl', [SHADERS])
    await seedProject(sandbox, 'Garden', 'garden', [GARDENING])
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  it('opens a project once and reuses it', () => {
    const pool = new ProjectPool()

    const first = pool.acquire('Shader Lab')
    const second = pool.acquire('Shader Lab')

    expect(second).toBe(first)
    expect(second.uses).toBe(2)
    pool.closeAll()
  })

  it('builds the index once and hands the same one back', async () => {
    const pool = new ProjectPool({ snapshots: false })
    const project = pool.acquire('Shader Lab')

    const first = await pool.index(project)
    const second = await pool.index(project)

    expect(second).toBe(first)
    expect(first.chunkCount).toBeGreaterThan(0)
    pool.closeAll()
  })

  it('rebuilds when the rows moved under it', async () => {
    const pool = new ProjectPool({ snapshots: false })
    const project = pool.acquire('Shader Lab')
    const first = await pool.index(project)

    // Something else — the CLI, an agent — writes to the same database.
    writeNewNote(project.handle.db, project.config, GARDENING, { author: 'test' })

    const second = await pool.index(project)
    expect(second).not.toBe(first)
    pool.closeAll()
  })

  it('evicts the least recently used project over capacity', () => {
    const pool = new ProjectPool({ capacity: 1 })

    pool.acquire('Shader Lab')
    expect(pool.isLoaded('Shader Lab')).toBe(true)

    pool.acquire('Garden')
    expect(pool.isLoaded('Garden')).toBe(true)
    expect(pool.isLoaded('Shader Lab')).toBe(false)

    pool.closeAll()
  })

  it('evicts a project that has been idle', () => {
    const pool = new ProjectPool({ idleMs: 0 })

    pool.acquire('Shader Lab')
    expect(pool.evictIdle()).toEqual(['Shader Lab'])
    expect(pool.isLoaded('Shader Lab')).toBe(false)

    pool.closeAll()
  })

  it('releases a project on request', () => {
    const pool = new ProjectPool()
    pool.acquire('Shader Lab')

    expect(pool.release('Shader Lab')).toBe(true)
    expect(pool.release('Shader Lab')).toBe(false)
    pool.closeAll()
  })

  it('reports what it is holding', async () => {
    const pool = new ProjectPool({ snapshots: false })
    const project = pool.acquire('Shader Lab')

    expect(pool.status()[0]?.index).toBeNull()

    await pool.index(project)
    const status = pool.status()[0]

    expect(status?.name).toBe('Shader Lab')
    expect(status?.index?.chunks).toBeGreaterThan(0)
    expect(status?.index?.notes).toBe(1)
    pool.closeAll()
  })
})

describe('the daemon API', () => {
  let sandbox: Sandbox
  let server: ReturnType<typeof createServer>

  const request = async (path: string, init: RequestInit = {}): Promise<Response> =>
    server.app.fetch(
      new Request(`http://127.0.0.1${path}`, {
        ...init,
        headers: { authorization: `Bearer ${server.token}`, ...(init.headers ?? {}) },
      }),
    )

  beforeEach(async () => {
    sandbox = createSandbox()
    await seedProject(sandbox, 'Shader Lab', 'sl', [SHADERS])
    await seedProject(sandbox, 'Garden', 'garden', [GARDENING])

    server = createServer({ version: 'test', capacity: 2, snapshots: false })
  })

  afterEach(() => {
    server.pool.closeAll()
    sandbox.cleanup()
  })

  it('answers a health probe without a token', async () => {
    const response = await server.app.fetch(new Request('http://127.0.0.1/health'))
    const body = (await response.json()) as { ok: boolean; version: string }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, version: 'test' })
  })

  it('refuses everything else without the token', async () => {
    const response = await server.app.fetch(new Request('http://127.0.0.1/status'))
    expect(response.status).toBe(401)
  })

  it('refuses a request from another origin', async () => {
    const response = await server.app.fetch(
      new Request('http://127.0.0.1/status', { headers: { origin: 'https://evil.example' } }),
    )
    expect(response.status).toBe(403)
  })

  it('accepts the token in a query parameter, for the UI', async () => {
    const response = await server.app.fetch(
      new Request(`http://127.0.0.1/status?token=${server.token}`),
    )
    expect(response.status).toBe(200)
  })

  it('reports nothing loaded until something is asked for', async () => {
    const status = (await (await request('/status')).json()) as DaemonStatus

    expect(status.loaded).toEqual([])
    expect(status.registered.map((entry) => entry.name).sort()).toEqual(['Garden', 'Shader Lab'])
    expect(status.registered.every((entry) => !entry.loaded)).toBe(true)
  })

  it('reports which projects are loaded after a search', async () => {
    await request('/projects/Shader%20Lab/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'fragment shader' }),
      headers: { 'content-type': 'application/json' },
    })

    const status = (await (await request('/status')).json()) as DaemonStatus
    const loaded = status.loaded[0]

    expect(status.loaded).toHaveLength(1)
    expect(loaded?.name).toBe('Shader Lab')
    expect(loaded?.index?.chunks).toBeGreaterThan(0)
    expect(loaded?.embedder?.model).toBe(TEST_MODEL_ID)
    expect(status.registered.find((entry) => entry.name === 'Garden')?.loaded).toBe(false)
  })

  it('searches and returns the same shape as the library', async () => {
    const response = await request('/projects/Shader%20Lab/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'fragment shader', mode: 'lexical' }),
      headers: { 'content-type': 'application/json' },
    })

    const body = (await response.json()) as {
      project: string
      mode: string
      hits: { id: string; why: { text: number } }[]
    }

    expect(body.project).toBe('Shader Lab')
    expect(body.mode).toBe('lexical')
    expect(body.hits[0]?.why.text).toBeGreaterThan(0)
  })

  it('returns a note with its graph and terms', async () => {
    const response = await request('/projects/Shader%20Lab/notes/SL-0001')
    const body = (await response.json()) as { id: string; neighbours: unknown[]; terms: unknown[] }

    expect(body.id).toBe('SL-0001')
    expect(Array.isArray(body.neighbours)).toBe(true)
    expect(Array.isArray(body.terms)).toBe(true)
  })

  it('maps a missing note to 404 with the hint intact', async () => {
    const response = await request('/projects/Shader%20Lab/notes/SL-9999')
    const body = (await response.json()) as { error: string; hint: string | null }

    expect(response.status).toBe(404)
    expect(body.error).toContain('SL-9999')
    expect(body.hint).toBeTruthy()
  })

  it('maps a non-English query to 400', async () => {
    const response = await request('/projects/Shader%20Lab/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'шейдеры' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(400)
  })

  it('serves the graph as nodes and edges', async () => {
    const response = await request('/projects/Shader%20Lab/graph')
    const body = (await response.json()) as { nodes: unknown[]; edges: unknown[] }

    expect(body.nodes).toHaveLength(1)
    expect(Array.isArray(body.edges)).toBe(true)
  })

  it('unloads a project on request', async () => {
    await request('/projects/Garden/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'compost', mode: 'lexical' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(server.pool.isLoaded('Garden')).toBe(true)

    const response = await request('/projects/Garden/unload', { method: 'POST' })
    expect((await response.json()) as unknown).toEqual({ name: 'Garden', unloaded: true })
    expect(server.pool.isLoaded('Garden')).toBe(false)
  })
})

describe('the idle shutdown', () => {
  it('turns minutes into milliseconds', () => {
    expect(idleTimeoutMs(30)).toBe(30 * 60_000)
    expect(idleTimeoutMs(1)).toBe(60_000)
  })

  it('treats zero as never, rather than clamping it to a minute', () => {
    // The UI offers this as "stays up until it is stopped"; an earlier version
    // clamped it with Math.max(1, …), which was the opposite of what was set.
    expect(idleTimeoutMs(0)).toBeNull()
    expect(idleTimeoutMs(-5)).toBeNull()
  })

  it('treats a value that is not a number as never', () => {
    expect(idleTimeoutMs(Number.NaN)).toBeNull()
    expect(idleTimeoutMs(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

/**
 * The state file, which is the only handle anything has on a running daemon.
 *
 * Every case here was a stranded process before it was a test: a daemon left
 * alive with its databases open and no way for any command to reach it, while
 * the next request started another one beside it.
 */
describe('the daemon state file', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.cleanup()
  })

  const state = (pid: number): DaemonState => ({
    pid,
    port: 1,
    token: 't',
    version: '0.0.0',
    startedAt: Date.now(),
  })

  it('knows this process is alive and a free number is not', () => {
    expect(isAlive(process.pid)).toBe(true)
    // Not a pid anything can hold: kill(0) on it is an error either way.
    expect(isAlive(0)).toBe(false)
    expect(isAlive(-1)).toBe(false)
  })

  it('refuses to clear a state file belonging to somebody else', () => {
    // The one that stranded daemons. A process shutting down must not delete
    // the entry of the one that replaced it.
    writeDaemonState(state(4242))
    clearDaemonState(9999)

    expect(readDaemonState()?.pid).toBe(4242)

    clearDaemonState(4242)
    expect(readDaemonState()).toBeNull()
  })

  it('clears unconditionally when no owner is named', () => {
    writeDaemonState(state(4242))
    clearDaemonState()

    expect(readDaemonState()).toBeNull()
  })

  it('keeps the state of a live daemon that did not answer', async () => {
    // A silent daemon is not a dead one: `/health` runs on a single thread that
    // an index run blocks for longer than the probe waits. Deleting the file on
    // a timeout is what left processes unreachable.
    writeDaemonState({ ...state(process.pid), port: 1 })

    const found = await findRunning('0.0.0')

    expect(found).toBeNull()
    expect(readDaemonState()?.pid).toBe(process.pid)
  }, 20_000)

  it('forgets a daemon whose process is gone', async () => {
    writeDaemonState({ ...state(0x7ffffffe), port: 1 })

    expect(await findRunning('0.0.0')).toBeNull()
    expect(readDaemonState()).toBeNull()
  })

  it('reports a stop it could not make, rather than clearing the entry', async () => {
    // This process will not die when asked, which is exactly the shape of the
    // failure worth reporting: the caller must not be told "stopped".
    writeDaemonState(state(process.pid))

    expect(await stopDaemon({ ...state(0x7ffffffe) }, 200)).toBe(false)
    // The live entry is still there for `daemon stop` to find.
    expect(readDaemonState()?.pid).toBe(process.pid)
  })
})
