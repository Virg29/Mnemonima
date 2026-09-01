import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_MODEL_ID } from '@mnemonima/core'
import {
  createProject,
  createSandbox,
  getConfig,
  getNote,
  listBatches,
  listRevisions,
  requireNote,
  setConfig,
} from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { exportDirectory } from '@mnemonima/engine'
import { createServer } from './server.js'

/**
 * The write half of the daemon, exercised through `app.fetch`.
 *
 * These are the endpoints the MCP tools map onto, so what is checked here is
 * what an agent can and cannot do: that every write is attributed and batched,
 * and that the destructive ones are refused until the project says otherwise.
 */

const SHADERS = `# Shaders introduction

A fragment shader runs once per rasterized pixel and writes a single colour.
`

const BATCH = 'mcp-20260101T000000-abc123'

describe('daemon writes', () => {
  let sandbox: Sandbox
  let server: ReturnType<typeof createServer>
  let projectDir: string

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

  const write = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    author: 'mcp:test',
    batchId: BATCH,
    ...extra,
  })

  /** The live connection the daemon is using, for asserting on the rows. */
  const db = (): Db => server.pool.acquire('Shader Lab').handle.db

  beforeEach(() => {
    sandbox = createSandbox()
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    const config = getConfig(project.db)
    config.model.active = TEST_MODEL_ID
    config.export.commit = false
    setConfig(project.db, config)
    project.db.close()

    server = createServer({ version: 'test', snapshots: false })
  })

  afterEach(() => {
    server.pool.closeAll()
    sandbox.cleanup()
  })

  it('creates a note and attributes it to the caller', async () => {
    const created = await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))

    expect(created.status).toBe(201)
    expect(created.body['id']).toBe('SL-0001')

    const revisions = listRevisions(db(), 'SL-0001')
    expect(revisions[0]?.author).toBe('mcp:test')
    expect(revisions[0]?.batchId).toBe(BATCH)
  })

  it('refuses a non-English body with a 400 and a hint', async () => {
    const response = await request(
      'POST',
      '/projects/Shader%20Lab/notes',
      write({ body: '# Заметка\n\nтекст' }),
    )

    expect(response.status).toBe(400)
    expect(response.body['hint']).toBeTruthy()
  })

  it('updates a note and honours the expected revision', async () => {
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))

    const updated = await request(
      'PUT',
      '/projects/Shader%20Lab/notes/SL-0001',
      write({ body: '# Shaders introduction\n\nRewritten.\n', expectedRev: 1 }),
    )
    expect(updated.body['rev']).toBe(2)

    const stale = await request(
      'PUT',
      '/projects/Shader%20Lab/notes/SL-0001',
      write({ body: '# Shaders introduction\n\nAgain.\n', expectedRev: 1 }),
    )
    expect(stale.status).toBe(400)
  })

  it('archives a note but refuses to delete one', async () => {
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))

    const archived = await request('DELETE', '/projects/Shader%20Lab/notes/SL-0001', write())
    expect(archived.body['status']).toBe('archived')
    expect(getNote(db(), 'SL-0001')).not.toBeNull()

    const deleted = await request(
      'DELETE',
      '/projects/Shader%20Lab/notes/SL-0001',
      write({ hard: true }),
    )
    expect(deleted.status).toBe(400)
    expect(String(deleted.body['error'])).toContain('destructive')
    expect(getNote(db(), 'SL-0001')).not.toBeNull()
  })

  it('allows the destructive form once the project turns it on', async () => {
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))

    const project = server.pool.acquire('Shader Lab')
    const config = getConfig(project.handle.db)
    config.mcp.allowDestructive = true
    setConfig(project.handle.db, config)
    server.pool.release('Shader Lab')

    const deleted = await request(
      'DELETE',
      '/projects/Shader%20Lab/notes/SL-0001',
      write({ hard: true }),
    )

    expect(deleted.body['status']).toBe('deleted')
    expect(getNote(db(), 'SL-0001')).toBeNull()
  })

  it('links two notes by editing the source, not the target', async () => {
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: '# Target\n\nBody.\n' }))
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))

    const linked = await request(
      'POST',
      '/projects/Shader%20Lab/links',
      write({ from: 'SL-0002', to: 'SL-0001' }),
    )

    expect(linked.body['rev']).toBe(2)
    expect(requireNote(db(), 'SL-0002').body).toContain('## Related')
    expect(requireNote(db(), 'SL-0001').rev).toBe(1)
  })

  it('blocks a term but refuses to forget one', async () => {
    const blocked = await request(
      'POST',
      '/projects/Shader%20Lab/terms',
      write({ term: 'shader', action: 'add' }),
    )
    expect(blocked.body['action']).toBe('add')

    const removed = await request(
      'POST',
      '/projects/Shader%20Lab/terms',
      write({ term: 'shader', action: 'remove' }),
    )
    expect(removed.status).toBe(400)
  })

  it('undoes everything a batch wrote', async () => {
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: '# Second\n\nBody.\n' }))

    expect(listBatches(db())[0]?.notes).toBe(2)

    const undone = await request(
      'POST',
      '/projects/Shader%20Lab/undo',
      write({ batchId: BATCH, author: 'cli' }),
    )

    const actions = undone.body['actions'] as { noteId: string; action: string }[]
    expect(actions.every((action) => action.action === 'archived')).toBe(true)
    expect(getNote(db(), 'SL-0001')?.status).toBe('archived')
  })

  it('reverts one note to an earlier revision', async () => {
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))
    await request(
      'PUT',
      '/projects/Shader%20Lab/notes/SL-0001',
      write({ body: '# Shaders introduction\n\nSecond.\n' }),
    )

    const reverted = await request(
      'POST',
      '/projects/Shader%20Lab/undo',
      write({ id: 'SL-0001', rev: 1 }),
    )

    expect(reverted.body['toRev']).toBe(1)
    expect(requireNote(db(), 'SL-0001').body).toContain('single colour')
  })

  it('exports on request and cancels a pending automatic export', async () => {
    fs.mkdirSync(exportDirectory(projectDir, getConfig(db())), { recursive: true })
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))

    // The write scheduled one; the explicit export supersedes it.
    expect(server.exporter.pending()).toEqual(['Shader Lab'])

    const exported = await request('POST', '/projects/Shader%20Lab/export', {})
    expect((exported.body['created'] as string[]).length).toBe(1)
    expect(server.exporter.pending()).toEqual([])
    expect(
      fs.existsSync(
        path.join(exportDirectory(projectDir, getConfig(db())), 'SL-0001 Shaders introduction.md'),
      ),
    ).toBe(true)
  })

  it('does not conjure an export directory that was never made', async () => {
    await request('POST', '/projects/Shader%20Lab/notes', write({ body: SHADERS }))

    expect(server.exporter.pending()).toEqual([])
    expect(fs.existsSync(exportDirectory(projectDir, getConfig(db())))).toBe(false)
  })
})
