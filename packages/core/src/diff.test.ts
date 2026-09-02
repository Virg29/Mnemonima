import { describe, expect, it } from 'vitest'
import { diffText, formatDiff } from './diff.js'

const lines = (...values: string[]) => values.join('\n')

describe('diffing two bodies', () => {
  it('says nothing changed when nothing changed', () => {
    const diff = diffText('# Shaders\n\nA body.', '# Shaders\n\nA body.')

    expect(diff.identical).toBe(true)
    expect(diff.hunks).toEqual([])
    expect(diff.added + diff.removed).toBe(0)
  })

  it('finds an added line', () => {
    const diff = diffText(lines('one', 'three'), lines('one', 'two', 'three'))

    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(0)
    expect(diff.hunks[0]?.lines.map((line) => `${line.op}:${line.text}`)).toEqual([
      'equal:one',
      'add:two',
      'equal:three',
    ])
  })

  it('finds a removed line', () => {
    const diff = diffText(lines('one', 'two', 'three'), lines('one', 'three'))

    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(0)
  })

  it('reads a replacement as one line out and one in', () => {
    const diff = diffText(lines('one', 'two', 'three'), lines('one', 'TWO', 'three'))

    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })

  it('numbers the lines on the side they belong to', () => {
    const diff = diffText(lines('a', 'b'), lines('a', 'x', 'b'))
    const added = diff.hunks[0]?.lines.find((line) => line.op === 'add')

    // An addition has no line in the old body, and that is what makes it an
    // addition rather than an edit.
    expect(added?.before).toBeNull()
    expect(added?.after).toBe(2)
  })

  it('keeps unchanged lines around a change and drops the rest', () => {
    const before = lines(...Array.from({ length: 40 }, (_, index) => `line ${index}`))
    const after = before.replace('line 20', 'line twenty')

    const diff = diffText(before, after, { context: 2 })

    expect(diff.hunks).toHaveLength(1)
    // Two either side, plus the line out and the line in.
    expect(diff.hunks[0]?.lines).toHaveLength(6)
  })

  it('separates two changes that are far apart', () => {
    const before = lines(...Array.from({ length: 40 }, (_, index) => `line ${index}`))
    const after = before.replace('line 2\n', 'line two\n').replace('line 30', 'line thirty')

    expect(diffText(before, after, { context: 2 }).hunks).toHaveLength(2)
  })

  it('joins two changes that are close enough to share context', () => {
    const before = lines('a', 'b', 'c', 'd', 'e')
    const after = lines('a', 'B', 'c', 'D', 'e')

    expect(diffText(before, after, { context: 3 }).hunks).toHaveLength(1)
  })

  it('treats CRLF as the same text as LF', () => {
    // A body exported to a file, edited on Windows and imported back is not a
    // change. Comparing the raw strings said otherwise and produced an empty
    // diff that still reported itself as a difference: `+0 -0`, nothing under it.
    const diff = diffText('one\r\ntwo\r\n', 'one\ntwo\n')

    expect(diff.identical).toBe(true)
    expect(diff.hunks).toEqual([])
  })

  it('says so rather than freezing on a body too large to compare', () => {
    const huge = Array.from({ length: 4100 }, (_, index) => `line ${index}`).join('\n')

    const diff = diffText(huge, `${huge}\nand one more`)

    expect(diff.truncated).toBe(true)
    expect(diff.identical).toBe(false)
    // And no hunks. Returning a line for every line of both bodies made the
    // guard against a frozen page produce twice an ordinary diff.
    expect(diff.hunks).toEqual([])
  })

  it('refuses a comparison whose table would be enormous, not merely a long one', () => {
    // The line cap bounds the wrong thing: it is the *product* that gets
    // allocated. Two 1500-line bodies sharing nothing are 2.25 million cells,
    // which a cap of 4000 lines a side waves straight through.
    const left = Array.from({ length: 1500 }, (_, index) => `left ${index}`).join('\n')
    const right = Array.from({ length: 1500 }, (_, index) => `right ${index}`).join('\n')

    expect(diffText(left, right).truncated).toBe(true)
  })

  it('still compares a long body with one edited paragraph', () => {
    // Because the guard measures what is left once the common ends are
    // stripped, length alone is not what makes a comparison too large.
    const long = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join('\n')
    const edited = long.replace('line 1500\n', 'line fifteen hundred\n')

    const diff = diffText(long, edited)

    expect(diff.truncated).toBe(false)
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })

  it('writes the hunks the way `diff -u` does', () => {
    const text = formatDiff(diffText(lines('one', 'three'), lines('one', 'two', 'three')))

    expect(text).toContain('@@ -1,2 +1,3 @@')
    expect(text).toContain('+two')
    expect(text).toContain(' one')
  })
})
