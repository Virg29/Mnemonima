import { toString as mdastToString } from 'mdast-util-to-string'
import type { Heading, List, Root, RootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * Markdown parsing.
 *
 * Chunking works on an AST rather than on raw text so that we can tell prose
 * from code, keep the heading breadcrumb for every block, and never cut a chunk
 * through the middle of a table or a list (DESIGN.md 6.1).
 *
 * Block text is the *original source slice*, not a flattened rendering. Markup
 * costs the embedder almost nothing and it makes search snippets readable.
 */

export type BlockKind = 'prose' | 'code'

export interface MarkdownBlock {
  /** Position in document order, starting at 0. */
  readonly ord: number
  /** Enclosing headings, outermost first: `['Shaders', 'Fragment stage']`. */
  readonly headingPath: readonly string[]
  readonly kind: BlockKind
  readonly text: string
  /** Info string of a fenced code block, when present. */
  readonly lang: string | null
}

export interface HeadingEntry {
  readonly depth: number
  readonly text: string
}

export interface ParsedMarkdown {
  /** Text of the first level-one heading, when the document has one. */
  readonly title: string | null
  /**
   * The document with its markup removed, blocks separated by blank lines.
   *
   * Term extraction reads this rather than the source: a candidate should be
   * "Fragment stage", never "## Fragment stage", and a fenced listing should not
   * contribute its identifiers to the prose at all.
   */
  readonly plain: string
  /** Rendered table of contents, or null when the document has no headings. */
  readonly outline: string | null
  readonly headings: readonly HeadingEntry[]
  readonly blocks: readonly MarkdownBlock[]
}

const processor = unified().use(remarkParse).use(remarkGfm)

/**
 * Parses once. Callers that need both blocks and links pass the result to both
 * so the document is not walked through remark twice.
 */
export function parseTree(source: string): Root {
  return processor.parse(source) as Root
}

export function parseMarkdown(source: string, parsed?: Root): ParsedMarkdown {
  const tree = parsed ?? parseTree(source)

  const headings: HeadingEntry[] = []
  const blocks: MarkdownBlock[] = []
  const plain: string[] = []
  const stack: string[] = []
  let title: string | null = null

  const slice = (node: RootContent): string => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return mdastToString(node)
    return source.slice(start, end).trim()
  }

  const push = (node: RootContent, kind: BlockKind, lang: string | null): void => {
    const text = slice(node)
    if (text === '') return
    blocks.push({ ord: blocks.length, headingPath: [...stack], kind, text, lang })
  }

  for (const node of tree.children) {
    switch (node.type) {
      case 'heading': {
        const heading = node as Heading
        const text = mdastToString(heading).trim()
        if (text === '') break

        headings.push({ depth: heading.depth, text })
        plain.push(text)
        if (title === null && heading.depth === 1) title = text

        stack.length = Math.min(stack.length, heading.depth - 1)
        stack[heading.depth - 1] = text
        // A skipped level (h1 then h3) leaves a hole; drop it rather than
        // emitting `undefined` into a breadcrumb.
        for (let i = 0; i < stack.length; i += 1) stack[i] ??= ''
        break
      }

      case 'code':
        push(node, 'code', node.lang ?? null)
        break

      case 'html':
        break

      case 'list':
        // A list item is the natural unit for the fine chunker, so lists are
        // expanded rather than kept whole.
        for (const item of (node as List).children) {
          push(item as unknown as RootContent, 'prose', null)
          const flattened = mdastToString(item).trim()
          if (flattened !== '') plain.push(flattened)
        }
        break

      case 'thematicBreak':
      case 'definition':
        break

      default: {
        push(node, 'prose', null)
        const flattened = mdastToString(node).trim()
        if (flattened !== '') plain.push(flattened)
        break
      }
    }
  }

  return {
    title,
    plain: plain.join('\n\n'),
    outline: renderOutline(headings),
    headings,
    blocks: blocks.map((block) => ({
      ...block,
      headingPath: block.headingPath.filter((entry) => entry !== ''),
    })),
  }
}

/**
 * Renders headings as a numbered, indented table of contents. Depths are
 * normalised first, so a document that starts at `##` is not indented by a
 * level that does not exist.
 */
export function renderOutline(headings: readonly HeadingEntry[]): string | null {
  if (headings.length === 0) return null

  const depths = [...new Set(headings.map((heading) => heading.depth))].sort((a, b) => a - b)
  const level = new Map(depths.map((depth, index) => [depth, index]))
  const counters: number[] = []

  const lines = headings.map((heading) => {
    const index = level.get(heading.depth) ?? 0
    counters.length = index + 1
    counters[index] = (counters[index] ?? 0) + 1
    for (let i = 0; i < index; i += 1) counters[i] ??= 1

    const number = counters.slice(0, index + 1).join('.')
    return `${'  '.repeat(index)}${number}. ${heading.text}`
  })

  return lines.join('\n')
}

/**
 * Strips fenced and inline code so the language gate can ignore string literals
 * (DESIGN.md 11, layer 3).
 */
export function stripCode(source: string): string {
  return source
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^~~~[\s\S]*?^~~~/gm, '')
    .replace(/`[^`\n]*`/g, '')
}

/**
 * Drops fenced blocks but keeps inline code.
 *
 * Term extraction wants it this way round: a fenced block is a listing whose
 * identifiers would swamp the prose, while inline code is usually the API name
 * the sentence is about — exactly the term worth keeping.
 */
export function stripFencedCode(source: string): string {
  return source.replace(/^```[\s\S]*?^```/gm, '').replace(/^~~~[\s\S]*?^~~~/gm, '')
}

/** Bold, italic and inline code: the words the author marked as load-bearing. */
export function extractEmphasised(source: string): string[] {
  const found: string[] = []

  for (const pattern of [/\*\*([^*\n]+)\*\*/g, /`([^`\n]+)`/g]) {
    for (const match of source.matchAll(pattern)) {
      const value = (match[1] ?? '').trim()
      if (value !== '' && value.length < 60) found.push(value)
    }
  }

  return found
}

/** `['Shaders', 'Fragment stage']` -> `'Shaders > Fragment stage'`. */
export function formatHeadingPath(path: readonly string[]): string | null {
  const trimmed = path.filter((entry) => entry.trim() !== '')
  return trimmed.length === 0 ? null : trimmed.join(' > ')
}
