import { MnemonimaError } from '@mnemonima/core'

/**
 * Output discipline (DESIGN.md 12.1): with `--json`, stdout carries JSON and
 * nothing else. Every diagnostic, progress line and warning goes to stderr, so
 * an agent can pipe stdout straight into a parser.
 */

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function printLine(message = ''): void {
  process.stdout.write(`${message}\n`)
}

export function printNote(message: string): void {
  process.stderr.write(`${message}\n`)
}

export function printWarning(message: string): void {
  process.stderr.write(`warning: ${message}\n`)
}

/**
 * Failures always print the same two shapes:
 *
 *     error: what went wrong
 *     hint: what to do about it
 *
 * The hint is the point. A CLI that only says "no" makes the operator guess.
 */
export function printFailure(error: unknown): void {
  if (error instanceof MnemonimaError) {
    process.stderr.write(`error: ${error.message}\n`)
    if (error.hint !== undefined) process.stderr.write(`hint: ${error.hint}\n`)
    return
  }

  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`internal error: ${message}\n`)
  process.stderr.write('hint: this is a bug in mnemonima, not a problem with your input\n')
}

/** Renders `label  value` pairs with the labels padded to a common width. */
export function printFields(fields: readonly (readonly [string, string])[]): void {
  const width = fields.reduce((max, [label]) => Math.max(max, label.length), 0)
  for (const [label, value] of fields) {
    printLine(`  ${label.padEnd(width)}  ${value}`)
  }
}

export function printTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  const widths = headers.map((header, column) =>
    rows.reduce((max, row) => Math.max(max, (row[column] ?? '').length), header.length),
  )

  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()

  printLine(render(headers))
  printLine(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) printLine(render(row))
}

/**
 * Single-line progress on stderr. Rewrites itself on a terminal and falls back
 * to nothing when the output is a pipe, so logs stay readable.
 */
export class Progress {
  readonly #enabled: boolean
  #lastLength = 0

  constructor(enabled: boolean) {
    this.#enabled = enabled && process.stderr.isTTY === true
  }

  update(message: string): void {
    if (!this.#enabled) return
    process.stderr.write(`\r${message.padEnd(this.#lastLength)}`)
    this.#lastLength = message.length
  }

  done(message?: string): void {
    if (!this.#enabled) return
    process.stderr.write(`\r${' '.repeat(this.#lastLength)}\r`)
    this.#lastLength = 0
    if (message !== undefined) process.stderr.write(`${message}\n`)
  }
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes} m ${Math.round((ms % 60_000) / 1000)} s`
}
