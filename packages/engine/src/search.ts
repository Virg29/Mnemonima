import { assertEnglish, BadRequestError, NotFoundError } from '@mnemonima/core'
import type { GateFinding, ProjectConfig } from '@mnemonima/core'
import { getNote, listNotes, requireActiveSpace } from '@mnemonima/store'
import type { Db, NeighbourSets } from '@mnemonima/store'
import type { ResolvedEmbedder } from './embedder.js'
import { computeGraphAdjustment, loadGraph, neighboursOf, traverse } from './graph.js'
import type { GraphNeighbour } from './graph.js'
import {
  buildSearchIndex,
  normaliseScores,
  searchChunksLexical,
  searchChunksVector,
  searchNoteMetadata,
} from './orama.js'
import type { ChunkDocument, ChunkHit, SearchIndex } from './orama.js'

/**
 * Search — DESIGN.md 8.
 *
 * Retrieval runs over the chunk index in two passes, BM25 and cosine, and the
 * results are fused here rather than inside Orama so that every number in a hit
 * can be attributed to something (see the note in `orama.ts`).
 *
 * Fusion to note level:
 *
 *     best(s)   = the chunk cut by strategy s with the highest combined score
 *     chunkPart = SUM_s w_s * (wText * text(best(s)) + wVector * vector(best(s)))
 *                 + lambda * log(1 + chunks that matched at all)
 *     score     = fusion.chunk * chunkPart + fusion.meta * metadata
 *
 * The logarithm lets a note where five passages match beat one where a single
 * passage does, without long notes winning on length alone. Taking the best
 * chunk per strategy — rather than summing — is what keeps `why` decomposable:
 * every term of the sum above appears in the breakdown.
 *
 * A note can enter the results on metadata alone: a query matching a title or an
 * alias finds the note even when no individual passage scores.
 */

export type SearchMode = 'hybrid' | 'semantic' | 'lexical' | 'exact' | 'id' | 'graph'

export const IMPLEMENTED_MODES: readonly SearchMode[] = [
  'hybrid',
  'semantic',
  'lexical',
  'exact',
  'id',
  'graph',
]

export interface SearchSnippet {
  readonly chunkId: number
  readonly strategy: string
  readonly headingPath: string | null
  readonly kind: string
  readonly text: string
  readonly score: number
}

export interface SearchWhy {
  /** Contribution of BM25 over chunk text. */
  readonly text: number
  /** Contribution of cosine similarity over chunk vectors. */
  readonly vector: number
  /** Contribution of the note's own metadata: title, aliases, terms, tags. */
  readonly meta: number
  /** Reserved for graph proximity; fills in with the link stage. */
  readonly graph: number
  /** Bonus for matching in several passages rather than one. */
  readonly multiChunk: number
  readonly bestStrategy: string
  readonly matchedChunks: number
}

export interface SearchHit {
  readonly id: string
  readonly title: string
  readonly score: number
  readonly why: SearchWhy
  readonly snippets: readonly SearchSnippet[]
  /** Results that pulled this note in, when the graph did rather than the query. */
  readonly via: readonly string[] | null
  /** Direct neighbours, when `expandLinks` asked for them. */
  readonly neighbours: readonly GraphNeighbour[] | null
}

export interface SearchWeights {
  readonly text: number
  readonly vector: number
}

export interface SearchResult {
  readonly query: string
  readonly mode: SearchMode
  readonly spaceId: string | null
  readonly model: string | null
  readonly weights: SearchWeights
  readonly tookMs: number
  readonly candidates: number
  readonly hits: readonly SearchHit[]
  readonly warning: GateFinding | null
}

export interface SearchOptions {
  readonly mode?: SearchMode | undefined
  readonly limit?: number | undefined
  readonly minSimilarity?: number | undefined
  readonly snippetsPerNote?: number | undefined
  /** Chunks retrieved per pass before fusion. */
  readonly candidateK?: number | undefined
  /** Overrides `search.hybridWeights` for this query only. */
  readonly weights?: Partial<SearchWeights> | undefined
  /** Origin note for `graph` mode; defaults to the query itself. */
  readonly from?: string | undefined
  /** Hops to walk in `graph` mode. */
  readonly depth?: number | undefined
  /**
   * Attach direct neighbours to every hit. One call gives an agent a connected
   * subgraph instead of three round trips (DESIGN.md 8.4).
   */
  readonly expandLinks?: number | undefined
  /**
   * A prebuilt index to search.
   *
   * This is what makes the daemon worth running: without it every request
   * rebuilds both Orama indexes from SQLite, and a hot project is hot in name
   * only. The caller is responsible for the index matching the current rows —
   * the pool revalidates it by fingerprint before handing it over.
   */
  readonly index?: SearchIndex | undefined
}

interface ScoredChunk {
  readonly document: ChunkDocument
  readonly text: number
  readonly vector: number
  readonly combined: number
}

/**
 * `resolved` may be null for modes that never embed anything — `exact`, `id`
 * and `lexical`. Loading onnxruntime is most of the latency of a small query,
 * so a caller that knows it will not need vectors should not pay for it.
 */
export async function searchNotes(
  db: Db,
  config: ProjectConfig,
  resolved: ResolvedEmbedder | null,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const started = Date.now()

  const warning = assertEnglish(query, 'query', {
    mode: config.language.gate,
    gateCodeBlocks: true,
  })

  const mode = options.mode ?? (config.search.mode as SearchMode)
  const limit = options.limit ?? config.search.limits.resultK
  const expandLinks = options.expandLinks ?? 0

  let graph: NeighbourSets | null = null
  const ensureGraph = (): NeighbourSets => (graph ??= loadGraph(db))

  if (!IMPLEMENTED_MODES.includes(mode)) {
    throw new BadRequestError(`search mode "${mode}" is not implemented yet`, {
      details: { mode, implemented: IMPLEMENTED_MODES },
      hint:
        mode === 'graph'
          ? 'graph traversal lands with the link stage'
          : `available modes: ${IMPLEMENTED_MODES.join(', ')}`,
    })
  }

  const finish = (
    hits: SearchHit[],
    candidates: number,
    weights: SearchWeights,
    spaceId: string | null,
    model: string | null,
  ): SearchResult => ({
    query,
    mode,
    spaceId,
    model,
    weights,
    tookMs: Date.now() - started,
    candidates,
    // Ties break on id so repeated runs are byte-identical: agents diff results.
    hits: hits
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((hit) => ({
        ...hit,
        score: round(hit.score),
        // Computed after the cut so a wide candidate set costs nothing.
        neighbours: expandLinks > 0 ? neighboursOf(db, ensureGraph(), hit.id) : null,
      })),
    warning,
  })

  if (mode === 'id') {
    const hits = lookupById(db, query)
    return finish(hits, hits.length, { text: 0, vector: 0 }, null, null)
  }

  if (mode === 'exact') {
    const hits = scanExact(db, query, options.snippetsPerNote ?? 2)
    return finish(hits, hits.length, { text: 1, vector: 0 }, null, null)
  }

  if (mode === 'graph') {
    const hits = walkGraph(db, ensureGraph(), options.from ?? query, options.depth ?? 1)
    return finish(hits, hits.length, { text: 0, vector: 0 }, null, null)
  }

  const weights = resolveWeights(mode, config, options.weights)

  if (weights.vector > 0 && resolved === null) {
    throw new BadRequestError(`mode "${mode}" needs an embedding model but none was loaded`, {
      details: { mode },
      hint: 'this is a wiring mistake in the caller, not in the query',
    })
  }

  const space = requireActiveSpace(db)
  if (resolved !== null) assertSpaceMatchesModel(space.model, resolved.model.id)

  const index = options.index ?? (await buildSearchIndex(db, space))
  const candidateK = options.candidateK ?? config.search.limits.candidateK
  const floor = options.minSimilarity ?? config.search.limits.minSimilarity
  const tolerance = config.search.tolerance

  const scored = await retrieveChunks(index, resolved, query, weights, candidateK, floor, tolerance)

  // Metadata is a lexical signal, so a pure vector query does not use it.
  const metaByNote = new Map<string, number>()
  if (weights.text > 0) {
    const metadata = await searchNoteMetadata(
      index,
      query,
      candidateK,
      tolerance,
      metadataBoost(config),
    )
    const normalised = normaliseScores(metadata)
    for (const [hit, score] of normalised) metaByNote.set(hit.noteId, score)
  }

  const hits = fuse(db, config, weights, scored, metaByNote, options.snippetsPerNote ?? 2)
  const withGraph = applyGraph(db, config, hits, ensureGraph())

  return finish(withGraph, scored.length, weights, space.id, space.model)
}

function resolveWeights(
  mode: SearchMode,
  config: ProjectConfig,
  override: Partial<SearchWeights> | undefined,
): SearchWeights {
  if (mode === 'semantic') return { text: 0, vector: 1 }
  if (mode === 'lexical') return { text: 1, vector: 0 }

  const base = config.search.hybridWeights
  const text = override?.text ?? base.text
  const vector = override?.vector ?? base.vector

  if (text < 0 || vector < 0 || text + vector === 0) {
    throw new BadRequestError('search weights must be non-negative and not both zero', {
      details: { text, vector },
      hint: 'try --weights text=0.5,vector=0.5, or use --mode semantic / --mode lexical',
    })
  }

  return { text, vector }
}

function metadataBoost(config: ProjectConfig): Record<string, number> {
  const boost = config.search.boost
  return {
    title: boost.title,
    aliases: boost.aliases,
    keywordsManual: boost.keywordsManual,
    keywordsAuto: boost.keywordsAuto * config.keywords.autoWeight,
    phrasesManual: boost.phrasesManual,
    phrasesAuto: boost.phrasesAuto * config.keywords.autoWeight,
    tags: boost.aliases,
    outline: boost.outline,
  }
}

async function retrieveChunks(
  index: SearchIndex,
  resolved: ResolvedEmbedder | null,
  query: string,
  weights: SearchWeights,
  candidateK: number,
  floor: number,
  tolerance: number,
): Promise<ScoredChunk[]> {
  const lexical: ChunkHit[] =
    weights.text > 0 ? await searchChunksLexical(index, query, candidateK, tolerance) : []

  const vector: ChunkHit[] =
    weights.vector > 0 && resolved !== null
      ? await searchChunksVector(index, await resolved.embedder.embedQuery(query), candidateK, floor)
      : []

  const lexicalNormalised = normaliseScores(lexical)
  const byChunk = new Map<number, { document: ChunkDocument; text: number; vector: number }>()

  for (const hit of lexical) {
    byChunk.set(hit.document.chunkId, {
      document: hit.document,
      text: lexicalNormalised.get(hit) ?? 0,
      vector: 0,
    })
  }

  for (const hit of vector) {
    const existing = byChunk.get(hit.document.chunkId)
    byChunk.set(hit.document.chunkId, {
      document: hit.document,
      text: existing?.text ?? 0,
      vector: hit.score,
    })
  }

  return [...byChunk.values()].map((entry) => ({
    ...entry,
    combined: weights.text * entry.text + weights.vector * entry.vector,
  }))
}

function fuse(
  db: Db,
  config: ProjectConfig,
  weights: SearchWeights,
  scored: readonly ScoredChunk[],
  metaByNote: ReadonlyMap<string, number>,
  snippetsPerNote: number,
): SearchHit[] {
  const strategyWeights = config.search.strategyWeights
  const fusion = config.search.fusion
  const lambda = fusion.lambdaMultiChunk

  const byNote = new Map<string, ScoredChunk[]>()
  for (const chunk of scored) {
    const bucket = byNote.get(chunk.document.noteId)
    if (bucket === undefined) byNote.set(chunk.document.noteId, [chunk])
    else bucket.push(chunk)
  }

  const noteIds = new Set<string>([...byNote.keys(), ...metaByNote.keys()])
  const hits: SearchHit[] = []

  for (const noteId of noteIds) {
    const note = getNote(db, noteId)
    // A note archived since the last index run must not surface.
    if (note === null || note.status !== 'active') continue

    const chunks = byNote.get(noteId) ?? []
    const best = new Map<string, ScoredChunk>()

    for (const chunk of chunks) {
      const current = best.get(chunk.document.strategy)
      if (current === undefined || chunk.combined > current.combined) {
        best.set(chunk.document.strategy, chunk)
      }
    }

    let textPart = 0
    let vectorPart = 0
    let bestStrategy = ''
    let bestCombined = -Infinity

    for (const [strategy, chunk] of best) {
      const weight = strategy === 'fine' ? strategyWeights.fine : strategyWeights.coarse
      textPart += weight * weights.text * chunk.text
      vectorPart += weight * weights.vector * chunk.vector

      if (chunk.combined > bestCombined) {
        bestCombined = chunk.combined
        bestStrategy = strategy
      }
    }

    const multiChunk = chunks.length > 0 ? lambda * Math.log(1 + chunks.length) : 0
    const meta = metaByNote.get(noteId) ?? 0

    const why: SearchWhy = {
      text: round(fusion.chunk * textPart),
      vector: round(fusion.chunk * vectorPart),
      meta: round(fusion.meta * meta),
      graph: 0,
      multiChunk: round(fusion.chunk * multiChunk),
      bestStrategy,
      matchedChunks: chunks.length,
    }

    const score = why.text + why.vector + why.meta + why.multiChunk
    if (score <= 0) continue

    hits.push({
      id: note.id,
      title: note.title,
      score,
      why,
      snippets: dedupeSnippets(chunks).slice(0, snippetsPerNote),
      via: null,
      neighbours: null,
    })
  }

  return hits
}

/**
 * Keeps the best-scoring copy of each distinct passage. The fine and coarse cuts
 * of a short section are identical, and showing the same text twice tells the
 * reader nothing.
 */
function dedupeSnippets(chunks: readonly ScoredChunk[]): SearchSnippet[] {
  const best = new Map<string, ScoredChunk>()

  for (const chunk of chunks) {
    const key = chunk.document.text.trim()
    const previous = best.get(key)
    if (previous === undefined || chunk.combined > previous.combined) best.set(key, chunk)
  }

  return [...best.values()]
    .sort((a, b) => b.combined - a.combined)
    .map((chunk) => ({
      chunkId: chunk.document.chunkId,
      strategy: chunk.document.strategy,
      headingPath: chunk.document.headingPath === '' ? null : chunk.document.headingPath,
      kind: chunk.document.kind,
      text: chunk.document.text,
      score: round(chunk.combined),
    }))
}

/**
 * Applies the graph to a fused result set: boosts notes whose neighbours also
 * scored, then adds notes several results point at (DESIGN.md 8.4).
 */
function applyGraph(
  db: Db,
  config: ProjectConfig,
  hits: readonly SearchHit[],
  graph: NeighbourSets,
): SearchHit[] {
  const base = new Map(hits.map((hit) => [hit.id, hit.score]))
  const { boost, expansion } = computeGraphAdjustment(base, graph, config)

  const out: SearchHit[] = hits.map((hit) => {
    const extra = boost.get(hit.id) ?? 0
    if (extra === 0) return hit
    return { ...hit, score: hit.score + extra, why: { ...hit.why, graph: round(extra) } }
  })

  for (const [id, added] of expansion) {
    const note = getNote(db, id)
    if (note === null || note.status !== 'active') continue

    out.push({
      id: note.id,
      title: note.title,
      score: added.score,
      why: {
        text: 0,
        vector: 0,
        meta: 0,
        graph: round(added.score),
        multiChunk: 0,
        bestStrategy: '',
        matchedChunks: 0,
      },
      snippets: [],
      via: added.via,
      neighbours: null,
    })
  }

  return out
}

/** Breadth-first walk from one note; the score falls off with distance. */
function walkGraph(db: Db, graph: NeighbourSets, from: string, depth: number): SearchHit[] {
  return traverse(db, graph, from.trim(), Math.max(1, depth)).map((step) => ({
    id: step.id,
    title: step.title,
    score: 1 / (1 + step.distance),
    why: {
      text: 0,
      vector: 0,
      meta: 0,
      graph: round(1 / (1 + step.distance)),
      multiChunk: 0,
      bestStrategy: `distance ${step.distance}`,
      matchedChunks: 0,
    },
    snippets: [],
    via: [step.via],
    neighbours: null,
  }))
}

/** Direct lookup, the cheapest call an agent can make. */
function lookupById(db: Db, id: string): SearchHit[] {
  const note = getNote(db, id.trim())
  if (note === null) {
    throw new NotFoundError(`no note ${id} in this project`, {
      details: { id },
      hint: 'run `mnemonima list` to see the ids that exist',
    })
  }

  return [
    {
      id: note.id,
      title: note.title,
      score: 1,
      why: {
        text: 0,
        vector: 0,
        meta: 1,
        graph: 0,
        multiChunk: 0,
        bestStrategy: '',
        matchedChunks: 0,
      },
      snippets: [],
      via: null,
      neighbours: null,
    },
  ]
}

/**
 * Grep over note bodies, for when you know the exact string.
 *
 * `/pattern/flags` is treated as a regular expression, anything else as a
 * case-insensitive substring. This needs no index, so it works before the first
 * `index` run and is unaffected by chunking.
 */
function scanExact(db: Db, query: string, snippetsPerNote: number): SearchHit[] {
  const pattern = compilePattern(query)
  const hits: SearchHit[] = []

  for (const note of listNotes(db, { status: 'active', limit: -1 })) {
    const matches: SearchSnippet[] = []

    note.body.split('\n').forEach((line, position) => {
      pattern.lastIndex = 0
      if (!pattern.test(line)) return
      matches.push({
        chunkId: -1,
        strategy: 'exact',
        headingPath: `line ${position + 1}`,
        kind: 'prose',
        text: line.trim(),
        score: 1,
      })
    })

    if (matches.length === 0) continue

    hits.push({
      id: note.id,
      title: note.title,
      // More occurrences means a better match, with the same diminishing return
      // the chunk fusion uses.
      score: 1 + Math.log(matches.length),
      why: {
        text: 1,
        vector: 0,
        meta: 0,
        graph: 0,
        multiChunk: round(Math.log(matches.length)),
        bestStrategy: 'exact',
        matchedChunks: matches.length,
      },
      snippets: matches.slice(0, snippetsPerNote),
      via: null,
      neighbours: null,
    })
  }

  return hits
}

function compilePattern(query: string): RegExp {
  const delimited = /^\/(.+)\/([gimsuy]*)$/.exec(query)

  try {
    if (delimited !== null) {
      const flags = delimited[2] ?? ''
      return new RegExp(delimited[1]!, flags.includes('g') ? flags : `${flags}g`)
    }
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  } catch (cause) {
    throw new BadRequestError(`"${query}" is not a valid regular expression`, {
      details: { query, cause: String(cause) },
      hint: 'drop the surrounding slashes to search for it as plain text',
    })
  }
}

function assertSpaceMatchesModel(spaceModel: string, requested: string): void {
  if (spaceModel === requested) return

  throw new BadRequestError(
    `the active index was built with "${spaceModel}" but the query would use "${requested}"`,
    {
      details: { spaceModel, requested },
      hint: `search with the indexed model (--model ${spaceModel}), or rebuild: \`mnemonima index --model ${requested}\``,
    },
  )
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
