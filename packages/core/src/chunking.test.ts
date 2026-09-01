import { describe, expect, it } from 'vitest'
import { ApproximateTokenCounter, chunkDocument, splitToWindows } from './chunking.js'
import { defaultProjectConfig } from './config.js'
import { parseMarkdown } from './markdown.js'

const counter = new ApproximateTokenCounter()

function config(overrides: Partial<ReturnType<typeof defaultProjectConfig>['chunking']> = {}) {
  return { ...defaultProjectConfig().chunking, ...overrides }
}

const DOC = `# Shaders

Intro paragraph about shaders and how the pipeline is arranged.

## Fragment stage

A fragment shader runs once per rasterized pixel and writes one colour.

Interpolated attributes arrive from the vertex stage.

## Depth test

Fragments can be discarded before shading when the depth test fails.
`

describe('chunkDocument', () => {
  it('produces both strategies from one document', () => {
    const chunks = chunkDocument(parseMarkdown(DOC).blocks, config(), counter)

    expect(chunks.some((chunk) => chunk.strategy === 'fine')).toBe(true)
    expect(chunks.some((chunk) => chunk.strategy === 'coarse')).toBe(true)
  })

  it('groups a whole section into one coarse chunk', () => {
    const chunks = chunkDocument(parseMarkdown(DOC).blocks, config(), counter)
    const coarse = chunks.filter((chunk) => chunk.strategy === 'coarse')

    const fragment = coarse.find((chunk) => chunk.headingPath === 'Shaders > Fragment stage')
    expect(fragment?.text).toContain('fragment shader runs')
    expect(fragment?.text).toContain('Interpolated attributes')
  })

  it('prepends the heading breadcrumb to the embedding text but not to the stored text', () => {
    const chunks = chunkDocument(parseMarkdown(DOC).blocks, config(), counter)
    const chunk = chunks.find((entry) => entry.headingPath === 'Shaders > Depth test')

    expect(chunk?.embedText.startsWith('Shaders > Depth test\n\n')).toBe(true)
    expect(chunk?.text.startsWith('Shaders >')).toBe(false)
  })

  it('does not prepend when the option is off', () => {
    const chunks = chunkDocument(
      parseMarkdown(DOC).blocks,
      config({ prependHeadings: false }),
      counter,
    )
    expect(chunks.every((chunk) => chunk.embedText === chunk.text)).toBe(true)
  })

  it('hashes the embedding text, so renaming a heading invalidates the chunk', () => {
    const before = chunkDocument(parseMarkdown(DOC).blocks, config(), counter)
    const after = chunkDocument(
      parseMarkdown(DOC.replace('## Depth test', '## Depth testing')).blocks,
      config(),
      counter,
    )

    const beforeHashes = new Set(before.map((chunk) => chunk.textHash))
    const renamed = after.find((chunk) => chunk.headingPath === 'Shaders > Depth testing')

    expect(renamed).toBeDefined()
    expect(beforeHashes.has(renamed!.textHash)).toBe(false)
  })

  it('reuses one hash when the fine and coarse cuts coincide', () => {
    const chunks = chunkDocument(parseMarkdown('# Tiny\n\nOne short line.').blocks, config(), counter)
    const hashes = new Set(chunks.map((chunk) => chunk.textHash))

    expect(chunks.length).toBeGreaterThan(1)
    expect(hashes.size).toBe(1)
  })

  it('excludes code when indexCode is false', () => {
    const source = '# Doc\n\nProse.\n\n```js\nconst secret = 1\n```\n'
    const withCode = chunkDocument(parseMarkdown(source).blocks, config(), counter)
    const withoutCode = chunkDocument(
      parseMarkdown(source).blocks,
      config({ indexCode: false }),
      counter,
    )

    expect(withCode.some((chunk) => chunk.text.includes('const secret'))).toBe(true)
    expect(withoutCode.some((chunk) => chunk.text.includes('const secret'))).toBe(false)
  })

  it('keeps every fine chunk inside the target window', () => {
    const long = `# Long\n\n${'A sentence about rasterization. '.repeat(400)}`
    const settings = config()
    const chunks = chunkDocument(parseMarkdown(long).blocks, settings, counter)

    for (const chunk of chunks.filter((entry) => entry.strategy === 'fine')) {
      expect(chunk.tokens).toBeLessThanOrEqual(settings.strategies.fine.targetTokens * 1.5)
    }
  })

  it('emits nothing for an empty document', () => {
    expect(chunkDocument(parseMarkdown('').blocks, config(), counter)).toEqual([])
  })
})

describe('splitToWindows', () => {
  const settings = { targetTokens: 20, overlap: 0, minTokens: 5 }

  it('returns the text untouched when it fits', () => {
    expect(splitToWindows('short text', settings, counter)).toEqual(['short text'])
  })

  it('splits on paragraph boundaries first', () => {
    const text = `${'a'.repeat(100)}\n\n${'b'.repeat(100)}`
    const pieces = splitToWindows(text, settings, counter)

    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces[0]).not.toContain('b')
  })

  it('repeats a tail between windows when overlap is set', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const withOverlap = splitToWindows(text, { ...settings, overlap: 0.25 }, counter)
    const without = splitToWindows(text, settings, counter)

    expect(withOverlap.length).toBe(without.length)
    expect(withOverlap[1]!.length).toBeGreaterThan(without[1]!.length)
  })

  it('falls back to a hard cut for text with no separators', () => {
    const pieces = splitToWindows('x'.repeat(500), settings, counter)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.join('')).toBe('x'.repeat(500))
  })
})
