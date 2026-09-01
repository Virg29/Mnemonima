import {
  chunkDocument,
  describeSpace,
  l2Normalize,
  parseMarkdown,
  parseTree,
  spaceId,
} from '@mnemonima/core'
import type { ChunkSpec, Note, ProjectConfig } from '@mnemonima/core'
import type { Root } from 'mdast'
import {
  deleteNoteChunks,
  ensureSpace,
  loadChunkVectors,
  getActiveSpace,
  indexedNoteIds,
  listNoteChunks,
  listNotes,
  missingHashes,
  pruneOrphanEmbeddings,
  putEmbeddings,
  replaceNoteChunks,
  setActiveSpace,
} from '@mnemonima/store'
import type { Db } from '@mnemonima/store'
import type { ResolvedEmbedder } from './embedder.js'
import { rebuildLinks } from './links.js'
import { buildTermContext, extractNoteTerms, finishTermPass } from './terms.js'
import type { NoteVectorSource } from './terms.js'

/**
 * The indexing pipeline — DESIGN.md 6.
 *
 *   note -> parse -> chunk (fine + coarse) -> embed the misses -> persist
 *
 * Two properties are worth stating plainly, because everything downstream
 * assumes them:
 *
 * 1. **Nothing is embedded twice.** The embedding cache is keyed by the hash of
 *    the chunk's embedding text, so re-running the indexer after editing one
 *    paragraph costs one or two vectors, not a whole note — and not a whole
 *    project, even though every later chunk boundary moved.
 *
 * 2. **A note is "unchanged" when its recomputed chunk hashes match what is
 *    already stored.** There is no separate bookkeeping table to fall out of
 *    sync: parsing and chunking are cheap, embedding is not, so the expensive
 *    half is what gets skipped. An interrupted run heals itself on the next
 *    pass because missing vectors are detected from the chunks themselves.
 */

export type IndexEvent =
  | { readonly type: 'phase'; readonly phase: 'chunking' | 'embedding' | 'terms' | 'pruning' }
  | {
      readonly type: 'note'
      readonly id: string
      readonly index: number
      readonly total: number
      readonly state: 'chunked' | 'unchanged' | 'skipped'
    }
  | { readonly type: 'embedding'; readonly done: number; readonly total: number }

export interface IndexOptions {
  /** Re-chunk and re-embed everything, ignoring the caches. */
  readonly full?: boolean | undefined
  /** Activate the space that was built. Defaults to true. */
  readonly activate?: boolean | undefined
  /** Vectors written to the database per transaction. */
  readonly persistBatch?: number | undefined
  readonly onEvent?: ((event: IndexEvent) => void) | undefined
}

export interface IndexReport {
  readonly spaceId: string
  readonly model: string
  readonly dim: number
  readonly active: boolean
  readonly notesTotal: number
  readonly notesChunked: number
  readonly notesUnchanged: number
  readonly notesSkipped: number
  /** Notes whose chunks were removed because they left the active set. */
  readonly notesDropped: number
  readonly chunks: number
  readonly uniqueTexts: number
  readonly embedded: number
  readonly reused: number
  readonly prunedVectors: number
  /** Outgoing links recorded across the project. */
  readonly links: number
  readonly danglingLinks: number
  /** Notes whose terms were re-extracted. */
  readonly notesTermed: number
  readonly tookMs: number
}

export async function indexProject(
  db: Db,
  config: ProjectConfig,
  resolved: ResolvedEmbedder,
  options: IndexOptions = {},
): Promise<IndexReport> {
  const started = Date.now()
  const { embedder, model } = resolved

  const descriptor = describeSpace(model, config.chunking)
  const space = spaceId(descriptor)
  ensureSpace(db, space, descriptor)

  const notes = listNotes(db, { status: 'active', limit: -1 })
  const pending = new Map<string, string>()

  const kept = new Set<string>()
  const changed: Note[] = []
  const trees = new Map<string, Root>()
  let notesChunked = 0
  let notesUnchanged = 0
  let notesSkipped = 0
  let chunks = 0

  options.onEvent?.({ type: 'phase', phase: 'chunking' })

  notes.forEach((note, index) => {
    // Notes that failed the gate on import are stored but never indexed:
    // embedding non-English text produces vectors that only add noise.
    if (note.lang !== 'en') {
      notesSkipped += 1
      options.onEvent?.({ type: 'note', id: note.id, index, total: notes.length, state: 'skipped' })
      return
    }

    kept.add(note.id)

    const tree = parseTree(note.body)
    trees.set(note.id, tree)

    const parsed = parseMarkdown(note.body, tree)
    const specs = chunkDocument(parsed.blocks, config.chunking, embedder.counter)
    chunks += specs.length

    for (const spec of specs) pending.set(spec.textHash, spec.embedText)

    if (options.full !== true && chunksAreCurrent(db, space, note.id, specs)) {
      notesUnchanged += 1
      options.onEvent?.({
        type: 'note',
        id: note.id,
        index,
        total: notes.length,
        state: 'unchanged',
      })
      return
    }

    replaceNoteChunks(db, space, note.id, specs)
    changed.push(note)
    notesChunked += 1
    options.onEvent?.({ type: 'note', id: note.id, index, total: notes.length, state: 'chunked' })
  })

  // Archiving a note takes it out of `listNotes`, so nothing else would ever
  // delete its chunks and search would keep returning it. Sweeping the space
  // against the set we just kept is what actually retires a note, and it also
  // covers a note that stopped being English.
  let notesDropped = 0
  for (const indexed of indexedNoteIds(db, space)) {
    if (kept.has(indexed)) continue
    deleteNoteChunks(db, space, indexed)
    notesDropped += 1
  }

  // Rebuilt from the bodies on every run: a link that was dangling because its
  // target did not exist yet resolves here, and one whose target went away goes
  // back to dangling. Reuses the trees the chunker already parsed.
  const linkReport = rebuildLinks(db, trees)

  const hashes = [...pending.keys()]
  const missing = options.full === true ? hashes : missingHashes(db, space, hashes)

  options.onEvent?.({ type: 'phase', phase: 'embedding' })
  options.onEvent?.({ type: 'embedding', done: 0, total: missing.length })

  const persistBatch = options.persistBatch ?? Math.max(32, config.model.batchSize * 4)
  let embedded = 0

  for (let start = 0; start < missing.length; start += persistBatch) {
    const slice = missing.slice(start, start + persistBatch)
    const texts = slice.map((hash) => pending.get(hash) ?? '')
    const vectors = await embedder.embedDocuments(texts)

    putEmbeddings(
      db,
      space,
      slice.map((hash, offset) => ({ textHash: hash, vector: vectors[offset]! })),
    )

    embedded += slice.length
    options.onEvent?.({ type: 'embedding', done: embedded, total: missing.length })
  }

  // Terms come last because the strongest of their three signals is the
  // cosine between a candidate and the note, and the note's vectors only exist
  // once the embedding pass above has run.
  options.onEvent?.({ type: 'phase', phase: 'terms' })
  const notesTermed = await extractTerms(db, config, resolved, space, changed, trees, options)

  options.onEvent?.({ type: 'phase', phase: 'pruning' })
  const prunedVectors = pruneOrphanEmbeddings(db, space)

  const shouldActivate = options.activate !== false
  if (shouldActivate && getActiveSpace(db)?.id !== space) setActiveSpace(db, space)

  return {
    spaceId: space,
    model: model.id,
    dim: model.dim,
    active: getActiveSpace(db)?.id === space,
    notesTotal: notes.length,
    notesChunked,
    notesUnchanged,
    notesSkipped,
    notesDropped,
    chunks,
    uniqueTexts: hashes.length,
    embedded,
    reused: hashes.length - missing.length,
    prunedVectors,
    links: linkReport.links,
    danglingLinks: linkReport.dangling,
    notesTermed,
    tookMs: Date.now() - started,
  }
}

/** True when the stored chunks for a note match the freshly computed ones exactly. */
function chunksAreCurrent(
  db: Db,
  space: string,
  noteId: string,
  specs: readonly ChunkSpec[],
): boolean {
  const stored = listNoteChunks(db, space, noteId)
  if (stored.length !== specs.length) return false

  const key = (strategy: string, ord: number, hash: string): string => `${strategy}:${ord}:${hash}`
  const storedKeys = new Set(stored.map((chunk) => key(chunk.strategy, chunk.ord, chunk.textHash)))

  return specs.every((spec) => storedKeys.has(key(spec.strategy, spec.ord, spec.textHash)))
}

/**
 * Re-extracts terms for the notes whose content changed.
 *
 * Unchanged notes keep the terms they already have: extraction is not free, and
 * the only inputs that can have moved for an unchanged note are corpus-wide
 * statistics, which shift slowly enough that a full pass belongs to `--full`.
 */
async function extractTerms(
  db: Db,
  config: ProjectConfig,
  resolved: ResolvedEmbedder,
  space: string,
  changed: readonly Note[],
  trees: ReadonlyMap<string, Root>,
  options: IndexOptions,
): Promise<number> {
  const notes = options.full === true ? listNotes(db, { status: 'active', limit: -1 }) : changed
  if (notes.length === 0) return 0

  const context = buildTermContext(db)
  const vectors = buildNoteVectors(db, space, resolved.model.dim)
  const candidateVectors = new Map<string, Float32Array>()

  for (const note of notes) {
    await extractNoteTerms(
      db,
      config,
      resolved,
      note,
      { context, vectors, candidateVectors },
      trees.get(note.id),
    )
  }

  finishTermPass(db)
  return notes.length
}

/** Mean of a note's chunk vectors: what the candidate cosine is measured against. */
function buildNoteVectors(db: Db, space: string, dim: number): NoteVectorSource {
  const sums = new Map<string, { vector: Float32Array; count: number }>()

  for (const chunk of loadChunkVectors(db, space, dim)) {
    const entry = sums.get(chunk.noteId) ?? { vector: new Float32Array(dim), count: 0 }
    for (let i = 0; i < dim; i += 1) entry.vector[i] = (entry.vector[i] ?? 0) + (chunk.vector[i] ?? 0)
    entry.count += 1
    sums.set(chunk.noteId, entry)
  }

  const means = new Map<string, Float32Array>()
  for (const [noteId, entry] of sums) {
    means.set(noteId, l2Normalize(entry.vector))
  }

  return { vectorFor: (noteId: string) => means.get(noteId) ?? null }
}
