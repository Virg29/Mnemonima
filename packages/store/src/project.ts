import fs from 'node:fs'
import path from 'node:path'
import {
  assertEnglishScript,
  assertValidPrefix,
  BadRequestError,
  derivePrefix,
  NotFoundError,
} from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { databaseExists, openDatabase } from './db.js'
import type { Db } from './db.js'
import { getConfig, getMeta, META, setConfig, setMeta } from './meta.js'
import { getActiveSpace } from './spaces.js'
import { migrate } from './migrate.js'
import type { MigrationResult } from './migrate.js'
import { projectDbPath } from './paths.js'
import { removeEntry, requireEntry, upsertEntry, findEntry, loadRegistry } from './registry.js'
import type { RegistryEntry } from './registry.js'

export interface ProjectHandle {
  readonly name: string
  readonly dir: string
  readonly prefix: string
  readonly dbPath: string
  readonly db: Db
}

export interface CreateProjectOptions {
  readonly name: string
  readonly dir: string
  /** Derived from the project name when omitted. Immutable once set. */
  readonly prefix?: string | undefined
  /** Allow re-pointing an existing registry entry. */
  readonly force?: boolean | undefined
}

export interface CreateProjectResult extends ProjectHandle {
  /** False when an existing database in `dir` was adopted rather than created. */
  readonly created: boolean
  readonly migrations: MigrationResult
}

export interface ProjectStats {
  readonly notes: number
  readonly chunks: number
  readonly terms: number
  readonly activeSpace: string | null
}

function normaliseName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') {
    throw new BadRequestError('project name must not be empty')
  }
  assertEnglishScript(trimmed, 'project name')
  return trimmed
}

export function createProject(options: CreateProjectOptions): CreateProjectResult {
  // Everything that can reject the request is checked before any directory or
  // database file is created: a failed command must leave no artefacts behind.
  const name = normaliseName(options.name)
  const requested =
    options.prefix !== undefined && options.prefix !== ''
      ? assertValidPrefix(options.prefix.toUpperCase())
      : null

  const dir = path.resolve(options.dir)
  const dbPath = projectDbPath(dir)

  const registry = loadRegistry()

  // --force re-points *this* project. Letting it adopt a directory another
  // entry owns would leave two registry names sharing one database, with
  // `meta.project_name` silently rewritten to the newcomer.
  const owner = registry.projects.find(
    (entry) => path.resolve(entry.dir) === dir && entry.name !== findEntry(registry, name)?.name,
  )
  if (owner !== undefined) {
    throw new BadRequestError(
      `${dir} is already registered as project "${owner.name}"`,
      {
        details: { dir, owner: owner.name, requested: name },
        hint: `open it with -p "${owner.name}", or run \`mnemonima project remove "${owner.name}"\` first`,
      },
    )
  }

  const clash = findEntry(registry, name)
  if (clash !== null && options.force !== true) {
    throw new BadRequestError(
      `project "${clash.name}" already exists at ${clash.dir}`,
      {
        details: { name: clash.name, dir: clash.dir },
        hint: `re-point it with \`mnemonima project add "${clash.name}" --dir <path> --force\`, or choose another name`,
      },
    )
  }

  // Fail before touching the filesystem when no prefix can be derived either.
  if (requested === null && !databaseExists(dbPath)) derivePrefix(name)

  const existed = databaseExists(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  const db = openDatabase(dbPath)
  const migrations = migrate(db)

  const storedPrefix = getMeta(db, META.ID_PREFIX)

  // The prefix is baked into every note id, so it cannot change after the fact.
  if (storedPrefix !== null && requested !== null && requested !== storedPrefix) {
    db.close()
    throw new BadRequestError(
      `database at ${dbPath} already uses prefix "${storedPrefix}"; ` +
        `note ids are immutable, so the prefix cannot be changed to "${requested}"`,
      {
        details: { dbPath, storedPrefix, requested },
        hint: `drop --prefix to keep "${storedPrefix}", or create a separate project for the new prefix`,
      },
    )
  }

  const prefix = storedPrefix ?? requested ?? derivePrefix(name)
  const now = Date.now()

  db.transaction(() => {
    setMeta(db, META.PROJECT_NAME, name)
    setMeta(db, META.ID_PREFIX, prefix)
    if (getMeta(db, META.ID_COUNTER) === null) setMeta(db, META.ID_COUNTER, '0')
    if (getMeta(db, META.CREATED_AT) === null) setMeta(db, META.CREATED_AT, String(now))
    if (getMeta(db, META.CONFIG) === null) setConfig(db, getConfig(db))
  })()

  upsertEntry({
    name,
    dir,
    prefix,
    createdAt: Number(getMeta(db, META.CREATED_AT) ?? now),
  })

  return { name, dir, prefix, dbPath, db, created: !existed, migrations }
}

export function openProject(name: string): ProjectHandle {
  const entry = requireEntry(name)
  const dbPath = projectDbPath(entry.dir)

  if (!databaseExists(dbPath)) {
    throw new NotFoundError(
      `project "${entry.name}" is registered at ${entry.dir} but its database is missing`,
      {
        details: { name: entry.name, dbPath },
        hint: `restore ${dbPath}, or run \`mnemonima project remove "${entry.name}"\` and add it again`,
      },
    )
  }

  const db = openDatabase(dbPath, { mustExist: true })
  migrate(db)

  return {
    name: getMeta(db, META.PROJECT_NAME) ?? entry.name,
    dir: entry.dir,
    prefix: getMeta(db, META.ID_PREFIX) ?? entry.prefix,
    dbPath,
    db,
  }
}

export interface RemoveProjectOptions {
  /** Delete the database file as well as the registry entry. */
  readonly deleteData?: boolean | undefined
}

export interface RemoveProjectResult {
  readonly entry: RegistryEntry
  readonly deletedFiles: string[]
}

export function removeProject(
  name: string,
  options: RemoveProjectOptions = {},
): RemoveProjectResult {
  const entry = removeEntry(name)
  const deletedFiles: string[] = []

  if (options.deleteData === true) {
    const dbPath = projectDbPath(entry.dir)
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(file)) {
        fs.rmSync(file)
        deletedFiles.push(file)
      }
    }
  }

  return { entry, deletedFiles }
}

export function projectStats(db: Db): ProjectStats {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    return row.n
  }

  return {
    notes: count('notes'),
    chunks: count('chunks'),
    terms: count('terms'),
    activeSpace: getActiveSpace(db)?.id ?? null,
  }
}

export function projectConfig(db: Db): ProjectConfig {
  return getConfig(db)
}
