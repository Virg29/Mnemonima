import { describe, expect, it } from 'vitest'
import { parseLinks } from './links.js'

describe('parseLinks', () => {
  it('reads every wikilink form', () => {
    const links = parseLinks(
      [
        'See [[SL-0007]] and [[SL-0031 GPU pipeline]].',
        '',
        'Also [[SL-0042|shader basics]] and [[SL-0055#Uniforms]].',
      ].join('\n'),
    )

    expect(links.map((link) => link.target)).toEqual(['SL-0007', 'SL-0031 GPU pipeline', 'SL-0042', 'SL-0055'])
    expect(links[2]?.anchor).toBe('shader basics')
    expect(links[3]?.heading).toBe('Uniforms')
    expect(links.every((link) => link.kind === 'wikilink')).toBe(true)
  })

  it('combines a heading anchor with display text', () => {
    const [link] = parseLinks('[[SL-0042#Fragment stage|how it runs]]')

    expect(link?.target).toBe('SL-0042')
    expect(link?.heading).toBe('Fragment stage')
    expect(link?.anchor).toBe('how it runs')
  })

  it('reads plain markdown links and keeps their text as the anchor', () => {
    const [link] = parseLinks('[shader basics](./notes/SL-0042%20Shaders.md)')

    expect(link?.target).toBe('notes/SL-0042 Shaders')
    expect(link?.anchor).toBe('shader basics')
    expect(link?.kind).toBe('mdlink')
  })

  it('ignores external links', () => {
    expect(parseLinks('[docs](https://example.com/page) and [mail](mailto:a@b.c)')).toEqual([])
  })

  it('ignores wikilinks inside code, which are examples rather than links', () => {
    const source = [
      'Real link to [[SL-0007]].',
      '',
      '```md',
      'Write [[SL-9999]] to link a note.',
      '```',
      '',
      'Inline `[[SL-8888]]` too.',
    ].join('\n')

    expect(parseLinks(source).map((link) => link.target)).toEqual(['SL-0007'])
  })

  it('ignores a bare heading anchor, which points inside the same note', () => {
    expect(parseLinks('Jump to [[#Uniforms]].')).toEqual([])
  })

  it('de-duplicates repeats of the same target and anchor', () => {
    const links = parseLinks('[[SL-0007]] again [[SL-0007]] and [[SL-0007|other]]')

    expect(links).toHaveLength(2)
    expect(links[1]?.anchor).toBe('other')
  })

  it('returns nothing for a document without links', () => {
    expect(parseLinks('# Title\n\nJust prose, with [brackets] that are not links.')).toEqual([])
  })
})
