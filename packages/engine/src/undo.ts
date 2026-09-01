import { BadRequestError, NotFoundError } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  batchTouchedNotes,
  deleteNote,
  getNote,
  getRevision,
  listRevisions,
  requireNote,
  updateNote,
} from '@mnemonima/store'
import type { Db } from '@mnemonima/store'
import { syncNoteLinks } from './links.js'

/**
 * Undo — DESIGN.md 10.3.
 *
 * The MCP server has full write access, so a bad agent run has to be one
 * command away from being taken back. Two shapes:
 *
 *  - `revert` puts one note back to a revision it held before;
 *  - `undoBatch` takes back everything one session wrote.
 *
 * Neither is destructive. A revert is itself a revision, so undoing an undo is
 * just another revert, and the log keeps the whole story. A note the batch
 * *created* is archived rather than deleted, for the same reason: the audit
 * trail is the point, and hard-deleting the evidence of what an agent did would
 * defeat it.
 */

export interface RevertResult {
  readonly noteId: string
  readonly fromRev: number
  readonly toRev: number
  readonly newRev: number
}

export function revertNote(
  db: Db,
  config: ProjectConfig,
  id: string,
  rev: number,
  author: string,
): RevertResult {
  const current = requireNote(db, id)

  if (rev === current.rev) {
    throw new BadRequestError(`note ${id} is already at revision ${rev}`, {
      details: { id, rev },
      hint: `run \`mnemonima history ${id}\` to see what else there is`,
    })
  }

  const target = getRevision(db, id, rev)
  if (target === null) {
    const available = listRevisions(db, id).map((entry) => entry.rev)
    throw new NotFoundError(`note ${id} has no revision ${rev}`, {
      details: { id, rev, available },
      hint: `available revisions: ${available.join(', ')}`,
    })
  }

  // A revert is a normal write: it moves forward to a state that existed
  // before, rather than rewriting history.
  const restored = updateNote(db, id, {
    title: target.title,
    body: target.body,
    author,
    op: 'update',
  })
  syncNoteLinks(db, id, target.body)

  return { noteId: id, fromRev: current.rev, toRev: rev, newRev: restored.rev }
}

export interface UndoAction {
  readonly noteId: string
  readonly action: 'restored' | 'archived' | 'missing'
  /** The revision restored, when there was one to go back to. */
  readonly toRev?: number
}

export interface UndoReport {
  readonly batchId: string
  readonly actions: UndoAction[]
}

/**
 * Takes back everything a batch wrote.
 *
 * For each note the batch touched, the state to restore is the revision *before*
 * its first write in that batch. When there is none, the batch created the note,
 * and it is archived instead.
 */
export function undoBatch(
  db: Db,
  config: ProjectConfig,
  batchId: string,
  author: string,
): UndoReport {
  const touched = batchTouchedNotes(db, batchId)

  if (touched.length === 0) {
    throw new NotFoundError(`no writes recorded for batch "${batchId}"`, {
      details: { batchId },
      hint: 'run `mnemonima history --batches` to see the recent ones',
    })
  }

  const actions: UndoAction[] = []

  const run = db.transaction(() => {
    for (const { noteId, firstRev } of touched) {
      const note = getNote(db, noteId)

      if (note === null) {
        // Hard-deleted since. The revisions survive as the audit trail, but
        // there is no row to put anything back into.
        actions.push({ noteId, action: 'missing' })
        continue
      }

      if (firstRev <= 1) {
        deleteNote(db, noteId, { author })
        actions.push({ noteId, action: 'archived' })
        continue
      }

      const previous = getRevision(db, noteId, firstRev - 1)
      if (previous === null) {
        actions.push({ noteId, action: 'missing' })
        continue
      }

      updateNote(db, noteId, {
        title: previous.title,
        body: previous.body,
        author,
        op: 'update',
      })
      syncNoteLinks(db, noteId, previous.body)
      actions.push({ noteId, action: 'restored', toRev: previous.rev })
    }
  })

  run()
  return { batchId, actions }
}

/**
 * A batch id for one writing session.
 *
 * Readable rather than random: an operator reading `history --batches` should be
 * able to tell an agent session from an import at a glance.
 */
export function newBatchId(prefix: string, now: number, random: string): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return `${prefix}-${stamp}-${random}`
}
