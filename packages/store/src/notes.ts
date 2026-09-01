import { hashBody, NotFoundError, BadRequestError, parseNoteId } from '@mnemonima/core'
import type { Note, NoteStatus, RevisionOp } from '@mnemonima/core'
import type { Db } from './db.js'
import { META, getMeta, getMetaNumber, nextNoteId, setMeta } from './meta.js'

/**
 * Note repository.
 *
 * Every write records a revision. That is not optional bookkeeping: the MCP
 * server has full write access (DESIGN.md 10.3), so `author` and `batchId` are
 * what make an agent session reviewable and undoable after the fact.
 */

interface NoteRow {
  id: string
  title: string
  body: string
  body_hash: string
  outline: string | null
  lang: string
  status: string
  rev: number
  created_at: number
  updated_at: number
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    bodyHash: row.body_hash,
    outline: row.outline,
    lang: row.lang,
    status: row.status as NoteStatus,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface WriteContext {
  /** `cli` | `ui` | `mcp:<client>` | `import` | `adopt`. */
  readonly author: string
  /** Groups the writes of one session so they can be undone together. */
  readonly batchId?: string | null
}

export interface CreateNoteInput extends WriteContext {
  /** Allocated from the project counter when omitted. */
  readonly id?: string | undefined
  /** Revision operation to record. Defaults to `create`; import passes `import`. */
  readonly op?: RevisionOp | undefined
  readonly title: string
  readonly body: string
  readonly outline?: string | null
  readonly status?: NoteStatus
  readonly lang?: string
}

/**
 * Validates a caller-supplied id and moves the project counter past it.
 *
 * Without the counter bump, `new --id SL-0003` on a project whose counter is at
 * 2 makes the *next* ordinary `new` allocate SL-0003 and fail on a duplicate —
 * one command breaking an unrelated later one.
 */
function reserveExplicitId(db: Db, id: string): void {
  const parsed = parseNoteId(id)
  if (parsed === null) {
    throw new BadRequestError(`"${id}" is not a valid note id`, {
      details: { id },
      hint: 'ids look like SL-0042: a 2-4 character prefix, a dash, and at least four digits',
    })
  }

  const prefix = getMeta(db, META.ID_PREFIX)
  if (prefix !== null && parsed.prefix !== prefix) {
    throw new BadRequestError(
      `note id "${id}" uses prefix "${parsed.prefix}", but this project uses "${prefix}"`,
      {
        details: { id, given: parsed.prefix, expected: prefix },
        hint: `use ${prefix}-${String(parsed.seq).padStart(4, '0')}, or omit --id to allocate the next one`,
      },
    )
  }

  if (parsed.seq > getMetaNumber(db, META.ID_COUNTER, 0)) {
    setMeta(db, META.ID_COUNTER, String(parsed.seq))
  }
}

export interface UpdateNoteInput extends WriteContext {
  /**
   * Revision operation to record. Defaults to `update`; archiving passes
   * `delete` so the audit trail can tell a rewrite from a retirement.
   */
  readonly op?: RevisionOp | undefined
  readonly title?: string | undefined
  readonly body?: string | undefined
  readonly outline?: string | null | undefined
  readonly status?: NoteStatus | undefined
  /** Optimistic concurrency: reject the write if the note moved on. */
  readonly expectedRev?: number | undefined
}

function recordRevision(db: Db, note: Note, op: RevisionOp, context: WriteContext): void {
  db.prepare(
    'INSERT INTO note_revisions (note_id, rev, title, body, op, author, batch_id, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(note.id, note.rev, note.title, note.body, op, context.author, context.batchId ?? null, Date.now())
}

export function createNote(db: Db, input: CreateNoteInput): Note {
  const write = db.transaction((): Note => {
    const id = input.id ?? nextNoteId(db)
    if (input.id !== undefined) reserveExplicitId(db, input.id)

    if (getNote(db, id) !== null) {
      throw new BadRequestError(`note ${id} already exists`, {
        details: { id },
        hint: 'note ids are immutable and never reused; omit --id to allocate the next one',
      })
    }

    const now = Date.now()
    const note: Note = {
      id,
      title: input.title,
      body: input.body,
      bodyHash: hashBody(input.body),
      outline: input.outline ?? null,
      lang: input.lang ?? 'en',
      status: input.status ?? 'active',
      rev: 1,
      createdAt: now,
      updatedAt: now,
    }

    db.prepare(
      'INSERT INTO notes (id, title, body, body_hash, outline, lang, status, rev, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      note.id,
      note.title,
      note.body,
      note.bodyHash,
      note.outline,
      note.lang,
      note.status,
      note.rev,
      note.createdAt,
      note.updatedAt,
    )

    recordRevision(db, note, input.op ?? 'create', input)
    return note
  })

  return write()
}

export function updateNote(db: Db, id: string, input: UpdateNoteInput): Note {
  const write = db.transaction((): Note => {
    const current = requireNote(db, id)

    if (input.expectedRev !== undefined && input.expectedRev !== current.rev) {
      throw new BadRequestError(
        `note ${id} is at revision ${current.rev}, not ${input.expectedRev}`,
        {
          details: { id, actual: current.rev, expected: input.expectedRev },
          hint: `someone else changed it: re-read with \`mnemonima get ${id}\` and retry`,
        },
      )
    }

    const body = input.body ?? current.body
    const next: Note = {
      ...current,
      title: input.title ?? current.title,
      body,
      bodyHash: hashBody(body),
      outline: input.outline === undefined ? current.outline : input.outline,
      status: input.status ?? current.status,
      rev: current.rev + 1,
      updatedAt: Date.now(),
    }

    db.prepare(
      'UPDATE notes SET title = ?, body = ?, body_hash = ?, outline = ?, status = ?,' +
        ' rev = ?, updated_at = ? WHERE id = ?',
    ).run(
      next.title,
      next.body,
      next.bodyHash,
      next.outline,
      next.status,
      next.rev,
      next.updatedAt,
      next.id,
    )

    recordRevision(db, next, input.op ?? 'update', input)
    return next
  })

  return write()
}

export function getNote(db: Db, id: string): Note | null {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
  return row === undefined ? null : toNote(row)
}

export function requireNote(db: Db, id: string): Note {
  const note = getNote(db, id)
  if (note !== null) return note

  throw new NotFoundError(`no note ${id} in this project`, {
    details: { id },
    hint: 'run `mnemonima list -p <project>` to see the ids that exist',
  })
}

export interface ListNotesOptions {
  readonly status?: NoteStatus | 'any'
  readonly limit?: number
  readonly offset?: number
}

export function listNotes(db: Db, options: ListNotesOptions = {}): Note[] {
  const status = options.status ?? 'active'
  const where = status === 'any' ? '' : 'WHERE status = ?'
  const params = status === 'any' ? [] : [status]

  const rows = db
    .prepare(
      `SELECT * FROM notes ${where} ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit ?? 1000, options.offset ?? 0) as NoteRow[]

  return rows.map(toNote)
}

export function countNotes(db: Db, status: NoteStatus | 'any' = 'any'): number {
  const row =
    status === 'any'
      ? (db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number })
      : (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE status = ?').get(status) as {
          n: number
        })
  return row.n
}

export interface DeleteNoteOptions extends WriteContext {
  /**
   * Remove the row outright instead of archiving it. Archiving is the default
   * because a hard delete drops the note's chunks and revisions with it.
   */
  readonly hard?: boolean
}

export function deleteNote(db: Db, id: string, options: DeleteNoteOptions): Note {
  const remove = db.transaction((): Note => {
    const note = requireNote(db, id)

    if (options.hard === true) {
      // The tombstone takes the next revision number: the note's current one is
      // already in the log, and a delete is a change like any other.
      recordRevision(db, { ...note, rev: note.rev + 1 }, 'delete', options)
      db.prepare('DELETE FROM notes WHERE id = ?').run(id)
      // Revisions outlive the note on purpose: they are the audit trail.
      return note
    }

    return updateNote(db, id, {
      status: 'archived',
      op: 'delete',
      author: options.author,
      batchId: options.batchId ?? null,
    })
  })

  return remove()
}

export interface RevisionRow {
  readonly noteId: string
  readonly rev: number
  readonly title: string
  readonly op: RevisionOp
  readonly author: string
  readonly batchId: string | null
  readonly createdAt: number
}

export function listRevisions(db: Db, id: string): RevisionRow[] {
  const rows = db
    .prepare(
      'SELECT note_id, rev, title, op, author, batch_id, created_at' +
        ' FROM note_revisions WHERE note_id = ? ORDER BY rev DESC',
    )
    .all(id) as {
    note_id: string
    rev: number
    title: string
    op: string
    author: string
    batch_id: string | null
    created_at: number
  }[]

  return rows.map((row) => ({
    noteId: row.note_id,
    rev: row.rev,
    title: row.title,
    op: row.op as RevisionOp,
    author: row.author,
    batchId: row.batch_id,
    createdAt: row.created_at,
  }))
}

export interface RevisionContent extends RevisionRow {
  readonly body: string
}

export function getRevision(db: Db, id: string, rev: number): RevisionContent | null {
  const row = db
    .prepare('SELECT * FROM note_revisions WHERE note_id = ? AND rev = ?')
    .get(id, rev) as
    | {
        note_id: string
        rev: number
        title: string
        body: string
        op: string
        author: string
        batch_id: string | null
        created_at: number
      }
    | undefined

  if (row === undefined) return null

  return {
    noteId: row.note_id,
    rev: row.rev,
    title: row.title,
    body: row.body,
    op: row.op as RevisionOp,
    author: row.author,
    batchId: row.batch_id,
    createdAt: row.created_at,
  }
}

export interface BatchSummary {
  readonly batchId: string
  readonly author: string
  readonly notes: number
  readonly revisions: number
  readonly startedAt: number
  readonly endedAt: number
}

/**
 * Recent write batches, newest first.
 *
 * A batch is one agent session. Being able to see them is what makes
 * `undo --batch` usable: you cannot revert what you cannot name.
 */
export function listBatches(db: Db, limit = 20): BatchSummary[] {
  const rows = db
    .prepare(
      'SELECT batch_id, author, COUNT(DISTINCT note_id) AS notes, COUNT(*) AS revisions,' +
        ' MIN(created_at) AS started, MAX(created_at) AS ended' +
        ' FROM note_revisions WHERE batch_id IS NOT NULL' +
        ' GROUP BY batch_id, author ORDER BY ended DESC LIMIT ?',
    )
    .all(limit) as {
    batch_id: string
    author: string
    notes: number
    revisions: number
    started: number
    ended: number
  }[]

  return rows.map((row) => ({
    batchId: row.batch_id,
    author: row.author,
    notes: row.notes,
    revisions: row.revisions,
    startedAt: row.started,
    endedAt: row.ended,
  }))
}

/** Every note a batch touched, with the first revision it wrote for each. */
export function batchTouchedNotes(db: Db, batchId: string): { noteId: string; firstRev: number }[] {
  const rows = db
    .prepare(
      'SELECT note_id, MIN(rev) AS first_rev FROM note_revisions WHERE batch_id = ?' +
        ' GROUP BY note_id ORDER BY note_id',
    )
    .all(batchId) as { note_id: string; first_rev: number }[]

  return rows.map((row) => ({ noteId: row.note_id, firstRev: row.first_rev }))
}
