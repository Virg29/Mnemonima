import type { Link, LinkKind } from '@mnemonima/core'
import type { Db } from './db.js'

/**
 * Link repository — DESIGN.md 3.4.
 *
 * `links.dst` has no foreign key on purpose. A link to a note that does not
 * exist is preserved exactly as written: if the operator referenced something,
 * there was a reason, and `doctor` reports it as information rather than as
 * corruption.
 *
 * Backlinks are never stored as editable state. They are one query —
 * `SELECT src FROM links WHERE dst = ?` — so there is no second source of truth
 * to fall out of sync when a body is edited.
 */

interface LinkRow {
  src: string
  dst: string
  anchor: string
  heading: string | null
  kind: string
  resolved: number
}

function toLink(row: LinkRow): Link {
  return {
    src: row.src,
    dst: row.dst,
    anchor: row.anchor === '' ? null : row.anchor,
    heading: row.heading,
    kind: row.kind as LinkKind,
    resolved: row.resolved === 1,
  }
}

export interface LinkInput {
  readonly dst: string
  readonly anchor?: string | null
  readonly heading?: string | null
  readonly kind: LinkKind
  readonly resolved: boolean
}

/** Replaces every outgoing link of a note. Links are derived, so never patched. */
export function replaceNoteLinks(db: Db, src: string, links: readonly LinkInput[]): void {
  const insert = db.prepare(
    'INSERT INTO links (src, dst, anchor, heading, kind, resolved) VALUES (?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT(src, dst, anchor) DO UPDATE SET' +
      ' heading = excluded.heading, kind = excluded.kind, resolved = excluded.resolved',
  )

  db.transaction(() => {
    db.prepare('DELETE FROM links WHERE src = ?').run(src)
    for (const link of links) {
      insert.run(src, link.dst, link.anchor ?? '', link.heading ?? null, link.kind, link.resolved ? 1 : 0)
    }
  })()
}

export function outgoingLinks(db: Db, src: string): Link[] {
  const rows = db
    .prepare('SELECT * FROM links WHERE src = ? ORDER BY dst, anchor')
    .all(src) as LinkRow[]
  return rows.map(toLink)
}

/** Derived, never stored: this is the whole backlink implementation. */
export function incomingLinks(db: Db, dst: string): Link[] {
  const rows = db
    .prepare('SELECT * FROM links WHERE dst = ? ORDER BY src, anchor')
    .all(dst) as LinkRow[]
  return rows.map(toLink)
}

export function allLinks(db: Db): Link[] {
  const rows = db.prepare('SELECT * FROM links ORDER BY src, dst, anchor').all() as LinkRow[]
  return rows.map(toLink)
}

/** Links whose target is not a note in this project. Data, not corruption. */
export function danglingLinks(db: Db): Link[] {
  const rows = db
    .prepare('SELECT * FROM links WHERE resolved = 0 ORDER BY src, dst')
    .all() as LinkRow[]
  return rows.map(toLink)
}

export function deleteLink(db: Db, src: string, dst: string, anchor: string | null): number {
  return db
    .prepare('DELETE FROM links WHERE src = ? AND dst = ? AND anchor = ?')
    .run(src, dst, anchor ?? '').changes
}

export function deleteLinksBetween(db: Db, src: string, dst: string): number {
  return db.prepare('DELETE FROM links WHERE src = ? AND dst = ?').run(src, dst).changes
}

export interface NeighbourSets {
  /** Note id -> ids it links to that exist in this project. */
  readonly outgoing: Map<string, Set<string>>
  /** Note id -> ids that link to it. */
  readonly incoming: Map<string, Set<string>>
}

/**
 * The whole resolved graph in one query.
 *
 * Search needs neighbours of many notes at once for the graph boost; asking per
 * note would be one round trip per hit.
 */
export function loadNeighbours(db: Db): NeighbourSets {
  const rows = db
    .prepare('SELECT src, dst FROM links WHERE resolved = 1')
    .all() as { src: string; dst: string }[]

  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()

  for (const row of rows) {
    if (row.src === row.dst) continue

    const out = outgoing.get(row.src) ?? new Set<string>()
    out.add(row.dst)
    outgoing.set(row.src, out)

    const back = incoming.get(row.dst) ?? new Set<string>()
    back.add(row.src)
    incoming.set(row.dst, back)
  }

  return { outgoing, incoming }
}

/** Distinct neighbours in either direction, which is what the boost divides by. */
export function degreeOf(neighbours: NeighbourSets, id: string): number {
  const combined = new Set<string>([
    ...(neighbours.outgoing.get(id) ?? []),
    ...(neighbours.incoming.get(id) ?? []),
  ])
  return combined.size
}

export function countLinks(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }
  return row.n
}

/**
 * Active notes with no *resolved* link in either direction.
 *
 * Only resolved links count: a note whose single link points at an id that does
 * not exist is connected to nothing, and reporting it as connected would hide
 * exactly the case the operator wants to see.
 */
export function orphanNoteIds(db: Db): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM notes WHERE status = 'active'" +
        ' AND id NOT IN (SELECT src FROM links WHERE resolved = 1)' +
        ' AND id NOT IN (SELECT dst FROM links WHERE resolved = 1)' +
        ' ORDER BY id',
    )
    .all() as { id: string }[]
  return rows.map((row) => row.id)
}
