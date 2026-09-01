import { BadRequestError } from './errors.js'

/**
 * Note ids are immutable (DESIGN.md A4). There is no rename operation: extra
 * surface forms live in the `aliases` table instead.
 */
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,3}$/
const NOTE_ID_PATTERN = /^([A-Z][A-Z0-9]{1,3})-(\d{4,})$/

export const ID_SEQUENCE_PADDING = 4

export interface ParsedNoteId {
  readonly prefix: string
  readonly seq: number
}

export function isValidPrefix(value: string): boolean {
  return PREFIX_PATTERN.test(value)
}

export function assertValidPrefix(value: string): string {
  if (!isValidPrefix(value)) {
    throw new BadRequestError(
      `invalid project prefix "${value}": expected 2-4 characters, ` +
        `uppercase letters and digits, starting with a letter`,
      {
        details: { prefix: value },
        hint: 'pick something short and stable, for example --prefix SL',
      },
    )
  }
  return value
}

/**
 * Derives a project prefix from a project name: initials of its words, or the
 * first three letters when the name is a single word.
 *
 *   "Shader Lab"  -> "SL"
 *   "Shaders"     -> "SHA"
 *   "kb"          -> "KB"
 */
export function derivePrefix(projectName: string): string {
  const words = projectName.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0)
  const alphabetic = words.filter((word) => /^[A-Za-z]/.test(word))

  const initials = alphabetic.map((word) => word[0]!.toUpperCase()).join('')
  const first = alphabetic[0]

  const candidate =
    initials.length >= 2 ? initials.slice(0, 4) : (first ?? '').slice(0, 3).toUpperCase()

  if (!isValidPrefix(candidate)) {
    throw new BadRequestError(
      `cannot derive a project prefix from "${projectName}"`,
      {
        details: { projectName, candidate },
        hint: 'pass one explicitly, for example --prefix KB',
      },
    )
  }

  return candidate
}

export function formatNoteId(prefix: string, seq: number): string {
  assertValidPrefix(prefix)
  if (!Number.isInteger(seq) || seq < 1) {
    throw new BadRequestError(`note sequence must be a positive integer, got ${seq}`, {
      details: { seq },
      hint: 'note ids start at 1; the counter in `meta.id_counter` may be corrupted',
    })
  }
  return `${prefix}-${String(seq).padStart(ID_SEQUENCE_PADDING, '0')}`
}

export function parseNoteId(value: string): ParsedNoteId | null {
  const match = NOTE_ID_PATTERN.exec(value)
  if (match === null) return null
  return { prefix: match[1]!, seq: Number(match[2]!) }
}

export function isNoteId(value: string): boolean {
  return parseNoteId(value) !== null
}
