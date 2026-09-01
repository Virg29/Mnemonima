import fs from 'node:fs'
import path from 'node:path'
import { BadRequestError, hashBody, lemmaKey } from '@mnemonima/core'
import type { Note, ProjectConfig } from '@mnemonima/core'
import {
  addAlias,
  addNoteTerm,
  incomingLinks,
  listAliases,
  listNotes,
  listTags,
  noteTerms,
  outgoingLinks,
  removeAlias,
  requireNote,
  setNoteTags,
} from '@mnemonima/store'
import { projectDataDir } from '@mnemonima/store'
import type { Db } from '@mnemonima/store'
import { exportFilename, idFromFilename, parseFile, renderFrontmatter } from './frontmatter.js'
import { commitAll, commitMessage, isRepository, push as gitPush } from './git.js'
import { writeNewNote, writeNoteBody } from './notes.js'

/**
 * The markdown bridge — DESIGN.md 5.
 *
 * SQLite is the source of truth; this directory is a view of it that Obsidian
 * and git can read. The round trip is real — export, edit, import — but only for
 * the half of the frontmatter marked authoritative. Generated fields are written
 * for the reader and discarded on the way back, which removes a whole class of
 * conflict rather than teaching the importer to resolve it.
 */

export function exportDirectory(projectDir: string, config: ProjectConfig): string {
  // Resolved against the project's own subdirectory, so the export sits beside
  // the database it is a view of rather than in the operator's vault root. An
  // absolute `export.path` still wins, which is how a vault elsewhere is fed.
  return path.resolve(projectDataDir(projectDir), config.export.path)
}

export interface ExportOptions {
  readonly dir?: string | undefined
  readonly commit?: boolean | undefined
  readonly push?: boolean | undefined
}

export interface ExportReport {
  readonly dir: string
  readonly created: string[]
  readonly updated: string[]
  readonly unchanged: string[]
  /** Files removed because their note is gone or was renamed. */
  readonly removed: string[]
  readonly committed: boolean
  readonly commit: string | null
  readonly pushed: boolean
  readonly note: string | null
}

export function exportProject(
  db: Db,
  config: ProjectConfig,
  projectDir: string,
  options: ExportOptions = {},
): ExportReport {
  const dir = options.dir ?? exportDirectory(projectDir, config)
  fs.mkdirSync(dir, { recursive: true })

  const created: string[] = []
  const updated: string[] = []
  const unchanged: string[] = []
  const removed: string[] = []

  // Everything, not just the active notes: an export that silently dropped the
  // archive would lose it on the next import.
  const notes = listNotes(db, { status: 'any', limit: -1 })
  const wanted = new Map<string, string>()

  for (const note of notes) {
    const filename = exportFilename(note.id, note.title)
    wanted.set(filename, note.id)

    const contents = renderNote(db, config, note)
    const target = path.join(dir, filename)

    if (fs.existsSync(target)) {
      if (fs.readFileSync(target, 'utf8') === contents) {
        unchanged.push(filename)
        continue
      }
      fs.writeFileSync(target, contents, 'utf8')
      updated.push(filename)
      continue
    }

    fs.writeFileSync(target, contents, 'utf8')
    created.push(filename)
  }

  // Only files that carry one of our ids are ever removed. Anything a human put
  // in this directory is theirs and stays.
  for (const filename of fs.readdirSync(dir)) {
    if (!filename.toLowerCase().endsWith('.md')) continue
    if (wanted.has(filename)) continue

    const id = idFromFilename(filename)
    if (id === null) continue

    fs.rmSync(path.join(dir, filename))
    removed.push(filename)
  }

  const changed = created.length + updated.length + removed.length
  let committed = false
  let commit: string | null = null
  let pushed = false
  let note: string | null = null

  const shouldCommit = options.commit ?? config.export.commit
  if (shouldCommit && changed > 0) {
    if (!isRepository(dir)) {
      note = `${dir} is not a git repository; run \`mnemonima export --init-git\` to make it one`
    } else {
      const message = commitMessage({
        created: created.map(toId),
        updated: updated.map(toId),
        removed: removed.map(toId),
      })
      const result = commitAll(dir, message)
      committed = result.committed
      commit = result.committed ? message : null
      if (!result.ok) note = result.output
    }
  }

  if (options.push === true && committed) {
    const result = gitPush(dir)
    pushed = result.ok
    if (!result.ok) note = result.output
  }

  return { dir, created, updated, unchanged, removed, committed, commit, pushed, note }
}

function toId(filename: string): string {
  return idFromFilename(filename) ?? filename
}

function renderNote(db: Db, config: ProjectConfig, note: Note): string {
  const terms = noteTerms(db, note.id)
  const links = outgoingLinks(db, note.id)

  return renderFrontmatter({
    frontmatter: {
      id: note.id,
      title: note.title,
      status: note.status,
      rev: note.rev,
      created: new Date(note.createdAt).toISOString(),
      updated: new Date(note.updatedAt).toISOString(),
      bodyHash: note.bodyHash,
      tags: listTags(db, note.id),
      aliases: listAliases(db, note.id).map((entry) => entry.alias),
      keywordsManual: terms
        .filter((term) => term.source === 'manual' && term.kind === 'keyword')
        .map((term) => term.term),
      phrasesManual: terms
        .filter((term) => term.source === 'manual' && term.kind === 'phrase')
        .map((term) => term.term),
    },
    generated: {
      keywordsAuto: terms
        .filter((term) => term.source === 'auto' && term.kind === 'keyword')
        .map((term) => term.term),
      phrasesAuto: terms
        .filter((term) => term.source === 'auto' && term.kind === 'phrase')
        .map((term) => term.term),
      outline: note.outline,
      links: links.map((link) => link.dst),
      backlinks: config.links.materializeBacklinks
        ? incomingLinks(db, note.id).map((link) => link.src)
        : [],
    },
    body: note.body,
  })
}

/**
 * What to do when the file and the database both moved.
 *
 * `ask` is the default and means "stop and list them": the CLI has no prompt,
 * so the honest reading of "ask" is that nothing is decided without the
 * operator saying which side wins.
 */
export type ConflictPolicy = 'ask' | 'db' | 'file' | 'both'

export interface ImportConflict {
  readonly id: string
  readonly file: string
  readonly fileRev: number
  readonly dbRev: number
  readonly resolution: 'reported' | 'kept-database' | 'took-file' | 'kept-both'
  readonly copyId?: string
}

export interface ImportSkip {
  readonly file: string
  readonly reason: string
}

export interface ImportOptions {
  readonly dir?: string | undefined
  readonly onConflict?: ConflictPolicy | undefined
  readonly author?: string | undefined
  /** Parse and compare without writing anything. */
  readonly dryRun?: boolean | undefined
}

export interface ImportReport {
  readonly dir: string
  readonly created: string[]
  readonly updated: string[]
  readonly unchanged: string[]
  readonly conflicts: ImportConflict[]
  readonly skipped: ImportSkip[]
  readonly dryRun: boolean
}

export function importProject(
  db: Db,
  config: ProjectConfig,
  projectDir: string,
  options: ImportOptions = {},
): ImportReport {
  const dir = options.dir ?? exportDirectory(projectDir, config)
  const policy = options.onConflict ?? 'ask'
  const author = options.author ?? 'import'
  const dryRun = options.dryRun === true

  if (!fs.existsSync(dir)) {
    throw new BadRequestError(`no such directory: ${dir}`, {
      details: { dir },
      hint: 'run `mnemonima export` first, or pass --dir',
    })
  }

  const created: string[] = []
  const updated: string[] = []
  const unchanged: string[] = []
  const conflicts: ImportConflict[] = []
  const skipped: ImportSkip[] = []

  for (const filename of fs.readdirSync(dir).sort()) {
    if (!filename.toLowerCase().endsWith('.md')) continue

    const parsed = parseFile(fs.readFileSync(path.join(dir, filename), 'utf8'))

    if (parsed.frontmatter === null) {
      skipped.push({
        file: filename,
        reason: 'no mnemonima frontmatter; importing a foreign vault is what `adopt` will be for',
      })
      continue
    }

    const id = parsed.frontmatter.id
    if (id === undefined) {
      skipped.push({ file: filename, reason: 'frontmatter has no id' })
      continue
    }

    const body = parsed.body
    if (body.trim() === '') {
      skipped.push({ file: filename, reason: 'the body is empty' })
      continue
    }

    const existing = tryGetNote(db, id)

    if (existing === null) {
      if (!dryRun) {
        const result = writeNewNote(db, config, body, {
          id,
          title: parsed.frontmatter.title,
          author,
        })
        applyMetadata(db, result.note.id, parsed.frontmatter, dryRun)
      }
      created.push(id)
      continue
    }

    const fileHash = hashBody(body)
    const sameBody = fileHash === existing.bodyHash
    const sameTitle =
      parsed.frontmatter.title === undefined || parsed.frontmatter.title === existing.title

    if (sameBody && sameTitle) {
      // The body is what the database already has, but the operator may still
      // have edited a tag or an alias, and those are cheap to reconcile.
      if (!dryRun) applyMetadata(db, existing.id, parsed.frontmatter, dryRun)
      unchanged.push(id)
      continue
    }

    const fileRev = parsed.frontmatter.rev ?? 0

    // The file is behind and the body moved on both sides: neither version can
    // be preferred without being told.
    if (fileRev < existing.rev) {
      conflicts.push(resolveConflict(db, config, {
        note: existing,
        filename,
        body,
        frontmatter: parsed.frontmatter,
        policy,
        author,
        dryRun,
      }))
      continue
    }

    if (!dryRun) {
      writeNoteBody(db, config, existing.id, body, {
        title: parsed.frontmatter.title,
        author,
        op: 'import',
      })
      applyMetadata(db, existing.id, parsed.frontmatter, dryRun)
    }
    updated.push(id)
  }

  return { dir, created, updated, unchanged, conflicts, skipped, dryRun }
}

interface ConflictInput {
  readonly note: Note
  readonly filename: string
  readonly body: string
  readonly frontmatter: Partial<import('./frontmatter.js').AuthoritativeFrontmatter>
  readonly policy: ConflictPolicy
  readonly author: string
  readonly dryRun: boolean
}

function resolveConflict(db: Db, config: ProjectConfig, input: ConflictInput): ImportConflict {
  const base = {
    id: input.note.id,
    file: input.filename,
    fileRev: input.frontmatter.rev ?? 0,
    dbRev: input.note.rev,
  }

  if (input.policy === 'ask' || input.dryRun) return { ...base, resolution: 'reported' }
  if (input.policy === 'db') return { ...base, resolution: 'kept-database' }

  if (input.policy === 'file') {
    writeNoteBody(db, config, input.note.id, input.body, {
      title: input.frontmatter.title,
      author: input.author,
      op: 'import',
    })
    applyMetadata(db, input.note.id, input.frontmatter, false)
    return { ...base, resolution: 'took-file' }
  }

  // `both`: keep the database note untouched and bring the file in as its own
  // note, linked back to the original. Nothing is lost and nothing is decided.
  const copy = writeNewNote(
    db,
    config,
    `${input.body.trimEnd()}\n\n## Related\n\n- [[${input.note.id} ${input.note.title}]]\n`,
    {
      title: `${input.frontmatter.title ?? input.note.title} (conflict copy)`,
      author: input.author,
    },
  )
  applyMetadata(db, copy.note.id, input.frontmatter, false)

  return { ...base, resolution: 'kept-both', copyId: copy.note.id }
}

/**
 * Reconciles the authoritative metadata of a note with what the file says.
 *
 * Aliases and tags are replaced outright, because the file is the whole picture
 * for them. Manual terms are only added: an extraction may have promoted a term
 * since the export, and dropping it because an older file did not list it would
 * lose a decision the operator made elsewhere.
 */
function applyMetadata(
  db: Db,
  noteId: string,
  frontmatter: Partial<import('./frontmatter.js').AuthoritativeFrontmatter>,
  dryRun: boolean,
): void {
  if (dryRun) return

  if (frontmatter.tags !== undefined) setNoteTags(db, noteId, frontmatter.tags)

  if (frontmatter.aliases !== undefined) {
    const wanted = new Set(frontmatter.aliases.map((alias) => alias.trim()).filter(Boolean))
    for (const existing of listAliases(db, noteId)) {
      if (!wanted.has(existing.alias)) removeAlias(db, noteId, existing.alias)
    }
    for (const alias of wanted) addAlias(db, noteId, alias)
  }

  for (const [terms, kind] of [
    [frontmatter.keywordsManual ?? [], 'keyword'],
    [frontmatter.phrasesManual ?? [], 'phrase'],
  ] as const) {
    for (const term of terms) {
      const trimmed = term.trim()
      if (trimmed === '') continue
      addNoteTerm(db, noteId, {
        term: trimmed,
        lemma: lemmaKey(trimmed),
        kind,
        score: 1,
        source: 'manual',
      })
    }
  }
}

function tryGetNote(db: Db, id: string): Note | null {
  try {
    return requireNote(db, id)
  } catch {
    return null
  }
}
