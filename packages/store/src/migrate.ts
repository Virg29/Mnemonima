import { MnemonimaError, EXIT } from '@mnemonima/core'
import type { Db } from './db.js'
import { MIGRATIONS } from './migrations/index.js'

export interface Migration {
  readonly version: number
  readonly name: string
  up(db: Db): void
}

export interface MigrationResult {
  readonly from: number
  readonly to: number
  readonly applied: readonly string[]
}

export function latestSchemaVersion(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0)
}

export function schemaVersion(db: Db): number {
  const value = db.pragma('user_version', { simple: true })
  return typeof value === 'number' ? value : 0
}

/**
 * Applies pending migrations. Forward-only: there are no down migrations, and a
 * database written by a newer build is refused rather than downgraded.
 */
export function migrate(db: Db): MigrationResult {
  const from = schemaVersion(db)
  const latest = latestSchemaVersion()

  if (from > latest) {
    throw new MnemonimaError(
      `database schema version ${from} is newer than this build supports (${latest})`,
      EXIT.BAD_REQUEST,
      {
        details: { found: from, supported: latest },
        hint: 'upgrade mnemonima, or open this project with the version that wrote it',
      },
    )
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version,
  )

  const applied: string[] = []

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db)
      // pragma cannot be parameterised
      db.pragma(`user_version = ${migration.version}`)
    })()
    applied.push(`${migration.version}-${migration.name}`)
  }

  return { from, to: schemaVersion(db), applied }
}
