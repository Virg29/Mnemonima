import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

export interface OpenOptions {
  /** Fail instead of creating a new database file. */
  readonly mustExist?: boolean
}

export function openDatabase(file: string, options: OpenOptions = {}): Db {
  if (options.mustExist !== true) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }

  const db = new Database(file, { fileMustExist: options.mustExist === true })

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')

  return db
}

export function databaseExists(file: string): boolean {
  return fs.existsSync(file)
}
