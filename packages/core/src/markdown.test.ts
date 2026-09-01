import { describe, expect, it } from 'vitest'
import { formatHeadingPath, parseMarkdown, renderOutline, stripCode } from './markdown.js'

const DOC = `# Shaders introduction

A fragment shader runs once per rasterized pixel.

## Fragment stage

Interpolated attributes arrive here.

- uniforms are constant per draw call
- varyings are interpolated per pixel

\`\`\`glsl
void main() { gl_FragColor = vec4(1.0); }
\`\`\`

## Depth test

Fragments can be discarded before shading.
`

describe('parseMarkdown', () => {
  it('takes the title from the first level-one heading', () => {
    expect(parseMarkdown(DOC).title).toBe('Shaders introduction')
  })

  it('returns null title when the document has no h1', () => {
    expect(parseMarkdown('## Only a subheading\n\ntext').title).toBeNull()
  })

  it('attaches the heading breadcrumb to every block', () => {
    const { blocks } = parseMarkdown(DOC)

    const intro = blocks.find((block) => block.text.startsWith('A fragment shader'))
    expect(intro?.headingPath).toEqual(['Shaders introduction'])

    const interpolated = blocks.find((block) => block.text.startsWith('Interpolated'))
    expect(interpolated?.headingPath).toEqual(['Shaders introduction', 'Fragment stage'])
  })

  it('marks fenced code as code and keeps its language', () => {
    const code = parseMarkdown(DOC).blocks.filter((block) => block.kind === 'code')
    expect(code).toHaveLength(1)
    expect(code[0]?.lang).toBe('glsl')
    expect(code[0]?.text).toContain('gl_FragColor')
  })

  it('expands a list into one block per item', () => {
    const items = parseMarkdown(DOC).blocks.filter((block) => block.text.startsWith('- '))
    expect(items).toHaveLength(2)
    expect(items[1]?.text).toContain('varyings')
  })

  it('keeps the original markdown of a block, not a flattened rendering', () => {
    const blocks = parseMarkdown('Text with **bold** and `code`.').blocks
    expect(blocks[0]?.text).toBe('Text with **bold** and `code`.')
  })

  it('leaves a shallower heading level in place when depths are skipped', () => {
    const { blocks } = parseMarkdown('# One\n\n### Three\n\nbody')
    expect(blocks[0]?.headingPath).toEqual(['One', 'Three'])
  })

  it('drops a heading when a sibling replaces it', () => {
    const { blocks } = parseMarkdown('# A\n\n## B\n\nfirst\n\n## C\n\nsecond')
    const second = blocks.find((block) => block.text === 'second')
    expect(second?.headingPath).toEqual(['A', 'C'])
  })

  it('ignores empty documents', () => {
    const parsed = parseMarkdown('   \n\n  ')
    expect(parsed.blocks).toEqual([])
    expect(parsed.outline).toBeNull()
  })
})

describe('renderOutline', () => {
  it('numbers and indents by normalised depth', () => {
    expect(parseMarkdown(DOC).outline).toBe(
      ['1. Shaders introduction', '  1.1. Fragment stage', '  1.2. Depth test'].join('\n'),
    )
  })

  it('does not indent a document that starts at h2', () => {
    expect(renderOutline([{ depth: 2, text: 'A' }, { depth: 2, text: 'B' }])).toBe('1. A\n2. B')
  })

  it('returns null with no headings', () => {
    expect(renderOutline([])).toBeNull()
  })
})

describe('stripCode', () => {
  it('removes fenced blocks and inline code', () => {
    const stripped = stripCode('before\n\n```js\nconst x = "text"\n```\n\nafter `inline` end')
    expect(stripped).not.toContain('const x')
    expect(stripped).not.toContain('inline')
    expect(stripped).toContain('before')
    expect(stripped).toContain('after')
  })
})

describe('formatHeadingPath', () => {
  it('joins with a separator and drops blanks', () => {
    expect(formatHeadingPath(['Shaders', 'Fragment stage'])).toBe('Shaders > Fragment stage')
    expect(formatHeadingPath(['', 'Only'])).toBe('Only')
    expect(formatHeadingPath([])).toBeNull()
  })
})
