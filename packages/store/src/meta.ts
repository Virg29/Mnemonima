import { defaultProjectConfig } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { formatNoteId } from '@mnemonima/core'
import type { Db } from './db.js'

export const META = {
  PROJECT_NAME: 'project_name',
  ID_PREFIX: 'id_prefix',
  ID_COUNTER: 'id_counter',
  CONFIG: 'config',
  CREATED_AT: 'created_at',
} as const

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

export function getMetaNumber(db: Db, key: string, fallback: number): number {
  const raw = getMeta(db, key)
  if (raw === null) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Stored configuration is merged onto the defaults, so a key added in a later
 * release appears with its default value instead of `undefined`.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T))
  }

  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? deepMerge(base[key], value) : value
  }
  return result as T
}

export function getConfig(db: Db): ProjectConfig {
  const raw = getMeta(db, META.CONFIG)
  const defaults = defaultProjectConfig()
  if (raw === null) return defaults

  try {
    return deepMerge(defaults, JSON.parse(raw))
  } catch {
    // A corrupted config must not make the project unopenable.
    return defaults
  }
}

export function setConfig(db: Db, config: ProjectConfig): void {
  setMeta(db, META.CONFIG, JSON.stringify(config, null, 2))
}

/**
 * Allocates the next note id. The counter lives in `meta` and is incremented
 * inside a transaction, so concurrent writers cannot hand out the same id.
 */
export function nextNoteId(db: Db): string {
  const allocate = db.transaction((): string => {
    const prefix = getMeta(db, META.ID_PREFIX)
    if (prefix === null) {
      throw new Error('project is missing its id prefix: database is not initialised')
    }
    const next = getMetaNumber(db, META.ID_COUNTER, 0) + 1
    setMeta(db, META.ID_COUNTER, String(next))
    return formatNoteId(prefix, next)
  })
  return allocate()
}
