import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { BadRequestError, EXIT, MnemonimaError, applyPatch, listModels } from '@mnemonima/core'
import {
  createProject,
  danglingLinks,
  incomingLinks,
  listEntries,
  listNotes,
  noteTerms,
  outgoingLinks,
  requireNote,
} from '@mnemonima/store'
import { loadGraph, neighboursOf, searchNotes } from '@mnemonima/engine'
import type { SearchMode } from '@mnemonima/engine'
import {
  activateSpace,
  readBatches,
  readConfig,
  readDoctor,
  readRevisions,
  readSpaces,
  repairProject,
  writeConfig,
} from './admin.js'
import { AutoExporter } from './exporter.js'
import { ProjectPool } from './pool.js'
import { uiFile, uiMissingPage } from './ui.js'
import {
  aliasNote,
  changeTerm,
  createNoteFor,
  deleteNoteFor,
  exportNow,
  linkNotes,
  listVocabulary,
  readWriteContext,
  reindex,
  termsOfNote,
  undoWrites,
  unlinkNotes,
  updateNoteFor,
} from './writes.js'
import type { ProjectStatus } from './pool.js'

/**
 * The local HTTP daemon — DESIGN.md 10.
 *
 * One server for the CLI, the MCP adapter and the UI, so there is one place
 * where a project is loaded and one place where it is kept warm.
 *
 * Security is deliberately blunt: bound to the loopback interface only, a
 * random token per run, and a rejection of any browser request whose `Origin`
 * is not this server. Nothing here is meant to be exposed, and nothing here
 * tries to be safe if it is.
 */

export interface ServerOptions {
  readonly port?: number
  readonly token?: string
  readonly version: string
  readonly capacity?: number
  readonly idleMs?: number
  readonly snapshots?: boolean
}

export interface RunningServer {
  readonly url: string
  readonly port: number
  readonly token: string
  readonly pool: ProjectPool
  readonly exporter: AutoExporter
  close(): Promise<void>
}

/** Written into every revision the daemon records when the caller says nothing. */
const DEFAULT_AUTHOR = 'daemon'

export interface DaemonStatus {
  readonly version: string
  readonly pid: number
  readonly startedAt: number
  readonly uptimeMs: number
  readonly capacity: number
  readonly memory: { readonly rssMb: number; readonly heapMb: number }
  /** Projects held in memory right now — what the UI shows. */
  readonly loaded: readonly ProjectStatus[]
  /** Every project in the registry, loaded or not. */
  readonly registered: readonly { readonly name: string; readonly loaded: boolean }[]
}

export function createServer(options: ServerOptions): {
  app: Hono
  pool: ProjectPool
  exporter: AutoExporter
  token: string
  status(): DaemonStatus
} {
  const token = options.token ?? randomBytes(24).toString('hex')
  const startedAt = Date.now()

  const pool = new ProjectPool({
    capacity: options.capacity,
    idleMs: options.idleMs,
    snapshots: options.snapshots,
  })

  const exporter = new AutoExporter({
    onError: (message) => process.stderr.write(`${message}
`),
    onExport: (project, files) =>
      process.stderr.write(`auto-exported ${files} file(s) from "${project}"
`),
  })

  /** Every write goes through here, so nothing can forget to schedule an export. */
  const wrote = <T>(project: import('./pool.js').HotProject, result: T): T => {
    exporter.schedule(project)
    return result
  }

  const status = (): DaemonStatus => {
    pool.evictIdle()
    const loaded = pool.status()
    const memory = process.memoryUsage()

    return {
      version: options.version,
      pid: process.pid,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      capacity: pool.capacity,
      memory: {
        rssMb: Math.round(memory.rss / 1048576),
        heapMb: Math.round(memory.heapUsed / 1048576),
      },
      loaded,
      registered: listEntries().map((entry) => ({
        name: entry.name,
        loaded: pool.isLoaded(entry.name),
      })),
    }
  }

  const app = new Hono()

  app.use('*', async (context, next) => {
    // A browser page on another origin must not be able to drive the daemon.
    const origin = context.req.header('origin')
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return context.json({ error: 'cross-origin requests are not accepted' }, 403)
    }

    if (context.req.path === '/health') return next()

    // The bundle itself is exempt. A `<script src>` cannot carry a header, so
    // requiring the token for assets would mean putting it in every asset URL;
    // and the files are the same shipped bundle for everyone, carrying no
    // project data. Every route that reads or writes a project stays behind
    // the token.
    if (context.req.path.startsWith('/ui/assets/')) return next()

    const header = context.req.header('authorization') ?? ''
    const supplied = header.startsWith('Bearer ')
      ? header.slice(7)
      : (context.req.query('token') ?? '')

    if (supplied !== token) {
      return context.json({ error: 'unauthorized', hint: 'read the token from ~/.mnemonima/daemon.json' }, 401)
    }

    return next()
  })

  app.onError((error, context) => {
    if (error instanceof MnemonimaError) {
      return context.json(
        { error: error.message, hint: error.hint ?? null, details: error.details ?? null },
        httpStatusFor(error.exitCode),
      )
    }

    return context.json({ error: error.message, hint: null, details: null }, 500)
  })

  // Unauthenticated on purpose: a liveness probe carries nothing sensitive and
  // the CLI uses it to decide whether to spawn.
  app.get('/health', (context) =>
    context.json({
      ok: true,
      version: options.version,
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      loaded: pool.status().length,
    }),
  )

  app.get('/status', (context) => context.json(status()))

  // The page authenticates with `?token=`, which the middleware above accepts,
  // so it needs no exception of its own.
  app.get('/ui', (context) => {
    const page = uiFile('/index.html')
    if (page === null) return context.html(uiMissingPage(), 503)

    // Never cached: the page names asset files by content hash, so a stale copy
    // of it points at a bundle that no longer exists.
    return context.html(new TextDecoder().decode(page.body), 200, { 'cache-control': 'no-store' })
  })

  app.get('/ui/*', (context) => {
    const asset = uiFile(context.req.path.slice('/ui'.length))
    if (asset === null) return context.notFound()

    return context.body(asset.body, 200, {
      'content-type': asset.type,
      // The filenames carry a content hash, so a long cache is safe and makes
      // a reload cost one request instead of a dozen.
      'cache-control': context.req.path.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    })
  })

  app.get('/projects', (context) => {
    const current = status()
    return context.json({ projects: current.registered, capacity: current.capacity })
  })

  app.post('/projects', async (context) => {
    const body = await readBody(context)
    const name = typeof body['name'] === 'string' ? body['name'] : ''
    const dir = typeof body['dir'] === 'string' ? body['dir'] : ''

    if (name === '' || dir === '') {
      throw new BadRequestError('a project needs a name and a directory', {
        details: { name, dir },
        hint: 'send { "name": "Shader Lab", "dir": "W:/kb/shaders" }',
      })
    }

    const created = createProject({
      name,
      dir,
      prefix: typeof body['prefix'] === 'string' ? body['prefix'] : undefined,
    })

    // The pool owns connections; this one was opened only to run migrations.
    created.db.close()

    return context.json(
      { name: created.name, dir: created.dir, prefix: created.prefix, created: created.created },
      201,
    )
  })

  app.post('/projects/:name/search', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = (await context.req.json().catch(() => ({}))) as {
      query?: string
      mode?: SearchMode
      limit?: number
      minSimilarity?: number
      snippets?: number
      weights?: { text?: number; vector?: number }
      from?: string
      depth?: number
      expandLinks?: number
      overrides?: Record<string, unknown>
    }

    // The search lab tries a weight without saving it. Every knob in §8.5 is
    // read from the configuration at query time — boosts included, because
    // Orama takes them per search — so overriding a copy for this request is
    // all a live re-rank needs, and no index is rebuilt.
    const config =
      body.overrides === undefined ? project.config : applyPatch(project.config, body.overrides)

    const query = body.query ?? ''
    const mode = body.mode ?? (config.search.mode as SearchMode)

    // Only the two vector modes pay for loading the model.
    const needsEmbedder = mode === 'hybrid' || mode === 'semantic'
    const resolved = needsEmbedder ? await pool.embedder(project) : null

    // Warm, revalidated, and handed to the search so it does not rebuild one.
    const needsIndex = mode !== 'exact' && mode !== 'id' && mode !== 'graph'
    const index = needsIndex ? await pool.index(project) : undefined

    const result = await searchNotes(project.handle.db, config, resolved, query, {
      mode,
      index,
      limit: body.limit,
      minSimilarity: body.minSimilarity,
      snippetsPerNote: body.snippets,
      weights: body.weights,
      from: body.from,
      depth: body.depth,
      expandLinks: body.expandLinks,
    })

    return context.json({ project: project.name, ...result })
  })

  app.get('/projects/:name/notes', (context) => {
    const project = pool.acquire(context.req.param('name'))
    const limit = Number(context.req.query('limit') ?? '50')

    return context.json({
      project: project.name,
      notes: listNotes(project.handle.db, { limit: Number.isFinite(limit) ? limit : 50 }),
    })
  })

  app.get('/projects/:name/notes/:id', (context) => {
    const project = pool.acquire(context.req.param('name'))
    const note = requireNote(project.handle.db, context.req.param('id'))
    const graph = loadGraph(project.handle.db)

    return context.json({
      ...note,
      links: outgoingLinks(project.handle.db, note.id),
      backlinks: incomingLinks(project.handle.db, note.id).map((link) => link.src),
      neighbours: neighboursOf(project.handle.db, graph, note.id),
      terms: noteTerms(project.handle.db, note.id),
    })
  })

  app.get('/projects/:name/graph', (context) => {
    const project = pool.acquire(context.req.param('name'))
    const graph = loadGraph(project.handle.db)

    const nodes = listNotes(project.handle.db, { limit: -1 }).map((note) => ({
      id: note.id,
      title: note.title,
      degree:
        (graph.outgoing.get(note.id)?.size ?? 0) + (graph.incoming.get(note.id)?.size ?? 0),
    }))

    const edges: { from: string; to: string; resolved: boolean }[] = []
    for (const [from, targets] of graph.outgoing) {
      for (const to of targets) edges.push({ from, to, resolved: true })
    }

    // Dangling targets are data, not corruption (DESIGN.md 3.4), so the graph
    // shows them: a phantom node per missing id, and the edge marked so the UI
    // can draw it dashed. Leaving them out would hide exactly the case the
    // operator wants to see.
    const known = new Set(nodes.map((node) => node.id))
    const phantoms = new Map<string, { id: string; title: string; degree: number }>()

    for (const link of danglingLinks(project.handle.db)) {
      if (known.has(link.dst)) continue

      const phantom = phantoms.get(link.dst) ?? { id: link.dst, title: link.dst, degree: 0 }
      phantoms.set(link.dst, { ...phantom, degree: phantom.degree + 1 })
      edges.push({ from: link.src, to: link.dst, resolved: false })
    }

    return context.json({
      project: project.name,
      nodes,
      phantoms: [...phantoms.values()],
      edges,
    })
  })

  // ---- writes ------------------------------------------------------------

  app.post('/projects/:name/notes', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(
      wrote(project, createNoteFor(project, body, readWriteContext(body, DEFAULT_AUTHOR))),
      201,
    )
  })

  app.put('/projects/:name/notes/:id', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(
      wrote(
        project,
        updateNoteFor(project, context.req.param('id'), body, readWriteContext(body, DEFAULT_AUTHOR)),
      ),
    )
  })

  app.delete('/projects/:name/notes/:id', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)
    const hard = context.req.query('hard') === '1' || body['hard'] === true

    return context.json(
      wrote(
        project,
        deleteNoteFor(project, context.req.param('id'), hard, readWriteContext(body, DEFAULT_AUTHOR)),
      ),
    )
  })

  app.post('/projects/:name/links', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(
      wrote(project, linkNotes(project, body, readWriteContext(body, DEFAULT_AUTHOR))),
    )
  })

  app.post('/projects/:name/unlink', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(
      wrote(project, unlinkNotes(project, body, readWriteContext(body, DEFAULT_AUTHOR))),
    )
  })

  app.post('/projects/:name/aliases', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(wrote(project, aliasNote(project, body)))
  })

  app.get('/projects/:name/terms', (context) => {
    const project = pool.acquire(context.req.param('name'))
    const id = context.req.query('note')

    if (id !== undefined) return context.json(termsOfNote(project, id))

    const limit = Number(context.req.query('limit') ?? '100')
    return context.json(listVocabulary(project, Number.isFinite(limit) ? limit : 100))
  })

  app.post('/projects/:name/terms', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(wrote(project, changeTerm(project, body)))
  })

  app.post('/projects/:name/index', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(wrote(project, await reindex(project, body)))
  })

  app.post('/projects/:name/undo', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    return context.json(
      wrote(project, undoWrites(project, body, readWriteContext(body, DEFAULT_AUTHOR))),
    )
  })

  app.post('/projects/:name/export', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    const body = await readBody(context)

    // Explicit export supersedes anything the debounce was about to do.
    exporter.cancel(project.name)
    return context.json(exportNow(project, body))
  })

  app.post('/projects/:name/unload', (context) => {
    const name = context.req.param('name')
    return context.json({ name, unloaded: pool.release(name) })
  })

  // ---- administration ----------------------------------------------------
  //
  // None of these schedules an export: changing a search weight or activating a
  // space does not touch a note, so it must not produce a git commit.

  app.get('/projects/:name/config', (context) =>
    context.json(readConfig(pool.acquire(context.req.param('name')))),
  )

  app.put('/projects/:name/config', async (context) => {
    const project = pool.acquire(context.req.param('name'))
    return context.json(writeConfig(project, await readBody(context)))
  })

  // The model registry is static and carries no project data, but it is behind
  // the token like everything else: only the bundle is exempt.
  app.get('/models', (context) => context.json({ models: listModels() }))

  app.get('/projects/:name/spaces', (context) =>
    context.json(readSpaces(pool.acquire(context.req.param('name')))),
  )

  app.post('/projects/:name/spaces/:id/activate', (context) =>
    context.json(activateSpace(pool.acquire(context.req.param('name')), context.req.param('id'))),
  )

  app.get('/projects/:name/doctor', (context) =>
    context.json(readDoctor(pool.acquire(context.req.param('name')))),
  )

  app.post('/projects/:name/doctor', (context) =>
    context.json(repairProject(pool.acquire(context.req.param('name')))),
  )

  app.get('/projects/:name/notes/:id/revisions', (context) =>
    context.json(readRevisions(pool.acquire(context.req.param('name')), context.req.param('id'))),
  )

  app.get('/projects/:name/batches', (context) => {
    const limit = Number(context.req.query('limit') ?? '20')
    return context.json(
      readBatches(pool.acquire(context.req.param('name')), Number.isFinite(limit) ? limit : 20),
    )
  })

  return { app, pool, exporter, token, status }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { app, pool, exporter, token } = createServer(options)

  // The listen callback, not `server.address()`: binding is asynchronous, and
  // reading the address too early yields port 0 — which then gets written into
  // the state file and every client fails to connect.
  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>
    port: number
  }>((resolve) => {
    const instance = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: options.port ?? 0 },
      (info) => {
        resolve({ server: instance, port: info.port })
      },
    )
  })

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    pool,
    exporter,
    close: () =>
      new Promise<void>((resolve) => {
        pool.closeAll()
        server.close(() => {
          resolve()
        })
      }),
  }
}

async function readBody(context: {
  req: { json(): Promise<unknown> }
}): Promise<Record<string, unknown>> {
  const body = await context.req.json().catch(() => ({}))
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

function httpStatusFor(exitCode: number): 400 | 401 | 404 | 500 {
  if (exitCode === EXIT.NOT_FOUND) return 404
  if (exitCode === EXIT.BAD_REQUEST || exitCode === EXIT.LANGUAGE_GATE) return 400
  return 500
}
