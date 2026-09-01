import { LanguageGateError } from './errors.js'
import { stripCode } from './markdown.js'

/**
 * The English-only gate — DESIGN.md 11.
 *
 * One check, not three. `findBlockedScript` is a hard, cheap, deterministic
 * writing-system test, and `gateCodeBlocks` decides whether fenced code is
 * exempt from it. That is the whole gate.
 *
 * **It targets scripts, not "non-ASCII".** Dashes, curly quotes, degree signs,
 * diacritics in proper nouns (`Gouraud`, `Björk`), emoji and mathematical
 * symbols are legitimate English and must pass. An ASCII-only rule would reject
 * every one of them.
 *
 * **Greek is deliberately absent from the list.** Single Greek letters are
 * standard mathematical notation in technical notes — lambda and mu name
 * parameters in our own configuration — so blocking the script would fire on
 * every other note.
 *
 * There used to be a statistical layer over `franc-min`. It was removed because
 * it rejected correct English: on the query "why does a particle break
 * rendering when it opens its own buffer" the detector ranked Dutch first at
 * 1.000 and did not rank English at all, and the gate read that absence as
 * proof rather than as the detector having nothing to go on. Sixty-four
 * characters is not enough text for trigram statistics, and a search query is
 * rarely longer. What the layer could catch was Latin-script prose, which the
 * model handles poorly but does not choke on; what it cost was a correct answer
 * to a correct question, from the one consumer that matters.
 */

export type LanguageGateMode = 'strict' | 'warn' | 'off'

interface BlockedScript {
  readonly name: string
  readonly pattern: RegExp
}

const BLOCKED_SCRIPTS: readonly BlockedScript[] = [
  { name: 'Cyrillic', pattern: /\p{Script=Cyrillic}/u },
  { name: 'Han', pattern: /\p{Script=Han}/u },
  { name: 'Hiragana', pattern: /\p{Script=Hiragana}/u },
  { name: 'Katakana', pattern: /\p{Script=Katakana}/u },
  { name: 'Hangul', pattern: /\p{Script=Hangul}/u },
  { name: 'Arabic', pattern: /\p{Script=Arabic}/u },
  { name: 'Hebrew', pattern: /\p{Script=Hebrew}/u },
  { name: 'Devanagari', pattern: /\p{Script=Devanagari}/u },
  { name: 'Thai', pattern: /\p{Script=Thai}/u },
  { name: 'Armenian', pattern: /\p{Script=Armenian}/u },
  { name: 'Georgian', pattern: /\p{Script=Georgian}/u },
]

export interface TextPosition {
  readonly line: number
  readonly column: number
}

export interface ScriptViolation {
  readonly script: string
  readonly index: number
  readonly char: string
  readonly position: TextPosition
}

export function positionOf(text: string, index: number): TextPosition {
  const upTo = text.slice(0, index)
  const lines = upTo.split('\n')
  return { line: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 }
}

/** Returns the earliest blocked-script occurrence, or null when the text passes. */
export function findBlockedScript(text: string): ScriptViolation | null {
  let earliest: ScriptViolation | null = null

  for (const { name, pattern } of BLOCKED_SCRIPTS) {
    const index = text.search(pattern)
    if (index < 0) continue
    if (earliest !== null && index >= earliest.index) continue
    earliest = {
      script: name,
      index,
      char: String.fromCodePoint(text.codePointAt(index) ?? 0),
      position: positionOf(text, index),
    }
  }

  return earliest
}

export function isEnglishScript(text: string): boolean {
  return findBlockedScript(text) === null
}

export type GateReason = 'script'

export interface GateFinding {
  readonly reason: GateReason
  readonly message: string
  readonly details: Record<string, unknown>
}

export interface GateOptions {
  readonly mode?: LanguageGateMode
  /** When false (the default) fenced and inline code is exempt. */
  readonly gateCodeBlocks?: boolean
}

export interface GateResult {
  readonly ok: boolean
  readonly finding: GateFinding | null
  /** True when a finding exists but the mode says to report rather than reject. */
  readonly warning: boolean
}

export function gateText(text: string, subject: string, options: GateOptions = {}): GateResult {
  const mode = options.mode ?? 'strict'
  if (mode === 'off') return { ok: true, finding: null, warning: false }

  const source = options.gateCodeBlocks === true ? text : stripCode(text)

  const violation = findBlockedScript(source)
  if (violation !== null) {
    const finding: GateFinding = {
      reason: 'script',
      message:
        `${subject} must be in English: found ${violation.script} character ` +
        `"${violation.char}" at line ${violation.position.line}, ` +
        `column ${violation.position.column}`,
      details: { subject, ...violation },
    }
    return { ok: mode === 'warn', finding, warning: mode === 'warn' }
  }

  return { ok: true, finding: null, warning: false }
}

/**
 * Layer 1 only. Used where statistical detection makes no sense — project
 * names, note titles, single-word queries.
 */
export function assertEnglishScript(text: string, subject: string): void {
  const violation = findBlockedScript(text)
  if (violation === null) return

  throw new LanguageGateError(
    `${subject} must be in English: found ${violation.script} character ` +
      `"${violation.char}" at line ${violation.position.line}, ` +
      `column ${violation.position.column}`,
    {
      details: { subject, ...violation },
      hint: 'all stored content and every query must be English (DESIGN.md 11)',
    },
  )
}

/**
 * Full gate. Throws in `strict` mode, returns the finding in `warn` mode so the
 * caller can log it, returns null when the text is clean.
 */
export function assertEnglish(
  text: string,
  subject: string,
  options: GateOptions = {},
): GateFinding | null {
  const result = gateText(text, subject, options)
  if (result.finding === null) return null

  if (!result.ok) {
    throw new LanguageGateError(result.finding.message, {
      details: result.finding.details,
      hint: 'all stored content and every query must be English (DESIGN.md 11)',
    })
  }

  return result.finding
}
