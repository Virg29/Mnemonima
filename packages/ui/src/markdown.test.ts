import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown.js'

/**
 * The preview renderer.
 *
 * It is the one place in the UI that produces markup from operator-authored
 * text, so the tests that matter here are the ones about what it refuses to
 * produce.
 */

describe('the preview renderer', () => {
  it('renders the constructs a note uses', () => {
    const html = renderMarkdown(
      ['# Title', '', 'A **bold** word and `code`.', '', '- one', '- two'].join('\n'),
    )

    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>one</li>')
  })

  it('escapes markup in the note body', () => {
    const html = renderMarkdown('A <script>alert(1)</script> in prose.')

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes inside a fenced block as well', () => {
    const html = renderMarkdown(['```html', '<img onerror="alert(1)">', '```'].join('\n'))

    expect(html).toContain('<pre><code>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('refuses a link scheme that is not http or our own hash', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')

    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('click')
  })

  it('keeps an http link and a hash link', () => {
    expect(renderMarkdown('[docs](https://example.com/x)')).toContain('href="https://example.com/x"')
    expect(renderMarkdown('[note](#note/SL-0001)')).toContain('href="#note/SL-0001"')
  })

  it('turns a wikilink into a link to the note, by id', () => {
    const html = renderMarkdown('See [[SL-0042 Shaders introduction]].')

    expect(html).toContain('href="#note/SL-0042"')
    expect(html).toContain('SL-0042 Shaders introduction')
  })

  it('takes the display text of a wikilink that has one', () => {
    const html = renderMarkdown('See [[SL-0042|shader basics]].')

    expect(html).toContain('href="#note/SL-0042"')
    expect(html).toContain('shader basics')
  })

  it('does not treat a construct inside a code span as a construct', () => {
    const html = renderMarkdown('Write `**not bold**` like this.')

    expect(html).toContain('<code>**not bold**</code>')
    expect(html).not.toContain('<strong>')
  })
})

describe('code spans and the text around them', () => {
  it('leaves a bare number in prose alone', () => {
    // An earlier version substituted a placeholder for each code span and
    // matched it back with a loose pattern, which swallowed any number.
    expect(renderMarkdown('Released in 2024 and revised later.')).toBe(
      '<p>Released in 2024 and revised later.</p>',
    )
  })

  it('handles several code spans in one line', () => {
    const html = renderMarkdown('Use `a` then `b`, not **`c`**.')

    expect(html).toContain('<code>a</code>')
    expect(html).toContain('<code>b</code>')
    expect(html).toContain('<code>c</code>')
  })

  it('leaves an unclosed backtick as text rather than swallowing the rest', () => {
    expect(renderMarkdown('A stray ` backtick.')).toContain('backtick')
  })
})
