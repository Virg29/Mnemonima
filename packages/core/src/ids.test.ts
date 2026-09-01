import { describe, expect, it } from 'vitest'
import { BadRequestError } from './errors.js'
import { derivePrefix, formatNoteId, isNoteId, isValidPrefix, parseNoteId } from './ids.js'

describe('derivePrefix', () => {
  it('takes initials of a multi-word name', () => {
    expect(derivePrefix('Shader Lab')).toBe('SL')
    expect(derivePrefix('my knowledge base')).toBe('MKB')
  })

  it('caps initials at four characters', () => {
    expect(derivePrefix('one two three four five six')).toBe('OTTF')
  })

  it('falls back to the first three letters of a single word', () => {
    expect(derivePrefix('Shaders')).toBe('SHA')
    expect(derivePrefix('kb')).toBe('KB')
  })

  it('ignores punctuation and leading digits', () => {
    expect(derivePrefix('shader-lab (2026)')).toBe('SL')
  })

  it('rejects a name it cannot turn into a valid prefix', () => {
    expect(() => derivePrefix('a')).toThrow(BadRequestError)
    expect(() => derivePrefix('   ')).toThrow(BadRequestError)
    expect(() => derivePrefix('2026')).toThrow(BadRequestError)
  })
})

describe('isValidPrefix', () => {
  it('accepts two to four uppercase alphanumerics starting with a letter', () => {
    expect(isValidPrefix('SL')).toBe(true)
    expect(isValidPrefix('SHA')).toBe(true)
    expect(isValidPrefix('K9X2')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isValidPrefix('S')).toBe(false)
    expect(isValidPrefix('TOOLONG')).toBe(false)
    expect(isValidPrefix('sl')).toBe(false)
    expect(isValidPrefix('9SL')).toBe(false)
    expect(isValidPrefix('S-L')).toBe(false)
  })
})

describe('note ids', () => {
  it('formats with four-digit padding', () => {
    expect(formatNoteId('SL', 1)).toBe('SL-0001')
    expect(formatNoteId('SL', 42)).toBe('SL-0042')
  })

  it('grows past four digits without breaking the format', () => {
    expect(formatNoteId('SL', 12345)).toBe('SL-12345')
    expect(parseNoteId('SL-12345')).toEqual({ prefix: 'SL', seq: 12345 })
  })

  it('round-trips', () => {
    const id = formatNoteId('MKB', 7)
    expect(parseNoteId(id)).toEqual({ prefix: 'MKB', seq: 7 })
  })

  it('rejects non-positive sequences', () => {
    expect(() => formatNoteId('SL', 0)).toThrow(BadRequestError)
    expect(() => formatNoteId('SL', -1)).toThrow(BadRequestError)
    expect(() => formatNoteId('SL', 1.5)).toThrow(BadRequestError)
  })

  it('rejects malformed ids', () => {
    expect(parseNoteId('SL-1')).toBeNull()
    expect(parseNoteId('sl-0001')).toBeNull()
    expect(parseNoteId('SL0001')).toBeNull()
    expect(isNoteId('Shaders introduction')).toBe(false)
  })
})
