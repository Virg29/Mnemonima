/**
 * The daemon, as seen from the browser.
 *
 * Two things are worth knowing about this file. The token comes from the page's
 * own query string, because that is how `mnemonima ui` opens it and how a
 * bookmarked URL keeps working; it is put in the `Authorization` header rather
 * than repeated in every URL, so it does not end up in a referrer or a log.
 *
 * And every failure carries the daemon's `hint` (DESIGN.md 12.1). The whole
 * error contract of this project is "say what to do next", and a UI that
 * rendered "request failed" would throw the useful half away.
 */

export class ApiError extends Error {
  readonly status: number
  readonly hint: string | null
  readonly details: unknown

  constructor(status: number, message: string, hint: string | null, details: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.hint = hint
    this.details = details
  }
}

/**
 * The token from the query string, read when a request is made rather than
 * when the module loads.
 *
 * At load time it means importing anything that touches this module outside a
 * browser throws on `location` — which is what a test of the layout merge
 * found, having imported it three files away.
 */
function token(): string {
  if (typeof location === 'undefined') return ''
  return new URLSearchParams(location.search).get('token') ?? ''
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  // `keepalive` is for a request sent as the page goes away — the graph
  // flushing the positions somebody just dragged. `sendBeacon` cannot carry the
  // bearer token, so this is the only way to survive an unload.
  options: { keepalive?: boolean } = {},
): Promise<T> {
  const bearer = token()

  const response = await fetch(path, {
    method,
    headers: {
      ...(bearer === '' ? {} : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options.keepalive === true ? { keepalive: true } : {}),
  })

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>

  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof payload['error'] === 'string' ? payload['error'] : response.statusText,
      typeof payload['hint'] === 'string' ? payload['hint'] : null,
      payload['details'] ?? null,
    )
  }

  return payload as T
}

const encode = (name: string): string => encodeURIComponent(name)

// ---- shapes the daemon returns -------------------------------------------

export interface DaemonStatus {
  version: string
  pid: number
  uptimeMs: number
  capacity: number
  memory: { rssMb: number; heapMb: number }
  loaded: {
    name: string
    uses: number
    idleMs: number
    index: { notes: number; chunks: number; spaceId: string; fromSnapshot: boolean } | null
  }[]
  registered: { name: string; loaded: boolean }[]
}

export interface Why {
  text: number
  vector: number
  meta: number
  graph: number
  multiChunk: number
  bestStrategy: string
  matchedChunks: number
}

export interface Snippet {
  chunkId: number
  strategy: string
  headingPath: string | null
  kind: string
  text: string
  score: number
}

export interface Hit {
  id: string
  title: string
  score: number
  why: Why
  snippets: Snippet[]
  via: string[] | null
  neighbours: { id: string; title: string }[] | null
}

export interface SearchResult {
  project: string
  query: string
  mode: string
  spaceId: string | null
  model: string | null
  weights: { text: number; vector: number }
  tookMs: number
  candidates: number
  hits: Hit[]
  warning: string | null
}

export interface SearchRequest {
  query?: string
  mode?: string
  limit?: number
  from?: string
  depth?: number
  expandLinks?: number
  overrides?: Record<string, unknown>
}

export interface NoteLink {
  src: string
  dst: string
  anchor: string | null
  heading: string | null
  kind: string
  resolved: boolean
}

export interface NoteTerm {
  term: string
  kind: string
  source: string
  score: number
  pinned: boolean
}

export interface NoteView {
  id: string
  title: string
  body: string
  status: string
  rev: number
  createdAt: number
  updatedAt: number
  outline: string | null
  links: NoteLink[]
  backlinks: string[]
  neighbours: { id: string; title: string }[]
  terms: NoteTerm[]
}

export interface GraphView {
  project: string
  nodes: { id: string; title: string; degree: number }[]
  phantoms: { id: string; title: string; degree: number }[]
  edges: { from: string; to: string; resolved: boolean }[]
  /** Where notes have been placed by hand. A note with no entry is unplaced. */
  layout: Record<string, { x: number; y: number }>
}

export interface ProjectConfig {
  [section: string]: Record<string, unknown>
}

export interface ConfigView {
  project: string
  config: ProjectConfig
  paths: string[]
  exportTarget: { directory: string; exists: boolean }
}

export interface SpaceView {
  id: string
  model: string
  dim: number
  chunkerVersion: string
  isActive: boolean
  createdAt: number
  chunks: number
  embeddings: number
  notes: number
}

export interface DoctorView {
  project: string
  notes: number
  links: number
  dangling: { src: string; target: string; anchor: string | null }[]
  orphans: string[]
  nonEnglish: string[]
  unindexed: string[]
  chunksWithoutVectors: number
  idCounterBehind: { counter: number; highest: number } | null
  missingAttachments: { noteId: string; target: string }[]
  duplicateAliases: { alias: string; notes: string[] }[]
  activeSpace: string | null
}

export interface RevisionRow {
  noteId: string
  rev: number
  title: string
  op: string
  author: string
  batchId: string | null
  createdAt: number
}

export interface BatchRow {
  batchId: string
  author: string
  notes: number
  revisions: number
  startedAt: number
  endedAt: number
}

export interface ModelDescriptor {
  id: string
  dim: number
  maxTokens: number
  sizeMb: number
  offline: boolean
  note: string
}

export interface QueryOutcome {
  query: string
  returned: string[]
  relevant: string[]
  recall: number | null
  reciprocalRank: number | null
  ndcg: number | null
  negatives: number
  tookMs: number
}

export interface EvalMetrics {
  queries: number
  recallAtK: number
  mrr: number
  ndcgAtK: number
  negatives: number
  p50Ms: number
  p95Ms: number
}

export interface EvalReport {
  tuned: false
  project: string
  set: string
  recallK: number
  ndcgK: number
  metrics: EvalMetrics
  outcomes: QueryOutcome[]
  unknownIds: string[]
  warning: string | null
}

export interface TuneHoldout {
  queries: number
  baseline: EvalMetrics
  best: EvalMetrics
  improved: boolean
}

export interface TuneReport {
  tuned: true
  objective: string
  trials: number
  baseline: { metrics: EvalMetrics; score: number }
  best: { metrics: EvalMetrics; score: number }
  holdout: TuneHoldout | null
  changes: { path: string; from: number; to: number }[]
  improved: boolean
  warning: string | null
}

export interface EvalRunRow {
  id: number
  queries: number
  recall: number
  mrr: number
  ndcg: number
  p50Ms: number
  p95Ms: number
  note: string | null
  createdAt: number
}

export interface EvalView {
  project: string
  set: string
  exists: boolean
  queries: number
  history: EvalRunRow[]
}

export interface VocabularyEntry {
  term: string
  lemma: string
  source: string
  pinned: boolean
  blocked: boolean
  weight: number
  df: number
}

// ---- the calls ------------------------------------------------------------

export const api = {
  status: (): Promise<DaemonStatus> => call('GET', '/status'),

  projects: (): Promise<{ projects: { name: string; loaded: boolean }[]; capacity: number }> =>
    call('GET', '/projects'),

  createProject: (input: { name: string; dir: string; prefix?: string }): Promise<unknown> =>
    call('POST', '/projects', input),

  unload: (project: string): Promise<{ unloaded: boolean }> =>
    call('POST', `/projects/${encode(project)}/unload`),

  search: (project: string, request: SearchRequest): Promise<SearchResult> =>
    call('POST', `/projects/${encode(project)}/search`, request),

  notes: (project: string, limit = 200): Promise<{ notes: { id: string; title: string }[] }> =>
    call('GET', `/projects/${encode(project)}/notes?limit=${limit}`),

  note: (project: string, id: string): Promise<NoteView> =>
    call('GET', `/projects/${encode(project)}/notes/${encode(id)}`),

  createNote: (project: string, body: string): Promise<{ id: string; rev: number }> =>
    call('POST', `/projects/${encode(project)}/notes`, { author: 'ui', body }),

  updateNote: (
    project: string,
    id: string,
    body: string,
    expectedRev: number,
  ): Promise<{ id: string; rev: number }> =>
    call('PUT', `/projects/${encode(project)}/notes/${encode(id)}`, {
      author: 'ui',
      body,
      expectedRev,
    }),

  link: (project: string, from: string, to: string, anchor?: string): Promise<{ rev: number }> =>
    call('POST', `/projects/${encode(project)}/links`, { author: 'ui', from, to, anchor }),

  graph: (project: string): Promise<GraphView> => call('GET', `/projects/${encode(project)}/graph`),

  saveLayout: (
    project: string,
    positions: Record<string, { x: number; y: number }>,
    options: { keepalive?: boolean } = {},
  ): Promise<{ saved: number }> =>
    call('PUT', `/projects/${encode(project)}/layout`, { positions }, options),

  clearLayout: (project: string): Promise<{ cleared: number }> =>
    call('DELETE', `/projects/${encode(project)}/layout`),

  config: (project: string): Promise<ConfigView> =>
    call('GET', `/projects/${encode(project)}/config`),

  setConfig: (project: string, set: Record<string, unknown>): Promise<ConfigView> =>
    call('PUT', `/projects/${encode(project)}/config`, { set }),

  createExportDirectory: (project: string): Promise<ConfigView> =>
    call('POST', `/projects/${encode(project)}/export/directory`),

  spaces: (project: string): Promise<{ active: string | null; spaces: SpaceView[] }> =>
    call('GET', `/projects/${encode(project)}/spaces`),

  activateSpace: (
    project: string,
    id: string,
  ): Promise<{ active: string | null; spaces: SpaceView[] }> =>
    call('POST', `/projects/${encode(project)}/spaces/${encode(id)}/activate`),

  doctor: (project: string): Promise<DoctorView> =>
    call('GET', `/projects/${encode(project)}/doctor`),

  /** The two mechanical repairs `doctor --fix` performs. */
  repair: (project: string): Promise<{ idCounter: number | null; removedLinks: number }> =>
    call('POST', `/projects/${encode(project)}/doctor`),

  revisions: (project: string, id: string): Promise<{ revisions: RevisionRow[] }> =>
    call('GET', `/projects/${encode(project)}/notes/${encode(id)}/revisions`),

  batches: (project: string): Promise<{ batches: BatchRow[] }> =>
    call('GET', `/projects/${encode(project)}/batches`),

  models: (): Promise<{ models: ModelDescriptor[] }> => call('GET', '/models'),

  evalHistory: (project: string): Promise<EvalView> =>
    call('GET', `/projects/${encode(project)}/eval`),

  runEval: (
    project: string,
    body: { tune?: boolean; trials?: number; holdout?: number },
  ): Promise<EvalReport | TuneReport> => call('POST', `/projects/${encode(project)}/eval`, body),

  terms: (project: string): Promise<{ terms: VocabularyEntry[]; candidates: VocabularyEntry[] }> =>
    call('GET', `/projects/${encode(project)}/terms`),

  changeTerm: (project: string, term: string, action: string): Promise<unknown> =>
    call('POST', `/projects/${encode(project)}/terms`, { author: 'ui', term, action }),

  index: (project: string, full = false): Promise<unknown> =>
    call('POST', `/projects/${encode(project)}/index`, { author: 'ui', full }),
}
