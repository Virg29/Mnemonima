import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '@mnemonima/core'
import { openDatabase } from './db.js'
import type { Db } from './db.js'
import { migrate } from './migrate.js'
import { getConfig, getMeta, getMetaNumber, META, setConfig, setMeta } from './meta.js'
import { createSandbox } from './testing.js'
import type { Sandbox } from './testing.js'

describe('meta', () => {
  let sandbox: Sandbox
  let db: Db

  beforeEach(() => {
    sandbox = createSandbox()
    db = openDatabase(path.join(sandbox.projects, 'meta', 'mnemonima.db'))
    migrate(db)
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  it('reads and overwrites keys', () => {
    expect(getMeta(db, 'missing')).toBeNull()

    setMeta(db, META.ID_COUNTER, '7')
    expect(getMeta(db, META.ID_COUNTER)).toBe('7')

    setMeta(db, META.ID_COUNTER, '8')
    expect(getMetaNumber(db, META.ID_COUNTER, 0)).toBe(8)
  })

  it('falls back when a numeric key is absent or unparsable', () => {
    expect(getMetaNumber(db, 'missing', 42)).toBe(42)
    setMeta(db, 'broken', 'not-a-number')
    expect(getMetaNumber(db, 'broken', 42)).toBe(42)
  })

  it('returns defaults when no config is stored', () => {
    expect(getConfig(db)).toEqual(DEFAULT_PROJECT_CONFIG)
  })

  it('round-trips a config', () => {
    const config = getConfig(db)
    config.search.hybridWeights = { text: 0.3, vector: 0.7 }
    config.keywords.autoEnabled = false
    setConfig(db, config)

    const loaded = getConfig(db)
    expect(loaded.search.hybridWeights).toEqual({ text: 0.3, vector: 0.7 })
    expect(loaded.keywords.autoEnabled).toBe(false)
  })

  it('merges a partial config onto the defaults', () => {
    setMeta(db, META.CONFIG, JSON.stringify({ search: { hybridWeights: { text: 0.9 } } }))

    const loaded = getConfig(db)
    expect(loaded.search.hybridWeights.text).toBe(0.9)
    expect(loaded.search.hybridWeights.vector).toBe(
      DEFAULT_PROJECT_CONFIG.search.hybridWeights.vector,
    )
    expect(loaded.model.active).toBe(DEFAULT_PROJECT_CONFIG.model.active)
  })

  it('survives a corrupted config', () => {
    setMeta(db, META.CONFIG, '{ this is not json')
    expect(getConfig(db)).toEqual(DEFAULT_PROJECT_CONFIG)
  })
})
