import {
  assertEnglish,
  assertEnglishScript,
  BadRequestError,
  parseMarkdown,
  parseTree,
} from '@mnemonima/core'
import type { GateFinding, Note, ProjectConfig, RevisionOp } from '@mnemonima/core'
import { createNote, updateNote } from '@mnemonima/store'
import { syncNoteLinks } from './links.js'
import type { CreateNoteInput, Db, UpdateNoteInput } from '@mnemonima/store'

/**
 * Note authoring.
 *
 * Every path that puts text into the database goes through here, so the
 * language gate and the outline are never skipped — including writes coming
 * from an agent over MCP (DESIGN.md 10.3).
 *
 * `outline` is derived, never supplied: it is a rendering of the note's own
 * headings, and letting a caller set it would create a second source of truth.
 */

export interface PreparedNote {
  readonly title: string
  readonly body: string
  readonly outline: string | null
  /** Non-null when the gate is in `warn` mode and found something. */
  readonly warning: GateFinding | null
}

export interface PrepareOptions {
  /** Falls back to the first level-one heading, then to the first line. */
  readonly title?: string | undefined
}

export function prepareNote(
  body: string,
  config: ProjectConfig,
  options: PrepareOptions = {},
): PreparedNote {
  if (body.trim() === '') {
    throw new BadRequestError('note body is empty', {
      details: {},
      hint: 'pass --body, --file <path>, or pipe markdown into stdin',
    })
  }

  const warning = assertEnglish(body, 'note body', {
    mode: config.language.gate,
    gateCodeBlocks: config.language.gateCodeBlocks,
  })

  const tree = parseTree(body)
  const parsed = parseMarkdown(body, tree)
  const title = (options.title ?? parsed.title ?? firstLine(body)).trim()

  if (title === '') {
    throw new BadRequestError('cannot determine a title for this note', {
      details: {},
      hint: 'start the body with a `# Heading`, or pass --title explicitly',
    })
  }
  // The title obeys the same mode as the body. It used to be checked
  // unconditionally, which meant `language.gate: off` did not actually turn the
  // gate off — a body could pass and its own heading still be refused.
  if (config.language.gate !== 'off') assertEnglishScript(title, 'note title')

  return { title, body, outline: parsed.outline, warning }
}

function firstLine(body: string): string {
  const line = body.split('\n').find((candidate) => candidate.trim() !== '')
  return (line ?? '').replace(/^#+\s*/, '').slice(0, 120)
}

export interface WriteNoteOptions extends PrepareOptions {
  readonly author: string
  readonly batchId?: string | null
  readonly id?: string | undefined
}

export interface WriteNoteResult {
  readonly note: Note
  readonly warning: GateFinding | null
}

export function writeNewNote(
  db: Db,
  config: ProjectConfig,
  body: string,
  options: WriteNoteOptions,
): WriteNoteResult {
  const prepared = prepareNote(body, config, { title: options.title })

  const input: CreateNoteInput = {
    id: options.id,
    title: prepared.title,
    body: prepared.body,
    outline: prepared.outline,
    author: options.author,
    batchId: options.batchId ?? null,
  }

  const note = createNote(db, input)
  syncNoteLinks(db, note.id, note.body)

  return { note, warning: prepared.warning }
}

export interface EditNoteOptions extends WriteNoteOptions {
  readonly expectedRev?: number | undefined
  /** Revision operation to record; the markdown bridge passes `import`. */
  readonly op?: RevisionOp | undefined
}

export function writeNoteBody(
  db: Db,
  config: ProjectConfig,
  id: string,
  body: string,
  options: EditNoteOptions,
): WriteNoteResult {
  const prepared = prepareNote(body, config, { title: options.title })

  const input: UpdateNoteInput = {
    title: prepared.title,
    body: prepared.body,
    outline: prepared.outline,
    author: options.author,
    batchId: options.batchId ?? null,
    expectedRev: options.expectedRev,
    op: options.op,
  }

  const note = updateNote(db, id, input)
  syncNoteLinks(db, note.id, note.body)

  return { note, warning: prepared.warning }
}
