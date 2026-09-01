import { hashObject } from '@mnemonima/core'
import type { Db } from './db.js'

/**
 * Orama snapshots — DESIGN.md 4.1.
 *
 * Rebuilding both indexes from SQLite is the cost the CLI pays on every
 * invocation. The daemon pays it once, then stores the built index so a cold
 * start after eviction or restart is a restore rather than a rebuild.
 *
 * A snapshot is only ever a cache. It is keyed by the embedding space and
 * validated against a fingerprint of the data it was built from, so a stale one
 * is discarded rather than served: there is no way to forget to invalidate it,
 * because nothing invalidates it — the fingerprint simply stops matching.
 */

export type SnapshotKind = 'notes' | 'chunks'

export interface Snapshot {
  readonly spaceId: string
  readonly kind: SnapshotKind
  readonly indexVersion: string
  readonly blob: Uint8Array
  readonly createdAt: number
}

/**
 * Everything that would make a built index wrong if it changed.
 *
 * Counts and the latest timestamp rather than a content hash: reading every row
 * to validate a cache would cost what the cache saves.
 */
export function dataFingerprint(db: Db, spaceId: string): string {
  const scalar = (sql: string, ...params: unknown[]): number => {
    const row = db.prepare(sql).get(...params) as { value: number | null }
    return row.value ?? 0
  }

  return hashObject({
    notes: scalar("SELECT COUNT(*) AS value FROM notes WHERE status = 'active'"),
    notesUpdated: scalar("SELECT MAX(updated_at) AS value FROM notes WHERE status = 'active'"),
    chunks: scalar('SELECT COUNT(*) AS value FROM chunks WHERE space_id = ?', spaceId),
    embeddings: scalar('SELECT COUNT(*) AS value FROM embeddings WHERE space_id = ?', spaceId),
    aliases: scalar('SELECT COUNT(*) AS value FROM aliases'),
    tags: scalar('SELECT COUNT(*) AS value FROM tags'),
    noteTerms: scalar('SELECT COUNT(*) AS value FROM note_terms'),
    links: scalar('SELECT COUNT(*) AS value FROM links'),
  })
}

export function saveSnapshot(
  db: Db,
  spaceId: string,
  kind: SnapshotKind,
  indexVersion: string,
  blob: Uint8Array,
): void {
  db.prepare(
    'INSERT INTO orama_snapshots (space_id, kind, index_version, blob, created_at)' +
      ' VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_id, kind) DO UPDATE SET' +
      ' index_version = excluded.index_version, blob = excluded.blob, created_at = excluded.created_at',
  ).run(spaceId, kind, indexVersion, Buffer.from(blob), Date.now())
}

/** Returns the snapshot only when it was built by this code from this data. */
export function loadSnapshot(
  db: Db,
  spaceId: string,
  kind: SnapshotKind,
  indexVersion: string,
): Snapshot | null {
  const row = db
    .prepare('SELECT * FROM orama_snapshots WHERE space_id = ? AND kind = ? AND index_version = ?')
    .get(spaceId, kind, indexVersion) as
    | {
        space_id: string
        kind: string
        index_version: string
        blob: Uint8Array
        created_at: number
      }
    | undefined

  if (row === undefined) return null

  return {
    spaceId: row.space_id,
    kind: row.kind as SnapshotKind,
    indexVersion: row.index_version,
    blob: row.blob,
    createdAt: row.created_at,
  }
}

export function clearSnapshots(db: Db, spaceId?: string): number {
  return spaceId === undefined
    ? db.prepare('DELETE FROM orama_snapshots').run().changes
    : db.prepare('DELETE FROM orama_snapshots WHERE space_id = ?').run(spaceId).changes
}

export interface SnapshotSummary {
  readonly spaceId: string
  readonly kind: SnapshotKind
  readonly bytes: number
  readonly createdAt: number
}

export function listSnapshots(db: Db): SnapshotSummary[] {
  const rows = db
    .prepare(
      'SELECT space_id, kind, LENGTH(blob) AS bytes, created_at FROM orama_snapshots' +
        ' ORDER BY space_id, kind',
    )
    .all() as { space_id: string; kind: string; bytes: number; created_at: number }[]

  return rows.map((row) => ({
    spaceId: row.space_id,
    kind: row.kind as SnapshotKind,
    bytes: row.bytes,
    createdAt: row.created_at,
  }))
}
