/** Core entity types. These mirror the SQLite schema in DESIGN.md 3.1. */

export type NoteStatus = 'active' | 'draft' | 'archived'
export type TermSource = 'manual' | 'auto'
export type TermKind = 'keyword' | 'phrase'
export type LinkKind = 'wikilink' | 'mdlink' | 'manual'
export type ChunkStrategy = 'fine' | 'coarse'
export type ChunkKind = 'prose' | 'code'
export type RevisionOp = 'create' | 'update' | 'delete' | 'import' | 'adopt'

export interface Note {
  id: string
  title: string
  body: string
  bodyHash: string
  outline: string | null
  lang: string
  status: NoteStatus
  rev: number
  createdAt: number
  updatedAt: number
}

export interface Alias {
  noteId: string
  alias: string
  source: TermSource
}

/**
 * `dst` has no foreign key on purpose: a link to a note that does not exist is
 * preserved as written. If the operator referenced something, there was a
 * reason (DESIGN.md 3.4).
 */
export interface Link {
  src: string
  dst: string
  anchor: string | null
  heading: string | null
  kind: LinkKind
  resolved: boolean
}

export interface Term {
  id: number
  term: string
  lemma: string
  source: TermSource
  pinned: boolean
  blocked: boolean
  weight: number
  df: number
  createdAt: number
}

export interface NoteTerm {
  noteId: string
  termId: number
  kind: TermKind
  score: number
  source: TermSource
}

/**
 * An embedding space is addressed by the hash of everything that can invalidate
 * it: model, dimensions, prefixes, normalization, chunker version, strategies
 * (DESIGN.md 6.4).
 */
export interface EmbeddingSpace {
  id: string
  model: string
  dim: number
  chunkerVersion: string
  config: Record<string, unknown>
  isActive: boolean
  createdAt: number
}

export interface Chunk {
  id: number
  spaceId: string
  noteId: string
  strategy: ChunkStrategy
  ord: number
  headingPath: string | null
  kind: ChunkKind
  text: string
  textHash: string
  tokens: number
}

export interface NoteRevision {
  noteId: string
  rev: number
  title: string
  body: string
  op: RevisionOp
  /** `cli` | `ui` | `mcp:<client>` | `import` | `adopt` */
  author: string
  batchId: string | null
  createdAt: number
}

export interface ProjectSummary {
  name: string
  dir: string
  prefix: string
  notes: number
  chunks: number
  activeSpace: string | null
  createdAt: number
}
