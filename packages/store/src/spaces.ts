import { BadRequestError, NotFoundError } from '@mnemonima/core'
import type { EmbeddingSpace, SpaceDescriptor } from '@mnemonima/core'
import type { Db } from './db.js'

/**
 * Embedding space repository — DESIGN.md 6.4.
 *
 * `spaces.is_active` is the single source of truth for which space search uses.
 * Exactly one row can carry the flag, enforced by activating inside a
 * transaction that clears the others first.
 */

interface SpaceRow {
  id: string
  model: string
  dim: number
  chunker_version: string
  config_json: string
  is_active: number
  created_at: number
}

function toSpace(row: SpaceRow): EmbeddingSpace {
  return {
    id: row.id,
    model: row.model,
    dim: row.dim,
    chunkerVersion: row.chunker_version,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  }
}

/** Inserts the space when it is new. Existing spaces are left untouched. */
export function ensureSpace(db: Db, id: string, descriptor: SpaceDescriptor): EmbeddingSpace {
  db.prepare(
    'INSERT INTO spaces (id, model, dim, chunker_version, config_json, is_active, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING',
  ).run(id, descriptor.model, descriptor.dim, descriptor.chunkerVersion, JSON.stringify(descriptor), Date.now())

  return requireSpace(db, id)
}

export function getSpace(db: Db, id: string): EmbeddingSpace | null {
  const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow | undefined
  return row === undefined ? null : toSpace(row)
}

export function requireSpace(db: Db, id: string): EmbeddingSpace {
  const space = getSpace(db, id)
  if (space !== null) return space

  throw new NotFoundError(`no embedding space ${id} in this project`, {
    details: { id },
    hint: 'run `mnemonima index -p <project>` to build it',
  })
}

export function listSpaces(db: Db): EmbeddingSpace[] {
  const rows = db.prepare('SELECT * FROM spaces ORDER BY created_at').all() as SpaceRow[]
  return rows.map(toSpace)
}

export function getActiveSpace(db: Db): EmbeddingSpace | null {
  const row = db.prepare('SELECT * FROM spaces WHERE is_active = 1').get() as SpaceRow | undefined
  return row === undefined ? null : toSpace(row)
}

export function requireActiveSpace(db: Db): EmbeddingSpace {
  const space = getActiveSpace(db)
  if (space !== null) return space

  throw new NotFoundError('this project has no active embedding space', {
    details: {},
    hint: 'run `mnemonima index -p <project>` first: nothing has been embedded yet',
  })
}

/** Activation is exclusive: the previous active space is cleared in the same transaction. */
export function setActiveSpace(db: Db, id: string): EmbeddingSpace {
  const activate = db.transaction((): EmbeddingSpace => {
    requireSpace(db, id)
    db.prepare('UPDATE spaces SET is_active = 0 WHERE is_active = 1').run()
    db.prepare('UPDATE spaces SET is_active = 1 WHERE id = ?').run(id)
    return requireSpace(db, id)
  })

  return activate()
}

export interface SpaceUsage {
  readonly chunks: number
  readonly embeddings: number
  readonly notes: number
}

export function spaceUsage(db: Db, id: string): SpaceUsage {
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE space_id = ?').get(id) as {
    n: number
  }
  const embeddings = db
    .prepare('SELECT COUNT(*) AS n FROM embeddings WHERE space_id = ?')
    .get(id) as { n: number }
  const notes = db
    .prepare('SELECT COUNT(DISTINCT note_id) AS n FROM chunks WHERE space_id = ?')
    .get(id) as { n: number }

  return { chunks: chunks.n, embeddings: embeddings.n, notes: notes.n }
}

/**
 * Drops a space with its chunks and vectors. Refuses the active one: losing the
 * index you are searching with should take a deliberate second step.
 */
export function deleteSpace(db: Db, id: string): void {
  const space = requireSpace(db, id)
  if (space.isActive) {
    throw new BadRequestError(`space ${id} is active and cannot be deleted`, {
      details: { id },
      hint: 'activate another space first: `mnemonima space activate <id>`',
    })
  }

  db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
}
