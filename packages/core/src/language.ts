import { francAll } from 'franc-min'
import { LanguageGateError } from './errors.js'
import { stripCode } from './markdown.js'

/**
 * The English-only gate — DESIGN.md 11.
 *
 * Layer 1 (`findBlockedScript`) is a hard, cheap, deterministic writing-system
 * check. It targets *scripts*, not "non-ASCII": dashes, quotes, degree signs,
 * diacritics in proper nouns, emoji and mathematical symbols are all legitimate
 * English text and must pass.
 *
 * Greek is deliberately absent from the blocklist. Single Greek letters are
 * standard mathematical notation in technical notes — lambda, mu, alpha appear
 * in our own configuration — and blocking them would produce a false positive
 * on every other note. Greek *prose* is caught by layer 2 instead.
 *
 * Layer 2 (`detectLanguage`) is statistical, so it can be wrong. It only
 * rejects when the detector is decisive: English losing narrowly to another
 * Latin-script language is treated as noise, not as a violation.
 *
 * Layer 3 is the caller's choice of `gateCodeBlocks`: fenced code may carry
 * string literals in any language and is stripped before either layer runs.
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

/** Below this many characters statistical detection is noise, so it is skipped. */
export const MIN_DETECTION_LENGTH = 40

/** English may lose to another language by this much before it counts as a violation. */
const DETECTION_MARGIN = 0.85

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

export interface LanguageDetection {
  /** ISO 639-3 code, or `und` when the text is too short to judge. */
  readonly code: string
  /** True when English is absent or clearly beaten. */
  readonly decisive: boolean
}

export function detectLanguage(text: string): LanguageDetection {
  if (text.trim().length < MIN_DETECTION_LENGTH) return { code: 'und', decisive: false }

  const scores = francAll(text)
  const top = scores[0]
  if (top === undefined || top[0] === 'und') return { code: 'und', decisive: false }
  if (top[0] === 'eng') return { code: 'eng', decisive: false }

  const english = scores.find(([code]) => code === 'eng')
  const decisive = english === undefined || english[1] < top[1] * DETECTION_MARGIN

  return { code: top[0], decisive }
}

export type GateReason = 'script' | 'language'

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

  const detection = detectLanguage(source)
  if (detection.decisive) {
    const finding: GateFinding = {
      reason: 'language',
      message: `${subject} looks like "${detection.code}", not English`,
      details: { subject, detected: detection.code },
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
      hint:
        result.finding.reason === 'script'
          ? 'all stored content and every query must be English (DESIGN.md 11)'
          : 'set language.gate to "warn" in the project config if this detection is wrong',
    })
  }

  return result.finding
}
