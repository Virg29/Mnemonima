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
 *
 * A target is also tried as a **file reference**, because notes that came from
 * a directory of markdown link to each other by filename: `[aspects](aspects.md)`,
 * `./aspects.md`, `../mechanics/aspects.md#heading`. The first real project
 * imported this way arrived with 118 links, every one of them dangling, and the
 * only thing wrong with them was the `.md`. Stripping the directory, the suffix
 * and the anchor turns the target back into a name the alias and title tables
 * already know — which is why `adopt` puts each original basename into
 * `aliases` (DESIGN.md 14.1).
 */

/**
 * `../mechanics/aspects.md#the-lock` -> `aspects`.
 *
 * Returns null when the target does not look like a file reference at all, so
 * an ordinary title containing a dot is not mangled into something shorter.
 */
export function fileReferenceName(target: string): string | null {
  const trimmed = target.trim()
  if (trimmed === '' || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null

  const withoutAnchor = trimmed.split('#')[0]?.split('?')[0] ?? ''
  const basename = withoutAnchor.split(/[\\/]/).pop() ?? ''

  if (!/\.(md|markdown)$/i.test(basename)) return null

  const name = basename.replace(/\.(md|markdown)$/i, '').trim()
  return name === '' ? null : name
}

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

      // Last, so a note actually named `notes.md` still wins over a file of
      // that name: the exact target is always tried before it is taken apart.
      const file = fileReferenceName(target)
      if (file !== null) {
        const name = file.toLowerCase()

        // A filename leading with an id — the shape our own export writes —
        // resolves through the id branch rather than the tables.
        const leadingId = file.split(/\s+/)[0] ?? ''
        if (parseNoteId(leadingId) !== null && ids.has(leadingId)) {
          return { dst: leadingId, resolved: true }
        }

        const byFileAlias = byAlias.get(name)
        if (byFileAlias !== undefined) return { dst: byFileAlias, resolved: true }

        const byFileTitle = byTitle.get(name)
        if (byFileTitle !== undefined) return { dst: byFileTitle, resolved: true }
      }

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
