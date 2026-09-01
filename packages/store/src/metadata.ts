import { BadRequestError } from '@mnemonima/core'
import type { Alias, TermKind, TermSource } from '@mnemonima/core'
import type { Db } from './db.js'

/**
 * Per-note metadata, loaded for the whole project in one query each.
 *
 * The search index needs aliases, tags and terms grouped by note. Fetching them
 * one note at a time would be thousands of round trips for a build that runs on
 * every cold start.
 *
 * `aliases`, `tags` and `note_terms` stay empty until their own milestones; the
 * loaders exist now so the index schema and its boosts are already in place and
 * light up without a rebuild when the data arrives.
 */

function group(rows: readonly { key: string; value: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const bucket = out.get(row.key)
    if (bucket === undefined) out.set(row.key, [row.value])
    else bucket.push(row.value)
  }
  return out
}

export function aliasesByNote(db: Db): Map<string, string[]> {
  return group(
    db.prepare('SELECT note_id AS key, alias AS value FROM aliases ORDER BY note_id, alias').all() as {
      key: string
      value: string
    }[],
  )
}

export function tagsByNote(db: Db): Map<string, string[]> {
  return group(
    db.prepare('SELECT note_id AS key, tag AS value FROM tags ORDER BY note_id, tag').all() as {
      key: string
      value: string
    }[],
  )
}

export interface NoteTermGroups {
  readonly keywordsManual: Map<string, string[]>
  readonly keywordsAuto: Map<string, string[]>
  readonly phrasesManual: Map<string, string[]>
  readonly phrasesAuto: Map<string, string[]>
}

/**
 * Terms split four ways, because manual and automatic terms carry different
 * boosts: a term the operator entered outranks one an extractor guessed.
 */
export function termsByNote(db: Db): NoteTermGroups {
  const rows = db
    .prepare(
      'SELECT nt.note_id AS noteId, t.term AS term, nt.kind AS kind, nt.source AS source' +
        ' FROM note_terms nt JOIN terms t ON t.id = nt.term_id' +
        ' WHERE t.blocked = 0 ORDER BY nt.note_id, nt.score DESC',
    )
    .all() as { noteId: string; term: string; kind: TermKind; source: TermSource }[]

  const buckets = {
    keywordsManual: new Map<string, string[]>(),
    keywordsAuto: new Map<string, string[]>(),
    phrasesManual: new Map<string, string[]>(),
    phrasesAuto: new Map<string, string[]>(),
  }

  for (const row of rows) {
    const key =
      row.kind === 'keyword'
        ? row.source === 'manual'
          ? 'keywordsManual'
          : 'keywordsAuto'
        : row.source === 'manual'
          ? 'phrasesManual'
          : 'phrasesAuto'

    const target = buckets[key]
    const bucket = target.get(row.noteId)
    if (bucket === undefined) target.set(row.noteId, [row.term])
    else bucket.push(row.term)
  }

  return buckets
}

/**
 * Aliases are extra surface forms of a note: the "additional occurrences" of the
 * original design. They are searched with their own boost, and link resolution
 * consults them before falling back to titles — which is what lets a note be
 * referenced by a name it no longer carries.
 */
export function listAliases(db: Db, noteId: string): Alias[] {
  const rows = db
    .prepare('SELECT note_id, alias, source FROM aliases WHERE note_id = ? ORDER BY alias')
    .all(noteId) as { note_id: string; alias: string; source: TermSource }[]

  return rows.map((row) => ({ noteId: row.note_id, alias: row.alias, source: row.source }))
}

export function addAlias(db: Db, noteId: string, alias: string, source: TermSource = 'manual'): void {
  const trimmed = alias.trim()
  if (trimmed === '') {
    throw new BadRequestError('alias must not be empty', {
      details: { noteId },
      hint: 'give the surface form you want the note to answer to',
    })
  }

  db.prepare(
    'INSERT INTO aliases (note_id, alias, source) VALUES (?, ?, ?)' +
      ' ON CONFLICT(note_id, alias) DO UPDATE SET source = excluded.source',
  ).run(noteId, trimmed, source)
}

export function removeAlias(db: Db, noteId: string, alias: string): number {
  return db.prepare('DELETE FROM aliases WHERE note_id = ? AND alias = ?').run(noteId, alias.trim())
    .changes
}

export function listTags(db: Db, noteId: string): string[] {
  const rows = db
    .prepare('SELECT tag FROM tags WHERE note_id = ? ORDER BY tag')
    .all(noteId) as { tag: string }[]
  return rows.map((row) => row.tag)
}

/** Replaces the tags of a note: the caller always has the whole set. */
export function setNoteTags(db: Db, noteId: string, tags: readonly string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)')

  db.transaction(() => {
    db.prepare('DELETE FROM tags WHERE note_id = ?').run(noteId)
    for (const tag of tags) {
      const trimmed = tag.trim().replace(/^#/, '')
      if (trimmed !== '') insert.run(noteId, trimmed)
    }
  })()
}
