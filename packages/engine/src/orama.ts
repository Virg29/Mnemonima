import { create, insertMultiple, search } from '@orama/orama'
import type { AnyOrama, Results } from '@orama/orama'
import { persist, restore } from '@orama/plugin-data-persistence'
import { hashObject, isStopword } from '@mnemonima/core'
import type { EmbeddingSpace } from '@mnemonima/core'
import {
  aliasesByNote,
  dataFingerprint,
  listNotes,
  loadChunkVectors,
  loadSnapshot,
  saveSnapshot,
  tagsByNote,
  termsByNote,
} from '@mnemonima/store'
import type { Db } from '@mnemonima/store'

/**
 * The Orama search layer — DESIGN.md 8.1.
 *
 * SQLite is the source of truth; Orama is the index built from it. Two indexes
 * per embedding space:
 *
 *  - `chunks` carries the text and the vector, and is what retrieval runs over
 *  - `notes` carries the metadata that earns a boost: title, aliases, terms,
 *    tags, outline
 *
 * **Why we do not call Orama's `mode: 'hybrid'`.** It fuses BM25 and cosine
 * internally and returns one opaque number. Every hit has to explain itself
 * (DESIGN.md 8.6), and the operator has to be able to move the text/vector
 * balance and see what changed, so we run the two modes separately and fuse
 * them ourselves. Orama still does both retrievals; only the arithmetic that
 * has to be explainable moved out.
 */

export interface ChunkDocument {
  chunkId: number
  noteId: string
  strategy: string
  kind: string
  headingPath: string
  text: string
  embedding: number[]
}

export interface NoteDocument {
  noteId: string
  title: string
  aliases: string[]
  keywordsManual: string[]
  keywordsAuto: string[]
  phrasesManual: string[]
  phrasesAuto: string[]
  tags: string[]
  outline: string
}

/** Fields the note index searches, in the order the boost map names them. */
export const NOTE_PROPERTIES = [
  'title',
  'aliases',
  'keywordsManual',
  'keywordsAuto',
  'phrasesManual',
  'phrasesAuto',
  'tags',
  'outline',
] as const

export interface SearchIndex {
  readonly spaceId: string
  readonly dim: number
  readonly chunks: AnyOrama
  readonly notes: AnyOrama
  readonly chunkCount: number
  readonly noteCount: number
  readonly builtInMs: number
  /** True when the index was restored rather than rebuilt from the rows. */
  readonly fromSnapshot: boolean
}

export interface BuildOptions {
  /**
   * Restore from a stored snapshot when one matches, and store one after
   * building.
   *
   * **Defaults to false, on measurement.** At 1600 chunks a rebuild takes about
   * 230 ms and a restore about 180 ms, while writing the snapshot adds 370 ms —
   * and any note edit invalidates it. The CLI would therefore pay the write on
   * most invocations and collect the saving on few, so it does not ask. The
   * daemon does: it rebuilds rarely and restarts occasionally, which is exactly
   * the shape the cache suits.
   */
  readonly snapshots?: boolean | undefined
}

/** Bump when the shape of either index changes in a way a snapshot cannot survive. */
const INDEX_VERSION = '1'

/**
 * `dpack`, not `binary`. The binary serialiser walks the index recursively and
 * gives up at depth 101, which a radix tree over real prose reaches easily;
 * dpack handles it and hands back a Buffer directly, with no string round trip
 * to get wrong.
 */
const SNAPSHOT_FORMAT = 'dpack'

/**
 * Above this a snapshot costs more than the rebuild it saves, and a single
 * multi-hundred-megabyte BLOB is not a cache, it is a liability.
 */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024

function chunkSchema(dim: number): Record<string, string> {
  return {
    chunkId: 'number',
    noteId: 'string',
    strategy: 'enum',
    kind: 'enum',
    headingPath: 'string',
    text: 'string',
    embedding: `vector[${dim}]`,
  }
}

const NOTE_SCHEMA: Record<string, string> = {
  noteId: 'string',
  title: 'string',
  aliases: 'string[]',
  keywordsManual: 'string[]',
  keywordsAuto: 'string[]',
  phrasesManual: 'string[]',
  phrasesAuto: 'string[]',
  tags: 'string[]',
  outline: 'string',
}

/**
 * Identity of a snapshot: the code that built it *and* the data it was built
 * from. Folding the data fingerprint into the version column means a stale
 * snapshot simply stops matching — there is no invalidation step for a writer
 * to forget.
 */
function snapshotVersion(db: Db, space: EmbeddingSpace): string {
  return `${INDEX_VERSION}:${hashObject({
    chunks: chunkSchema(space.dim),
    notes: NOTE_SCHEMA,
  }).slice(0, 8)}:${dataFingerprint(db, space.id).slice(0, 16)}`
}

/**
 * Builds both indexes from the database.
 *
 * The CLI pays this on every invocation. That is fine at the sizes stage one
 * produces and is exactly what the daemon's Orama snapshots remove later
 * (DESIGN.md 4.1) — the `orama_snapshots` table is already in the schema.
 */
export async function buildSearchIndex(
  db: Db,
  space: EmbeddingSpace,
  options: BuildOptions = {},
): Promise<SearchIndex> {
  const started = Date.now()
  const useSnapshots = options.snapshots === true
  const version = useSnapshots ? snapshotVersion(db, space) : null

  if (version !== null) {
    const restored = await restoreFromSnapshots(db, space, version, started)
    if (restored !== null) return restored
  }

  const chunks = create({ schema: chunkSchema(space.dim) as never })
  const notes = create({ schema: NOTE_SCHEMA as never })

  const chunkDocs: ChunkDocument[] = loadChunkVectors(db, space.id, space.dim).map((chunk) => ({
    chunkId: chunk.chunkId,
    noteId: chunk.noteId,
    strategy: chunk.strategy,
    kind: chunk.kind,
    headingPath: chunk.headingPath ?? '',
    text: chunk.text,
    embedding: Array.from(chunk.vector),
  }))

  const aliases = aliasesByNote(db)
  const tags = tagsByNote(db)
  const terms = termsByNote(db)

  const noteDocs: NoteDocument[] = listNotes(db, { status: 'active', limit: -1 }).map((note) => ({
    noteId: note.id,
    title: note.title,
    aliases: aliases.get(note.id) ?? [],
    keywordsManual: terms.keywordsManual.get(note.id) ?? [],
    keywordsAuto: terms.keywordsAuto.get(note.id) ?? [],
    phrasesManual: terms.phrasesManual.get(note.id) ?? [],
    phrasesAuto: terms.phrasesAuto.get(note.id) ?? [],
    tags: tags.get(note.id) ?? [],
    outline: note.outline ?? '',
  }))

  if (chunkDocs.length > 0) await insertMultiple(chunks, chunkDocs as never[])
  if (noteDocs.length > 0) await insertMultiple(notes, noteDocs as never[])

  if (version !== null) {
    // Best effort: a snapshot that cannot be written costs a rebuild next time,
    // never correctness, and a read-only database should not fail a search.
    try {
      const chunkBlob = await serialise(chunks)
      const noteBlob = await serialise(notes)

      if (chunkBlob.byteLength + noteBlob.byteLength <= MAX_SNAPSHOT_BYTES) {
        saveSnapshot(db, space.id, 'chunks', version, chunkBlob)
        saveSnapshot(db, space.id, 'notes', version, noteBlob)
      }
    } catch {
      /* ignore */
    }
  }

  return {
    spaceId: space.id,
    dim: space.dim,
    chunks,
    notes,
    chunkCount: chunkDocs.length,
    noteCount: noteDocs.length,
    builtInMs: Date.now() - started,
    fromSnapshot: false,
  }
}

async function restoreFromSnapshots(
  db: Db,
  space: EmbeddingSpace,
  version: string,
  started: number,
): Promise<SearchIndex | null> {
  const chunkBlob = loadSnapshot(db, space.id, 'chunks', version)
  const noteBlob = loadSnapshot(db, space.id, 'notes', version)
  if (chunkBlob === null || noteBlob === null) return null

  try {
    const chunks = (await restore(SNAPSHOT_FORMAT, Buffer.from(chunkBlob.blob))) as AnyOrama
    const notes = (await restore(SNAPSHOT_FORMAT, Buffer.from(noteBlob.blob))) as AnyOrama

    return {
      spaceId: space.id,
      dim: space.dim,
      chunks,
      notes,
      chunkCount: countDocuments(chunks),
      noteCount: countDocuments(notes),
      builtInMs: Date.now() - started,
      fromSnapshot: true,
    }
  } catch {
    // A snapshot written by an incompatible build is a cache miss, not a fault.
    return null
  }
}

async function serialise(index: AnyOrama): Promise<Uint8Array> {
  const data = await persist(index, SNAPSHOT_FORMAT)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return Buffer.from(data as ArrayBuffer)
}

function countDocuments(index: AnyOrama): number {
  const store = (index as { data?: { docs?: { count?: number } } }).data?.docs?.count
  return typeof store === 'number' ? store : 0
}

export interface ChunkHit {
  readonly document: ChunkDocument
  readonly score: number
}

/**
 * Drops stop words from a query before the BM25 passes.
 *
 * Orama's default is that a document matching *any* term is a hit, and BM25
 * scores are normalised per result set — so a query like "growing vegetables in
 * a warm bed" would let notes that match only "in" and "a" take the full text
 * score, and they did. Stripping function words is the standard remedy and
 * costs nothing.
 *
 * A query made entirely of stop words is passed through unchanged: answering
 * "the" badly beats answering it not at all.
 */
export function lexicalQuery(term: string): string {
  const words = term.split(/\s+/).filter((word) => word !== '')
  const content = words.filter((word) => !isStopword(word.replace(/[^A-Za-z0-9_+#.-]/g, '')))

  return content.length === 0 ? term : content.join(' ')
}

/** BM25 over chunk text. Scores are unbounded, so callers normalise. */
export async function searchChunksLexical(
  index: SearchIndex,
  term: string,
  limit: number,
  tolerance: number,
): Promise<ChunkHit[]> {
  if (index.chunkCount === 0 || term.trim() === '') return []

  const results = (await search(index.chunks, {
    term: lexicalQuery(term),
    mode: 'fulltext',
    properties: ['text', 'headingPath'],
    boost: { text: 1, headingPath: 1.5 },
    tolerance,
    limit,
  } as never)) as Results<ChunkDocument>

  return results.hits.map((hit) => ({ document: hit.document, score: hit.score }))
}

/** Cosine over chunk vectors. Scores are already comparable across queries. */
export async function searchChunksVector(
  index: SearchIndex,
  vector: Float32Array,
  limit: number,
  similarity: number,
): Promise<ChunkHit[]> {
  if (index.chunkCount === 0) return []

  const results = (await search(index.chunks, {
    mode: 'vector',
    vector: { value: Array.from(vector), property: 'embedding' },
    similarity,
    includeVectors: false,
    limit,
  } as never)) as Results<ChunkDocument>

  return results.hits.map((hit) => ({ document: hit.document, score: hit.score }))
}

export interface NoteHit {
  readonly noteId: string
  readonly score: number
}

/**
 * BM25 over note metadata, with the per-field boosts from the configuration.
 *
 * A field whose boost is zero is dropped from the search rather than passed
 * with a zero weight: zero means "do not consider this field", and Orama
 * rejects a zero boost outright. `keywords.autoWeight = 0` is the setting that
 * reaches this — automatic terms visible in the UI but excluded from ranking.
 */
export async function searchNoteMetadata(
  index: SearchIndex,
  term: string,
  limit: number,
  tolerance: number,
  boost: Partial<Record<string, number>>,
): Promise<NoteHit[]> {
  if (index.noteCount === 0 || term.trim() === '') return []

  const active = Object.entries(boost).filter(([, weight]) => (weight ?? 0) > 0)
  if (active.length === 0) return []

  const results = (await search(index.notes, {
    term: lexicalQuery(term),
    mode: 'fulltext',
    properties: active.map(([field]) => field),
    boost: Object.fromEntries(active),
    tolerance,
    // Every term must be present. Metadata fields are short, so Orama's default
    // of "at least one term" lets a stopword match a title and — after
    // normalisation — hand an unrelated note the full metadata score. Chunk text
    // keeps the permissive default, where partial matches are genuinely useful.
    threshold: 0,
    limit,
  } as never)) as Results<NoteDocument>

  return results.hits.map((hit) => ({ noteId: hit.document.noteId, score: hit.score }))
}

/**
 * Scales a result set into 0..1 by its own maximum.
 *
 * BM25 is unbounded and its range depends on the corpus and the query, so a raw
 * score cannot be weighed against a cosine. Normalising per result set makes the
 * text/vector weights mean what the operator expects: a relative balance rather
 * than an accident of scale. Cosines are left alone — they are already
 * comparable, which is what keeps `minSimilarity` meaningful.
 */
export function normaliseScores<T extends { score: number }>(hits: readonly T[]): Map<T, number> {
  const max = hits.reduce((best, hit) => Math.max(best, hit.score), 0)
  const out = new Map<T, number>()
  for (const hit of hits) out.set(hit, max > 0 ? hit.score / max : 0)
  return out
}
