import fs from 'node:fs'
import path from 'node:path'
import { BadRequestError, findBlockedScript, hashBody, stripCode } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { addAlias, adoptedByPath, listAliases, recordAdopted } from '@mnemonima/store'
import type { AdoptedRow, Db } from '@mnemonima/store'
import { normaliseSourcePath } from '@mnemonima/store'
import { writeNewNote, writeNoteBody } from './notes.js'

/**
 * Adopting a foreign vault — DESIGN.md 14.1.
 *
 * A directory of markdown that knows nothing about us: no ids, no frontmatter,
 * and links that point at filenames. This is not `import`, which reads our own
 * frontmatter and would be within its rights to refuse everything here.
 *
 * Four decisions, each of which is the difference between adopting a vault and
 * damaging one:
 *
 *  - **Nothing is interpreted.** Bodies are stored exactly as written, embeds,
 *    block references, Dataview queries and all. We do not support that syntax;
 *    we also do not get to delete it.
 *  - **The original name survives** as an alias, which is what makes
 *    `[text](aspects.md)` resolve afterwards and what stops a link from
 *    breaking because we renamed the world.
 *  - **A repeat run updates rather than duplicates**, matched on the source
 *    path — the only durable identity a foreign file has.
 *  - **A dry run is the default posture.** The report is the same either way,
 *    so what will happen can be read before it does.
 */

export type AdoptAction = 'created' | 'updated' | 'unchanged' | 'skipped'

export interface AdoptedFile {
  readonly sourcePath: string
  readonly action: AdoptAction
  readonly noteId: string | null
  readonly title: string
  /** Set when the file was skipped, saying which rule skipped it. */
  readonly reason: string | null
}

export interface AdoptReport {
  readonly root: string
  readonly dryRun: boolean
  readonly files: readonly AdoptedFile[]
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
  /** Basenames claimed by more than one file, which make a link ambiguous. */
  readonly collisions: readonly { readonly name: string; readonly paths: string[] }[]
}

export interface AdoptOptions {
  readonly dryRun?: boolean | undefined
  /** Bring in non-English files as archived notes instead of skipping them. */
  readonly importAnyway?: boolean | undefined
  readonly author?: string | undefined
  readonly batchId?: string | null | undefined
  /** Directory names never descended into. */
  readonly ignore?: readonly string[] | undefined
}

const DEFAULT_IGNORE = ['.git', '.mnemonima', 'node_modules', '.obsidian', '.trash']

/** Every markdown file under `root`, in a deterministic order. */
export function findMarkdown(root: string, ignore: readonly string[] = DEFAULT_IGNORE): string[] {
  const found: string[] = []
  const skip = new Set(ignore)

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    // Sorted, because ids are handed out in this order and a repeat run on
    // another machine has to produce the same ones.
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full)
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        found.push(full)
      }
    }
  }

  walk(root)
  return found
}

/** The first level-one heading, or the filename when there is none. */
function titleOf(body: string, file: string): string {
  const heading = /^#\s+(.+)$/m.exec(body)
  const fromHeading = heading?.[1]?.trim()

  return fromHeading !== undefined && fromHeading !== ''
    ? fromHeading
    : path.basename(file).replace(/\.(md|markdown)$/i, '')
}

/**
 * Basenames that more than one file claims.
 *
 * Reported rather than guessed at: two files called `README.md` in different
 * folders make `[text](README.md)` ambiguous, and picking one silently would
 * point half the links at the wrong note.
 */
function findCollisions(
  files: readonly string[],
  root: string,
): { name: string; paths: string[] }[] {
  const byName = new Map<string, string[]>()

  for (const file of files) {
    const name = path.basename(file).replace(/\.(md|markdown)$/i, '').toLowerCase()
    byName.set(name, [...(byName.get(name) ?? []), normaliseSourcePath(path.relative(root, file))])
  }

  return [...byName.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => ({ name, paths: paths.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function adoptVault(
  db: Db,
  config: ProjectConfig,
  root: string,
  options: AdoptOptions = {},
): AdoptReport {
  const resolved = path.resolve(root)

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new BadRequestError(`${resolved} is not a directory`, {
      details: { root: resolved },
      hint: 'point --dir at the folder that holds the markdown files',
    })
  }

  const dryRun = options.dryRun !== false
  const files = findMarkdown(resolved, options.ignore ?? DEFAULT_IGNORE)
  const known = adoptedByPath(db)

  const results: AdoptedFile[] = []

  for (const file of files) {
    const sourcePath = normaliseSourcePath(path.relative(resolved, file))
    const body = fs.readFileSync(file, 'utf8')
    const title = titleOf(body, file)

    // The gate is the same one every write path uses; only the response to it
    // differs, because a foreign vault is expected to contain other languages.
    const violation = findBlockedScript(
      config.language.gateCodeBlocks ? body : stripCode(body),
    )

    if (violation !== null && options.importAnyway !== true) {
      results.push({
        sourcePath,
        action: 'skipped',
        noteId: null,
        title,
        reason:
          `not English: ${violation.script} character "${violation.char}" at line ` +
          `${violation.position.line}`,
      })
      continue
    }

    const existing = known.get(sourcePath)

    if (existing !== undefined && existing.bodyHash === hashBody(body)) {
      results.push({ sourcePath, action: 'unchanged', noteId: existing.noteId, title, reason: null })
      continue
    }

    results.push({
      sourcePath,
      action: existing === undefined ? 'created' : 'updated',
      noteId: existing?.noteId ?? null,
      title,
      reason: null,
    })

    if (dryRun) continue

    // A copy with the gate off, not an option on the write path: `adopt` has
    // already decided what to do about the language, above, and the writer
    // should not decide it a second time on different evidence.
    const writeConfig: ProjectConfig =
      violation === null ? config : { ...config, language: { ...config.language, gate: 'off' } }

    const noteId = existing === undefined
      ? create(db, writeConfig, body, sourcePath, options)
      : update(db, writeConfig, existing, body, options)

    results[results.length - 1] = {
      ...results[results.length - 1]!,
      noteId,
    }
  }

  return {
    root: resolved,
    dryRun,
    files: results,
    created: results.filter((file) => file.action === 'created').length,
    updated: results.filter((file) => file.action === 'updated').length,
    unchanged: results.filter((file) => file.action === 'unchanged').length,
    skipped: results.filter((file) => file.action === 'skipped').length,
    collisions: findCollisions(files, resolved),
  }
}

function create(
  db: Db,
  config: ProjectConfig,
  body: string,
  sourcePath: string,
  options: AdoptOptions,
): string {
  const written = writeNewNote(db, config, body, {
    author: options.author ?? 'adopt',
    batchId: options.batchId ?? null,
  })

  recordAdopted(db, written.note.id, sourcePath, hashBody(body))
  rememberOriginalName(db, written.note.id, sourcePath)

  return written.note.id
}

function update(
  db: Db,
  config: ProjectConfig,
  existing: AdoptedRow,
  body: string,
  options: AdoptOptions,
): string {
  writeNoteBody(db, config, existing.noteId, body, {
    author: options.author ?? 'adopt',
    batchId: options.batchId ?? null,
  })

  recordAdopted(db, existing.noteId, existing.sourcePath, hashBody(body))
  rememberOriginalName(db, existing.noteId, existing.sourcePath)

  return existing.noteId
}

/**
 * The original basename becomes an alias.
 *
 * This is what makes `[text](aspects.md)` resolve after adoption, and what
 * keeps a search for the old name working. Added rather than replaced: an alias
 * the operator wrote is theirs.
 */
function rememberOriginalName(db: Db, noteId: string, sourcePath: string): void {
  const name = path.basename(sourcePath).replace(/\.(md|markdown)$/i, '').trim()
  if (name === '') return

  const already = listAliases(db, noteId).some(
    (alias) => alias.alias.trim().toLowerCase() === name.toLowerCase(),
  )

  if (!already) addAlias(db, noteId, name)
}
