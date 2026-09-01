import { describe, expect, it } from 'vitest'
import { BadRequestError } from './errors.js'
import { DEFAULT_PROJECT_CONFIG, defaultProjectConfig } from './config.js'
import {
  applyPatch,
  assertValue,
  coerce,
  flatten,
  knownPaths,
  readPath,
  requirePath,
  writePath,
} from './config-path.js'

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

describe('assertValue', () => {
  it('accepts a value of the type the setting has', () => {
    expect(assertValue('search.hybridWeights.text', 0.7)).toBe(0.7)
    expect(assertValue('keywords.autoEnabled', false)).toBe(false)
    expect(assertValue('model.active', 'Xenova/gte-base')).toBe('Xenova/gte-base')
  })

  it('refuses a value of the wrong type, naming both', () => {
    try {
      assertValue('search.limits.resultK', '10')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestError)
      expect((error as BadRequestError).message).toContain('number')
      expect((error as BadRequestError).message).toContain('string')
    }
  })

  it('refuses a group path, as `config set` does', () => {
    expect(() => assertValue('search.limits', { resultK: 10 })).toThrow(BadRequestError)
  })

  it('refuses an unknown path', () => {
    expect(() => assertValue('search.nonsense', 1)).toThrow(BadRequestError)
  })

  it('refuses a number that is not finite', () => {
    // JSON cannot carry NaN, but a caller building the body in JS can.
    expect(() => assertValue('search.hybridWeights.text', Number.NaN)).toThrow(BadRequestError)
  })
})

describe('applyPatch', () => {
  it('changes only what the patch names', () => {
    const config = defaultProjectConfig()
    const next = applyPatch(config, { 'search.hybridWeights.text': 0.8 })

    expect(next.search.hybridWeights.text).toBe(0.8)
    expect(next.search.hybridWeights.vector).toBe(config.search.hybridWeights.vector)
    expect(next.search.limits.resultK).toBe(config.search.limits.resultK)
  })

  it('leaves the original untouched, so an override is not a save', () => {
    const config = defaultProjectConfig()
    applyPatch(config, { 'search.hybridWeights.text': 0.8 })

    expect(config.search.hybridWeights.text).toBe(DEFAULT_PROJECT_CONFIG.search.hybridWeights.text)
  })

  it('applies several paths at once', () => {
    const next = applyPatch(defaultProjectConfig(), {
      'search.fusion.chunk': 0.9,
      'search.graph.boost': 0,
      'keywords.autoWeight': 0.5,
    })

    expect(next.search.fusion.chunk).toBe(0.9)
    expect(next.search.graph.boost).toBe(0)
    expect(next.keywords.autoWeight).toBe(0.5)
  })

  it('applies nothing when one path in the patch is bad', () => {
    const config = defaultProjectConfig()

    expect(() =>
      applyPatch(config, { 'search.fusion.chunk': 0.9, 'search.fusion.nope': 1 }),
    ).toThrow(BadRequestError)
    expect(config.search.fusion.chunk).toBe(DEFAULT_PROJECT_CONFIG.search.fusion.chunk)
  })
})
