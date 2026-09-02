import { NotFoundError, diffText } from '@mnemonima/core'
import type { Diff } from '@mnemonima/core'
import { getRevision, listRevisions, requireNote } from '@mnemonima/store'
import type { Db } from '@mnemonima/store'

/**
 * Reading the revision log — DESIGN.md 10.3.
 *
 * The log recorded when a note changed and who changed it, and there was no way
 * to see *what* changed: the only route to an old body was `revert`, so looking
 * meant editing. Every revision already carries the whole body, so this is
 * lookup and arithmetic, not new bookkeeping.
 *
 * `0` means the note as it stands. It is not a revision number — the current
 * revision has a row of its own — but "compare with what is there now" is the
 * question actually asked, and spelling it as the live note rather than making
 * the caller find the latest number is the difference between a usable command
 * and one that needs `history` run first.
 */

export interface RevisionBody {
  readonly noteId: string
  /** `null` for the note as it stands. */
  readonly rev: number | null
  readonly title: string
  readonly body: string
  readonly op: string | null
  readonly author: string | null
  readonly createdAt: number
}

export interface RevisionDiff {
  readonly noteId: string
  readonly from: RevisionBody
  readonly to: RevisionBody
  readonly diff: Diff
}

/** One revision's body, or the live note when `rev` is 0 or omitted. */
export function readRevision(db: Db, id: string, rev?: number): RevisionBody {
  const note = requireNote(db, id)

  if (rev === undefined || rev === 0) {
    return {
      noteId: note.id,
      rev: null,
      title: note.title,
      body: note.body,
      op: null,
      author: null,
      createdAt: note.updatedAt,
    }
  }

  const found = getRevision(db, id, rev)

  if (found === null) {
    // Ascending, because a hint is read left to right.
    const available = listRevisions(db, id)
      .map((entry) => entry.rev)
      .sort((a, b) => a - b)

    throw new NotFoundError(`note ${id} has no revision ${rev}`, {
      details: { id, rev, available },
      hint:
        available.length === 0
          ? `run \`mnemonima history ${id}\` to see what there is`
          : `available revisions: ${available.join(', ')}`,
    })
  }

  return {
    noteId: id,
    rev: found.rev,
    title: found.title,
    body: found.body,
    op: found.op,
    author: found.author,
    createdAt: found.createdAt,
  }
}

export interface DiffRevisionsOptions {
  /** Defaults to the revision before `to`, which is the usual question. */
  readonly from?: number | undefined
  /** Defaults to the note as it stands. */
  readonly to?: number | undefined
  readonly context?: number | undefined
}

/**
 * What changed between two revisions.
 *
 * With neither end given it answers "what was the last edit": the note as it
 * stands against the revision before it. That is the question asked most often
 * and the one that otherwise takes two commands to ask.
 */
export function diffRevisions(db: Db, id: string, options: DiffRevisionsOptions = {}): RevisionDiff {
  const note = requireNote(db, id)

  const to = readRevision(db, id, options.to)

  const from =
    options.from !== undefined
      ? readRevision(db, id, options.from)
      : readRevision(db, id, previousTo(db, id, to.rev ?? note.rev))

  return {
    noteId: id,
    from,
    to,
    diff: diffText(from.body, to.body, { context: options.context ?? 3 }),
  }
}

/**
 * The revision recorded before this one.
 *
 * Not `rev - 1`: a revision number is only ever handed out by a write, so the
 * sequence has no gaps today — but reading the log rather than assuming means a
 * later feature that skips a number cannot silently produce a wrong diff.
 */
function previousTo(db: Db, id: string, rev: number): number {
  const earlier = listRevisions(db, id)
    .map((entry) => entry.rev)
    .filter((candidate) => candidate < rev)
    .sort((a, b) => b - a)

  const previous = earlier[0]

  if (previous === undefined) {
    throw new NotFoundError(`note ${id} has nothing before revision ${rev}`, {
      details: { id, rev },
      hint: `revision ${rev} is the first one; there is nothing to compare it with`,
    })
  }

  return previous
}
