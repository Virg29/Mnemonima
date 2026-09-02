/**
 * A line diff, for comparing two revisions of a note.
 *
 * Written here rather than pulled in, because the whole job is a longest common
 * subsequence over a few hundred lines of markdown and a dependency would be
 * more surface than code. It lives in `core` for the usual reason: no I/O, and
 * three callers want it — the CLI, the daemon's API and the page.
 *
 * Line-based, not word-based. A note body is prose in paragraphs, and the unit
 * an operator reads a change in is the line — the same unit git shows them.
 */

export type DiffOp = 'equal' | 'add' | 'remove'

export interface DiffLine {
  readonly op: DiffOp
  readonly text: string
  /** 1-based line number in the old body, or null for an addition. */
  readonly before: number | null
  /** 1-based line number in the new body, or null for a removal. */
  readonly after: number | null
}

/** A run of changed lines with a few unchanged ones either side. */
export interface DiffHunk {
  readonly beforeStart: number
  readonly beforeCount: number
  readonly afterStart: number
  readonly afterCount: number
  readonly lines: readonly DiffLine[]
}

export interface Diff {
  readonly hunks: readonly DiffHunk[]
  readonly added: number
  readonly removed: number
  /** True when the two sides are the same text. */
  readonly identical: boolean
  /**
   * Set when the bodies were too large to compare line by line, and the diff
   * fell back to "everything replaced". Says so rather than pretending.
   */
  readonly truncated: boolean
}

/**
 * Above this, the quadratic table is not worth building.
 *
 * 4000 lines a side is 16 million cells — well past any note, and the point at
 * which an honest refusal beats a page freezing.
 */
const MAX_LINES = 4000

function split(text: string): string[] {
  const normalised = text.replace(/\r\n/g, '\n')
  const lines = normalised.split('\n')

  // A trailing newline produces an empty last element that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  return lines
}

/**
 * The longest common subsequence, as a table of lengths.
 *
 * Common prefix and suffix are stripped first, which is what makes this cheap
 * in practice: an edit to one paragraph of a long note leaves almost nothing
 * for the quadratic part to chew on.
 */
function lcs(before: readonly string[], after: readonly string[]): Int32Array {
  const rows = before.length + 1
  const columns = after.length + 1
  const table = new Int32Array(rows * columns)

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] =
        before[i] === after[j]
          ? (table[(i + 1) * columns + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * columns + j] ?? 0, table[i * columns + j + 1] ?? 0)
    }
  }

  return table
}

function walk(before: readonly string[], after: readonly string[], offset: number): DiffLine[] {
  const columns = after.length + 1
  const table = lcs(before, after)
  const lines: DiffLine[] = []

  let i = 0
  let j = 0

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ op: 'equal', text: before[i]!, before: offset + i + 1, after: offset + j + 1 })
      i += 1
      j += 1
    } else if ((table[(i + 1) * columns + j] ?? 0) >= (table[i * columns + j + 1] ?? 0)) {
      lines.push({ op: 'remove', text: before[i]!, before: offset + i + 1, after: null })
      i += 1
    } else {
      lines.push({ op: 'add', text: after[j]!, before: null, after: offset + j + 1 })
      j += 1
    }
  }

  while (i < before.length) {
    lines.push({ op: 'remove', text: before[i]!, before: offset + i + 1, after: null })
    i += 1
  }

  while (j < after.length) {
    lines.push({ op: 'add', text: after[j]!, before: null, after: offset + j + 1 })
    j += 1
  }

  return lines
}

/** Groups the changed lines into hunks, each with `context` unchanged lines around it. */
function toHunks(lines: readonly DiffLine[], context: number): DiffHunk[] {
  const interesting = lines
    .map((line, index) => (line.op === 'equal' ? -1 : index))
    .filter((index) => index >= 0)

  if (interesting.length === 0) return []

  const hunks: DiffHunk[] = []
  let start = Math.max(0, interesting[0]! - context)
  let end = Math.min(lines.length - 1, interesting[0]! + context)

  for (const index of interesting.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(lines.length - 1, index + context)
      continue
    }

    hunks.push(toHunk(lines.slice(start, end + 1)))
    start = Math.max(0, index - context)
    end = Math.min(lines.length - 1, index + context)
  }

  hunks.push(toHunk(lines.slice(start, end + 1)))
  return hunks
}

function toHunk(lines: readonly DiffLine[]): DiffHunk {
  const beforeNumbers = lines.map((line) => line.before).filter((n): n is number => n !== null)
  const afterNumbers = lines.map((line) => line.after).filter((n): n is number => n !== null)

  return {
    beforeStart: beforeNumbers[0] ?? 0,
    beforeCount: beforeNumbers.length,
    afterStart: afterNumbers[0] ?? 0,
    afterCount: afterNumbers.length,
    lines,
  }
}

export interface DiffOptions {
  /** Unchanged lines kept either side of a change. */
  readonly context?: number
}

export function diffText(before: string, after: string, options: DiffOptions = {}): Diff {
  const context = options.context ?? 3

  if (before === after) {
    return { hunks: [], added: 0, removed: 0, identical: true, truncated: false }
  }

  const beforeLines = split(before)
  const afterLines = split(after)

  if (beforeLines.length > MAX_LINES || afterLines.length > MAX_LINES) {
    const lines: DiffLine[] = [
      ...beforeLines.map(
        (text, index): DiffLine => ({ op: 'remove', text, before: index + 1, after: null }),
      ),
      ...afterLines.map(
        (text, index): DiffLine => ({ op: 'add', text, before: null, after: index + 1 }),
      ),
    ]

    return {
      hunks: toHunks(lines, context),
      added: afterLines.length,
      removed: beforeLines.length,
      identical: false,
      truncated: true,
    }
  }

  // Common prefix and suffix first: an edit to one paragraph of a long note
  // then leaves almost nothing for the quadratic part.
  let head = 0
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1
  }

  let tail = 0
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1
  }

  const middle = walk(
    beforeLines.slice(head, beforeLines.length - tail),
    afterLines.slice(head, afterLines.length - tail),
    head,
  )

  const lines: DiffLine[] = [
    ...beforeLines.slice(0, head).map(
      (text, index): DiffLine => ({ op: 'equal', text, before: index + 1, after: index + 1 }),
    ),
    ...middle,
    ...beforeLines.slice(beforeLines.length - tail).map(
      (text, index): DiffLine => ({
        op: 'equal',
        text,
        before: beforeLines.length - tail + index + 1,
        after: afterLines.length - tail + index + 1,
      }),
    ),
  ]

  return {
    hunks: toHunks(lines, context),
    added: lines.filter((line) => line.op === 'add').length,
    removed: lines.filter((line) => line.op === 'remove').length,
    identical: false,
    truncated: false,
  }
}

/** The diff as text, in the shape `diff -u` writes it. */
export function formatDiff(diff: Diff): string {
  const out: string[] = []

  for (const hunk of diff.hunks) {
    out.push(
      `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`,
    )

    for (const line of hunk.lines) {
      out.push(`${line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' '}${line.text}`)
    }
  }

  return out.join('\n')
}
