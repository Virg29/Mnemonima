import fs from 'node:fs'
import path from 'node:path'
import { formatNoteId, parseNoteId } from '@mnemonima/core'
import type { Link } from '@mnemonima/core'
import {
  META,
  danglingLinks,
  getActiveSpace,
  getMeta,
  getMetaNumber,
  listNotes,
  orphanNoteIds,
  setMeta,
} from '@mnemonima/store'
import type { Db } from '@mnemonima/store'
import { rebuildLinks } from './links.js'

/**
 * `doctor` — DESIGN.md 15.9.
 *
 * What holds a graph together over time is noticing when it drifts. Every check
 * here is *reported*, never silently corrected: a dangling link and an orphan
 * note are both legitimate states, and deciding otherwise is the operator's
 * call. `--fix` touches only the two things that are mechanically wrong — a link
 * whose target now exists, and an id counter that fell behind.
 */

export interface DanglingLinkReport {
  readonly src: string
  readonly target: string
  readonly anchor: string | null
}

export interface AttachmentReport {
  readonly noteId: string
  readonly target: string
}

export interface DuplicateAliasReport {
  readonly alias: string
  readonly notes: string[]
}

export interface DoctorReport {
  readonly notes: number
  readonly links: number
  /** Links whose target is not a note here. Information, not an error. */
  readonly dangling: DanglingLinkReport[]
  /** Active notes with no link in either direction. */
  readonly orphans: string[]
  /** Stored but never indexed, because they did not pass the language gate. */
  readonly nonEnglish: string[]
  /** Active notes with no chunks in the active space. */
  readonly unindexed: string[]
  /** Chunks whose embedding is missing; the next index run recreates them. */
  readonly chunksWithoutVectors: number
  /** Set when `meta.id_counter` is below the highest id in use. */
  readonly idCounterBehind: { readonly counter: number; readonly highest: number } | null
  readonly missingAttachments: AttachmentReport[]
  readonly duplicateAliases: DuplicateAliasReport[]
  readonly activeSpace: string | null
}

export interface DoctorOptions {
  /** Project directory, used to check that attachment paths exist. */
  readonly dir?: string | undefined
}

/** `![alt](path)` and `![[file]]`, which are the two Obsidian embeds. */
const ATTACHMENT = /!\[[^\]]*\]\(([^)\s]+)\)|!\[\[([^\]\n|#]+)/g
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i

export function runDoctor(db: Db, options: DoctorOptions = {}): DoctorReport {
  const notes = listNotes(db, { status: 'any', limit: -1 })
  const active = notes.filter((note) => note.status === 'active')
  const space = getActiveSpace(db)

  const dangling: DanglingLinkReport[] = danglingLinks(db).map((link: Link) => ({
    src: link.src,
    target: link.dst,
    anchor: link.anchor,
  }))

  const linkCount = (db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n

  const unindexed =
    space === null
      ? []
      : (
          db
            .prepare(
              "SELECT id FROM notes WHERE status = 'active' AND lang = 'en'" +
                ' AND id NOT IN (SELECT DISTINCT note_id FROM chunks WHERE space_id = ?)' +
                ' ORDER BY id',
            )
            .all(space.id) as { id: string }[]
        ).map((row) => row.id)

  const chunksWithoutVectors =
    space === null
      ? 0
      : (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM chunks c WHERE c.space_id = ? AND NOT EXISTS' +
                ' (SELECT 1 FROM embeddings e WHERE e.space_id = c.space_id AND e.text_hash = c.text_hash)',
            )
            .get(space.id) as { n: number }
        ).n

  const duplicateAliases = (
    db
      .prepare(
        'SELECT alias, GROUP_CONCAT(note_id) AS notes, COUNT(DISTINCT note_id) AS n' +
          ' FROM aliases GROUP BY alias HAVING n > 1 ORDER BY alias',
      )
      .all() as { alias: string; notes: string }[]
  ).map((row) => ({ alias: row.alias, notes: row.notes.split(',') }))

  return {
    notes: notes.length,
    links: linkCount,
    dangling,
    orphans: orphanNoteIds(db),
    nonEnglish: notes.filter((note) => note.lang !== 'en').map((note) => note.id),
    unindexed,
    chunksWithoutVectors,
    idCounterBehind: checkIdCounter(db),
    missingAttachments: options.dir === undefined ? [] : findMissingAttachments(active, options.dir),
    duplicateAliases,
    activeSpace: space?.id ?? null,
  }
}

function checkIdCounter(db: Db): { counter: number; highest: number } | null {
  const counter = getMetaNumber(db, META.ID_COUNTER, 0)
  const prefix = getMeta(db, META.ID_PREFIX)
  if (prefix === null) return null

  let highest = 0
  for (const note of listNotes(db, { status: 'any', limit: -1 })) {
    const parsed = parseNoteId(note.id)
    if (parsed !== null && parsed.prefix === prefix) highest = Math.max(highest, parsed.seq)
  }

  return highest > counter ? { counter, highest } : null
}

function findMissingAttachments(
  notes: readonly { id: string; body: string }[],
  dir: string,
): AttachmentReport[] {
  const missing: AttachmentReport[] = []

  for (const note of notes) {
    for (const match of note.body.matchAll(ATTACHMENT)) {
      const target = (match[1] ?? match[2] ?? '').trim()
      if (target === '' || EXTERNAL.test(target)) continue

      const decoded = decode(target)
      if (path.isAbsolute(decoded)) {
        if (!fs.existsSync(decoded)) missing.push({ noteId: note.id, target })
        continue
      }

      if (!fs.existsSync(path.join(dir, decoded))) missing.push({ noteId: note.id, target })
    }
  }

  return missing
}

function decode(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

export interface DoctorFixReport {
  /** Links that now resolve after rebuilding from the bodies. */
  readonly linksResolved: number
  readonly idCounterRaisedTo: string | null
}

/**
 * Mechanical repairs only. Nothing here decides anything on the operator's
 * behalf: dangling links, orphans and non-English notes are left exactly as
 * they are.
 */
export function fixDoctorFindings(db: Db): DoctorFixReport {
  const before = danglingLinks(db).length
  const rebuilt = rebuildLinks(db)

  const behind = checkIdCounter(db)
  let raisedTo: string | null = null

  if (behind !== null) {
    setMeta(db, META.ID_COUNTER, String(behind.highest))
    const prefix = getMeta(db, META.ID_PREFIX)
    raisedTo = prefix === null ? null : formatNoteId(prefix, behind.highest)
  }

  return {
    linksResolved: Math.max(0, before - rebuilt.dangling),
    idCounterRaisedTo: raisedTo,
  }
}
