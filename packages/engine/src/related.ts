import { BadRequestError } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { outgoingLinks, requireNote } from '@mnemonima/store'
import type { Db } from '@mnemonima/store'
import { writeNoteBody } from './notes.js'

/**
 * Creating and removing links from the outside — DESIGN.md 13.1.
 *
 * Links are derived from note bodies, so `link` and `unlink` edit the body
 * rather than the `links` table. Anything else would be a second source of
 * truth that the next `index` run would silently overwrite.
 *
 * New links go into a `## Related` section at the end of the note. The position
 * of a link inside a paragraph carries meaning and cannot be guessed; a section
 * at the end is predictable, diffable, trivially reverted, and Obsidian shows it
 * as ordinary outgoing links.
 */

export const RELATED_HEADING = '## Related'

const RELATED_PATTERN = /^##\s+related\s*$/i
const ANY_HEADING = /^#{1,2}\s+/

export interface LinkChange {
  readonly noteId: string
  readonly rev: number
  readonly target: string
}

export function addRelatedLink(
  db: Db,
  config: ProjectConfig,
  src: string,
  dst: string,
  anchor: string | null,
  author: string,
): LinkChange {
  const source = requireNote(db, src)
  const target = requireNote(db, dst)

  if (src === dst) {
    throw new BadRequestError(`${src} cannot link to itself`, {
      details: { src },
      hint: 'a self link carries no information and is skipped by the graph',
    })
  }

  const existing = outgoingLinks(db, src).find((link) => link.dst === dst)
  if (existing !== undefined) {
    throw new BadRequestError(`${src} already links to ${dst}`, {
      details: { src, dst, anchor: existing.anchor },
      hint: `edit the body with \`mnemonima edit ${src}\` to change how it is written`,
    })
  }

  const label = `${target.id} ${target.title}`.trim()
  const bullet = anchor === null ? `- [[${label}]]` : `- [[${label}|${anchor}]]`
  const body = insertIntoRelated(source.body, bullet)

  const result = writeNoteBody(db, config, src, body, { title: source.title, author })
  return { noteId: src, rev: result.note.rev, target: dst }
}

export function removeRelatedLink(
  db: Db,
  config: ProjectConfig,
  src: string,
  dst: string,
  author: string,
): LinkChange {
  const source = requireNote(db, src)

  const link = outgoingLinks(db, src).find((candidate) => candidate.dst === dst)
  if (link === undefined) {
    throw new BadRequestError(`${src} does not link to ${dst}`, {
      details: { src, dst },
      hint: `run \`mnemonima get ${src}\` to see what it does link to`,
    })
  }

  const { body, removed } = dropFromRelated(source.body, dst)
  if (!removed) {
    // The link is written into the prose, where cutting it out would change the
    // meaning of a sentence. That edit belongs to a human.
    throw new BadRequestError(`the link from ${src} to ${dst} is not in the ${RELATED_HEADING} section`, {
      details: { src, dst },
      hint: `it is written into the text: edit it by hand with \`mnemonima edit ${src}\``,
    })
  }

  const result = writeNoteBody(db, config, src, body, { title: source.title, author })
  return { noteId: src, rev: result.note.rev, target: dst }
}

function insertIntoRelated(body: string, bullet: string): string {
  const lines = body.replace(/\s+$/, '').split('\n')
  const heading = lines.findIndex((line) => RELATED_PATTERN.test(line))

  if (heading < 0) {
    return `${lines.join('\n')}\n\n${RELATED_HEADING}\n\n${bullet}\n`
  }

  let end = lines.length
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (ANY_HEADING.test(lines[i] ?? '')) {
      end = i
      break
    }
  }

  // Step back over the blank lines that separate this section from the next.
  while (end > heading + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1

  lines.splice(end, 0, bullet)
  return `${lines.join('\n')}\n`
}

function dropFromRelated(body: string, dst: string): { body: string; removed: boolean } {
  const lines = body.split('\n')
  const heading = lines.findIndex((line) => RELATED_PATTERN.test(line))
  if (heading < 0) return { body, removed: false }

  let end = lines.length
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (ANY_HEADING.test(lines[i] ?? '')) {
      end = i
      break
    }
  }

  const kept: string[] = []
  let removed = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const inSection = i > heading && i < end
    if (inSection && !removed && isBulletFor(line, dst)) {
      removed = true
      continue
    }
    kept.push(line)
  }

  return { body: kept.join('\n'), removed }
}

function isBulletFor(line: string, dst: string): boolean {
  const match = /^\s*[-*]\s*\[\[([^\]]+)\]\]\s*$/.exec(line)
  if (match === null) return false

  const target = (match[1] ?? '').split('|')[0]?.split('#')[0]?.trim() ?? ''
  return target === dst || target.split(/\s+/)[0] === dst
}
