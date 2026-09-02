import fs from 'node:fs'
import path from 'node:path'
import {
  BadRequestError,
  findBlockedScript,
  hashBody,
  parseLinks,
  parseMarkdown,
  parseTree,
  stripCode,
} from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  addAlias,
  adoptedByPath,
  getNote,
  listAliases,
  listNotes,
  projectDataDir,
  recordAdopted,
} from '@mnemonima/store'
import type { Db } from '@mnemonima/store'
import { normaliseSourcePath } from '@mnemonima/store'
import { exportDirectory } from './bridge.js'
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

export type AdoptAction = 'created' | 'claimed' | 'updated' | 'unchanged' | 'skipped'

export interface AdoptedFile {
  readonly sourcePath: string
  readonly action: AdoptAction
  readonly noteId: string | null
  readonly title: string
  /** Set when the file was skipped, saying which rule skipped it. */
  readonly reason: string | null
  /**
   * Link targets in the stored note that the file does not have, and that
   * writing the file over it would therefore drop.
   */
  readonly losing: readonly string[]
}

export interface AdoptReport {
  readonly root: string
  readonly dryRun: boolean
  readonly files: readonly AdoptedFile[]
  readonly created: number
  /** Files taken over by a note that was already here, matched on the title. */
  readonly claimed: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
  /** Links that exist only in the database and would be written over. */
  readonly losingLinks: number
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
  /**
   * Path prefixes, relative to the root, to take. Everything else is left
   * behind. Given so that a repository can be adopted from its own root — which
   * is what makes a link from `.claude/plan.md` to `docs/mechanics/warp.md`
   * resolve — without swallowing the generated half of it.
   */
  readonly only?: readonly string[] | undefined
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

/**
 * The title this file will actually get.
 *
 * Derived the same way the writer derives it — through mdast, not a regular
 * expression over the source — because the two have to agree. They did not: a
 * heading reading `What else belongs in \`api/\`` gave the writer *What else
 * belongs in api/* and gave the matcher the version with the backticks, so a
 * note that was already there was not recognised and would have been duplicated.
 */
function titleOf(body: string, file: string): string {
  const parsed = parseMarkdown(body, parseTree(body))
  const fromHeading = parsed.title?.trim()

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

/**
 * @param projectDir where the project itself lives, so its own output can be
 *   skipped. A positional parameter rather than an option because forgetting it
 *   is not a small mistake: an export written inside the adopted directory is
 *   adopted back on the next run, and the vault doubles. Measured, on a 241-file
 *   vault that came back as 482 notes.
 */
export function adoptVault(
  db: Db,
  config: ProjectConfig,
  projectDir: string,
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

  // Everything we generate for this project, whether or not it sits inside the
  // directory being adopted.
  const ours = [projectDataDir(projectDir), exportDirectory(projectDir, config)].map((dir) =>
    path.resolve(dir),
  )

  const only = (options.only ?? []).map((prefix) => normaliseSourcePath(prefix))

  const files = findMarkdown(resolved, options.ignore ?? DEFAULT_IGNORE)
    .filter((file) => !ours.some((dir) => file === dir || file.startsWith(dir + path.sep)))
    .filter((file) => {
      if (only.length === 0) return true
      const relative = normaliseSourcePath(path.relative(resolved, file))
      return only.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))
    })

  const known = adoptedByPath(db)

  // Notes already here that no file has claimed yet, by title.
  //
  // A project can already hold the notes a vault is about — written by hand
  // before `adopt` existed, or by an agent. Creating a second copy of each
  // would be the wrong answer twice over: duplicates in search, and new ids for
  // notes that already have ids other things reference. Titles match because
  // they came from the same `# heading` the files still carry.
  const claimable = new Map<string, string>()
  for (const note of listNotes(db, { status: 'any', limit: -1 })) {
    const key = note.title.trim().toLowerCase()
    if (key !== '' && !claimable.has(key)) claimable.set(key, note.id)
  }
  for (const row of known.values()) {
    for (const [key, noteId] of claimable) if (noteId === row.noteId) claimable.delete(key)
  }

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
        losing: [],
      })
      continue
    }

    const existing = known.get(sourcePath)

    if (existing !== undefined && existing.bodyHash === hashBody(body)) {
      results.push({
        sourcePath,
        action: 'unchanged',
        noteId: existing.noteId,
        title,
        reason: null,
        losing: [],
      })
      continue
    }

    // A note already here whose title is this file's, taken over rather than
    // duplicated. Claimed once: two files with the same heading must not both
    // land on it.
    const claimedId = existing === undefined ? claimable.get(title.trim().toLowerCase()) : undefined
    if (claimedId !== undefined) claimable.delete(title.trim().toLowerCase())

    const target = existing?.noteId ?? claimedId ?? null

    results.push({
      sourcePath,
      action: existing !== undefined ? 'updated' : claimedId !== undefined ? 'claimed' : 'created',
      noteId: target,
      title,
      reason: null,
      losing: target === null ? [] : linksOnlyInTheNote(db, target, body),
    })

    if (dryRun) continue

    // A copy with the gate off, not an option on the write path: `adopt` has
    // already decided what to do about the language, above, and the writer
    // should not decide it a second time on different evidence.
    const writeConfig: ProjectConfig =
      violation === null ? config : { ...config, language: { ...config.language, gate: 'off' } }

    const noteId =
      target === null
        ? create(db, writeConfig, body, sourcePath, options)
        : updateNote(db, writeConfig, target, sourcePath, body, options)

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
    claimed: results.filter((file) => file.action === 'claimed').length,
    updated: results.filter((file) => file.action === 'updated').length,
    unchanged: results.filter((file) => file.action === 'unchanged').length,
    skipped: results.filter((file) => file.action === 'skipped').length,
    losingLinks: results.reduce((total, file) => total + file.losing.length, 0),
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

function updateNote(
  db: Db,
  config: ProjectConfig,
  noteId: string,
  sourcePath: string,
  body: string,
  options: AdoptOptions,
): string {
  writeNoteBody(db, config, noteId, body, {
    author: options.author ?? 'adopt',
    batchId: options.batchId ?? null,
  })

  recordAdopted(db, noteId, sourcePath, hashBody(body))
  rememberOriginalName(db, noteId, sourcePath)

  return noteId
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

/**
 * Links the stored note has that the file does not.
 *
 * Adoption replaces a body with the file's, and links are derived from bodies
 * (DESIGN.md 3.4) — so a `## Related` section that only ever existed in the
 * database goes with it. That is what happened on the migration this was
 * written for: 25 of 30 rewritten notes lost their section, 93 hand-made links
 * in all, and the dry run said nothing about it.
 *
 * Reported rather than prevented. The file *is* the source being adopted, and
 * quietly merging our links back into it would leave two ideas of what the
 * note's body is. Saying what will go, before it goes, is the honest half.
 */
function linksOnlyInTheNote(db: Db, noteId: string, incoming: string): string[] {
  const note = getNote(db, noteId)
  if (note === null) return []

  const inFile = new Set(parseLinks(incoming).map((link) => link.target.trim().toLowerCase()))

  const losing = parseLinks(note.body)
    .map((link) => link.target.trim())
    .filter((target) => !inFile.has(target.toLowerCase()))

  return [...new Set(losing)]
}
