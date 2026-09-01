import type { ChunkStrategyConfig, ChunkingConfig } from './config.js'
import { hashText } from './hash.js'
import { formatHeadingPath } from './markdown.js'
import type { BlockKind, MarkdownBlock } from './markdown.js'
import type { ChunkStrategy } from './types.js'

/**
 * Multi-strategy chunking — DESIGN.md 6.2.
 *
 * One document is cut twice. `fine` chunks are paragraph-sized and catch
 * precise facts; `coarse` chunks are section-sized and catch the general sense
 * of a passage. Search runs over both levels and fuses per note, so the two
 * strategies complement rather than compete.
 *
 * Two invariants the rest of the pipeline relies on:
 *
 *  - `textHash` hashes `embedText`, which includes the heading breadcrumb.
 *    Renaming a heading therefore re-embeds the chunks under it, as it should.
 *  - Identical `embedText` in two strategies (a short note whose fine and
 *    coarse cuts coincide) produces one identical hash, so it is embedded and
 *    stored exactly once.
 *
 * Bumping CHUNKER_VERSION invalidates every embedding space, which is the
 * intended consequence of changing how text is cut.
 */
export const CHUNKER_VERSION = '1'

export interface TokenCounter {
  count(text: string): number
}

export interface ChunkSpec {
  readonly strategy: ChunkStrategy
  readonly ord: number
  readonly headingPath: string | null
  readonly kind: BlockKind
  /** Chunk content, without the breadcrumb. What a snippet shows. */
  readonly text: string
  /** What the embedder actually sees: breadcrumb plus content. */
  readonly embedText: string
  readonly textHash: string
  readonly tokens: number
}

/** Guards against pathological input that resists every separator. */
const MAX_SPLIT_DEPTH = 6

/**
 * Approximate token counter used when no model tokenizer is available. Four
 * characters per token is the usual rule of thumb for English; it is good
 * enough for tests and for `--dry-run`, never for real indexing.
 */
export class ApproximateTokenCounter implements TokenCounter {
  count(text: string): number {
    return Math.max(1, Math.ceil(text.trim().length / 4))
  }
}

/** Wraps a counter with a cache: chunking asks about the same text repeatedly. */
export class CachingTokenCounter implements TokenCounter {
  readonly #inner: TokenCounter
  readonly #cache = new Map<string, number>()

  constructor(inner: TokenCounter) {
    this.#inner = inner
  }

  count(text: string): number {
    const cached = this.#cache.get(text)
    if (cached !== undefined) return cached

    const value = this.#inner.count(text)
    // Long strings are asked about once; caching them only grows the map.
    if (text.length <= 4096) this.#cache.set(text, value)
    return value
  }
}

export function chunkDocument(
  blocks: readonly MarkdownBlock[],
  config: ChunkingConfig,
  counter: TokenCounter,
): ChunkSpec[] {
  const usable = config.indexCode ? blocks : blocks.filter((block) => block.kind !== 'code')
  const cache = counter instanceof CachingTokenCounter ? counter : new CachingTokenCounter(counter)

  return [
    ...chunkFine(usable, config, cache),
    ...chunkCoarse(usable, config, cache),
  ]
}

/** Paragraph-level: merge neighbours up to the target, split anything oversized. */
function chunkFine(
  blocks: readonly MarkdownBlock[],
  config: ChunkingConfig,
  counter: TokenCounter,
): ChunkSpec[] {
  const settings = config.strategies.fine
  const specs: ChunkSpec[] = []
  let pending: MarkdownBlock[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    const first = pending[0]!
    const text = pending.map((block) => block.text).join('\n\n')

    for (const piece of splitToWindows(text, settings, counter)) {
      specs.push(makeSpec('fine', specs.length, first.headingPath, first.kind, piece, config, counter))
    }
    pending = []
  }

  for (const block of blocks) {
    const head = pending[0]
    const sameGroup =
      head !== undefined &&
      head.kind === block.kind &&
      formatHeadingPath(head.headingPath) === formatHeadingPath(block.headingPath)

    if (!sameGroup) {
      flush()
      pending = [block]
      continue
    }

    const merged = [...pending, block]
    const tokens = counter.count(merged.map((item) => item.text).join('\n\n'))
    const pendingTokens = counter.count(pending.map((item) => item.text).join('\n\n'))

    // Keep merging while the group is below the minimum, or while the result
    // still fits the target window. A single-line block on its own is noise.
    if (pendingTokens < settings.minTokens || tokens <= settings.targetTokens) {
      pending = merged
    } else {
      flush()
      pending = [block]
    }
  }

  flush()
  return specs
}

/** Section-level: everything under one heading path, windowed with overlap. */
function chunkCoarse(
  blocks: readonly MarkdownBlock[],
  config: ChunkingConfig,
  counter: TokenCounter,
): ChunkSpec[] {
  const settings = config.strategies.coarse
  const specs: ChunkSpec[] = []
  let pending: MarkdownBlock[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    const first = pending[0]!
    const text = pending.map((block) => block.text).join('\n\n')
    const kind = pending.every((block) => block.kind === 'code') ? 'code' : 'prose'

    for (const piece of splitToWindows(text, settings, counter)) {
      specs.push(makeSpec('coarse', specs.length, first.headingPath, kind, piece, config, counter))
    }
    pending = []
  }

  for (const block of blocks) {
    const head = pending[0]
    if (head !== undefined && formatHeadingPath(head.headingPath) !== formatHeadingPath(block.headingPath)) {
      flush()
    }
    pending.push(block)
  }

  flush()
  return specs
}

function makeSpec(
  strategy: ChunkStrategy,
  ord: number,
  headingPath: readonly string[],
  kind: BlockKind,
  text: string,
  config: ChunkingConfig,
  counter: TokenCounter,
): ChunkSpec {
  const breadcrumb = formatHeadingPath(headingPath)
  const embedText =
    config.prependHeadings && breadcrumb !== null ? `${breadcrumb}\n\n${text}` : text

  return {
    strategy,
    ord,
    headingPath: breadcrumb,
    kind,
    text,
    embedText,
    textHash: hashText(embedText),
    tokens: counter.count(embedText),
  }
}

/**
 * Cuts text into windows of at most `targetTokens`, repeating an `overlap`
 * fraction of the previous window at the start of the next one.
 */
export function splitToWindows(
  text: string,
  settings: ChunkStrategyConfig,
  counter: TokenCounter,
): string[] {
  const pieces = splitText(text, settings.targetTokens, counter, 0)
  if (settings.overlap <= 0 || pieces.length < 2) return pieces

  const overlapTokens = Math.max(1, Math.round(settings.targetTokens * settings.overlap))

  return pieces.map((piece, index) => {
    if (index === 0) return piece
    const tail = takeTail(pieces[index - 1] ?? '', overlapTokens, counter)
    return tail === '' ? piece : `${tail}\n\n${piece}`
  })
}

const SEPARATORS = ['\n\n', '\n', '. ', ' '] as const

function splitText(
  text: string,
  maxTokens: number,
  counter: TokenCounter,
  depth: number,
): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (counter.count(trimmed) <= maxTokens) return [trimmed]

  if (depth < MAX_SPLIT_DEPTH) {
    for (const separator of SEPARATORS) {
      const parts = trimmed.split(separator)
      if (parts.length < 2) continue

      const packed = packGreedily(parts, separator, maxTokens, counter)
      return packed.flatMap((piece) =>
        counter.count(piece) > maxTokens ? splitText(piece, maxTokens, counter, depth + 1) : [piece],
      )
    }
  }

  return hardCut(trimmed, maxTokens, counter)
}

function packGreedily(
  parts: readonly string[],
  separator: string,
  maxTokens: number,
  counter: TokenCounter,
): string[] {
  const out: string[] = []
  let buffer = ''

  for (const part of parts) {
    const candidate = buffer === '' ? part : buffer + separator + part
    if (buffer !== '' && counter.count(candidate) > maxTokens) {
      out.push(buffer)
      buffer = part
    } else {
      buffer = candidate
    }
  }

  if (buffer.trim() !== '') out.push(buffer)
  return out.map((piece) => piece.trim()).filter((piece) => piece !== '')
}

/** Last resort for text with no usable separator, e.g. one enormous token run. */
function hardCut(text: string, maxTokens: number, counter: TokenCounter): string[] {
  const tokens = counter.count(text)
  const charsPerToken = Math.max(1, Math.floor(text.length / Math.max(1, tokens)))
  const window = Math.max(1, maxTokens * charsPerToken)

  const out: string[] = []
  for (let i = 0; i < text.length; i += window) out.push(text.slice(i, i + window))
  return out
}

/** Trailing slice of `text` worth roughly `tokens` tokens, cut on a word boundary. */
function takeTail(text: string, tokens: number, counter: TokenCounter): string {
  const words = text.split(/\s+/).filter((word) => word !== '')
  let tail = ''

  for (let i = words.length - 1; i >= 0; i -= 1) {
    const candidate = tail === '' ? words[i]! : `${words[i]!} ${tail}`
    if (counter.count(candidate) > tokens) break
    tail = candidate
  }

  return tail
}
