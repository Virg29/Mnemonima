import { describe, expect, it } from 'vitest'
import { BadRequestError, defaultProjectConfig } from '@mnemonima/core'
import { coerce, flatten, knownPaths, readPath, requirePath, writePath } from './config-path.js'

describe('requirePath', () => {
  it('accepts a leaf', () => {
    expect(requirePath('model.active')).toBe(defaultProjectConfig().model.active)
    expect(requirePath('search.limits.resultK')).toBe(10)
    expect(requirePath('keywords.autoEnabled')).toBe(true)
  })

  it('rejects a path that names a whole section', () => {
    // Writing a scalar here would leave every setting under it undefined, and
    // the merge in getConfig would preserve the damage on every later read.
    for (const section of ['search', 'search.limits', 'chunking.strategies.fine']) {
      try {
        requirePath(section)
        expect.unreachable(`should have rejected "${section}"`)
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestError)
        expect((error as BadRequestError).message).toContain('group of settings')
        expect((error as BadRequestError).hint).toContain(`${section}.`)
      }
    }
  })

  it('rejects an unknown key and suggests neighbours', () => {
    try {
      requirePath('serch.limits.resultK')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).hint).toBeDefined()
    }
  })

  it('every leaf reported by knownPaths is settable', () => {
    for (const path of knownPaths()) {
      expect(() => requirePath(path)).not.toThrow()
    }
  })
})

describe('coerce', () => {
  it('keeps the type of the existing value', () => {
    expect(coerce('search.limits.resultK', '20', 10)).toBe(20)
    expect(coerce('keywords.autoEnabled', 'false', true)).toBe(false)
    expect(coerce('model.active', 'Xenova/gte-base', 'Supabase/gte-small')).toBe('Xenova/gte-base')
  })

  it('accepts fractional numbers', () => {
    expect(coerce('search.limits.minSimilarity', '0.42', 0.25)).toBeCloseTo(0.42)
  })

  it('rejects a non-number for a numeric setting', () => {
    expect(() => coerce('search.limits.resultK', 'notanumber', 10)).toThrow(BadRequestError)
  })

  it('rejects anything but true or false for a boolean', () => {
    expect(() => coerce('keywords.autoEnabled', 'yes', true)).toThrow(BadRequestError)
  })
})

describe('flatten, readPath and writePath', () => {
  it('round-trips a value through a dotted path', () => {
    const config = defaultProjectConfig() as unknown as Record<string, unknown>
    writePath(config, ['search', 'limits', 'resultK'], 42)

    expect(readPath(config, ['search', 'limits', 'resultK'])).toBe(42)
  })

  it('flattens only to leaves', () => {
    const flat = flatten(defaultProjectConfig()).map(([key]) => key)

    expect(flat).toContain('search.limits.resultK')
    expect(flat).not.toContain('search.limits')
    expect(flat).not.toContain('search')
  })

  it('returns undefined for a path that does not exist', () => {
    expect(readPath(defaultProjectConfig(), ['nope', 'missing'])).toBeUndefined()
  })
})
