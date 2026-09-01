import { parseLinks, parseNoteId } from '@mnemonima/core'
import type { ParsedLink } from '@mnemonima/core'
import type { Root } from 'mdast'
import { aliasesByNote, listNotes, replaceNoteLinks } from '@mnemonima/store'
import type { Db, LinkInput } from '@mnemonima/store'

/**
 * Link resolution — DESIGN.md 3.4.
 *
 * Order: the leading id token, then aliases, then the exact title. The first
 * match wins.
 *
 * A target that resolves to nothing is **kept as written** with `resolved = 0`.
 * That is the whole point: a link to an id that does not exist is data, not
 * corruption, and `doctor` reports it without touching it. It also means a
 * forward reference works — write `[[SL-0100]]` before SL-0100 exists, and the
 * link starts resolving the moment it does.
 */

export interface LinkResolver {
  resolve(target: string): { dst: string; resolved: boolean }
}

export function buildResolver(db: Db): LinkResolver {
  // Archived notes still resolve: the note exists, and search excludes it on
  // its own. A link into the archive is not a dangling link.
  const notes = listNotes(db, { status: 'any', limit: -1 })

  const ids = new Set(notes.map((note) => note.id))
  const byTitle = new Map<string, string>()
  const byAlias = new Map<string, string>()

  // Notes arrive in id order, so the lowest id wins a duplicate title, which
  // keeps resolution deterministic rather than dependent on write order.
  for (const note of notes) {
    const key = note.title.trim().toLowerCase()
    if (key !== '' && !byTitle.has(key)) byTitle.set(key, note.id)
  }

  for (const [noteId, aliases] of aliasesByNote(db)) {
    for (const alias of aliases) {
      const key = alias.trim().toLowerCase()
      if (key !== '' && !byAlias.has(key)) byAlias.set(key, noteId)
    }
  }

  return {
    resolve(target: string) {
      const leading = target.trim().split(/\s+/)[0] ?? ''
      if (parseNoteId(leading) !== null) {
        return { dst: leading, resolved: ids.has(leading) }
      }

      const key = target.trim().toLowerCase()

      const alias = byAlias.get(key)
      if (alias !== undefined) return { dst: alias, resolved: true }

      const title = byTitle.get(key)
      if (title !== undefined) return { dst: title, resolved: true }

      return { dst: target.trim(), resolved: false }
    },
  }
}

export function toLinkInputs(
  links: readonly ParsedLink[],
  resolver: LinkResolver,
): LinkInput[] {
  return links.map((link) => {
    const { dst, resolved } = resolver.resolve(link.target)
    return { dst, anchor: link.anchor, heading: link.heading, kind: link.kind, resolved }
  })
}

/**
 * Rewrites the outgoing links of one note from its body.
 *
 * Called on every write so that neighbours are correct immediately, without
 * waiting for the next `index` run.
 */
export function syncNoteLinks(
  db: Db,
  noteId: string,
  body: string,
  resolver?: LinkResolver,
  tree?: Root,
): number {
  const links = parseLinks(body, tree)
  const inputs = toLinkInputs(links, resolver ?? buildResolver(db))
  replaceNoteLinks(db, noteId, inputs)
  return inputs.length
}

export interface LinkSyncReport {
  readonly notes: number
  readonly links: number
  readonly dangling: number
}

/**
 * Rebuilds the whole link graph from note bodies.
 *
 * Run by `index` and by `doctor --fix`: a link that was dangling because its
 * target did not exist yet resolves here, and one whose target was archived or
 * deleted goes back to dangling.
 */
export function rebuildLinks(db: Db, bodies?: ReadonlyMap<string, Root>): LinkSyncReport {
  const resolver = buildResolver(db)
  const notes = listNotes(db, { status: 'any', limit: -1 })

  let links = 0
  let dangling = 0

  db.transaction(() => {
    for (const note of notes) {
      const inputs = toLinkInputs(parseLinks(note.body, bodies?.get(note.id)), resolver)
      replaceNoteLinks(db, note.id, inputs)
      links += inputs.length
      dangling += inputs.filter((link) => !link.resolved).length
    }
  })()

  return { notes: notes.length, links, dangling }
}
