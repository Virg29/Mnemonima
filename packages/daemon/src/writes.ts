import { BadRequestError } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import {
  addAlias,
  deleteNote,
  deleteTerm,
  listTerms,
  noteTerms,
  removeAlias,
  requireNote,
  setNoteTags,
  setTermFlags,
  upsertTerm,
} from '@mnemonima/store'
import { lemmaKey } from '@mnemonima/core'
import {
  addRelatedLink,
  createEmbedder,
  exportProject,
  indexProject,
  removeRelatedLink,
  revertNote,
  undoBatch,
  writeNewNote,
  writeNoteBody,
} from '@mnemonima/engine'
import type { HotProject } from './pool.js'

/**
 * The write half of the daemon.
 *
 * Everything here records a revision with the author and the batch it belongs
 * to, because the MCP server has full write access and an agent session that
 * cannot be reviewed or taken back is not something to hand a agent
 * (DESIGN.md 10.3).
 *
 * Destructive operations — a hard delete, forgetting a term, rebuilding with a
 * different model — are refused unless `mcp.allowDestructive` is on. The
 * non-destructive equivalent is always available: archiving instead of deleting,
 * blocking instead of forgetting.
 */

export interface WriteContext {
  readonly author: string
  readonly batchId: string | null
}

export function readWriteContext(body: Record<string, unknown>, fallback: string): WriteContext {
  const author = typeof body['author'] === 'string' && body['author'] !== '' ? body['author'] : fallback
  const batchId = typeof body['batchId'] === 'string' && body['batchId'] !== '' ? body['batchId'] : null
  return { author, batchId }
}

export function assertDestructiveAllowed(config: ProjectConfig, what: string): void {
  if (config.mcp.allowDestructive) return

  throw new BadRequestError(`${what} is a destructive operation and is switched off`, {
    details: { operation: what },
    hint: 'turn it on with `mnemonima config set mcp.allowDestructive true`, or use the reversible form',
  })
}

export function createNoteFor(
  project: HotProject,
  body: Record<string, unknown>,
  context: WriteContext,
): { id: string; rev: number; warning: string | null } {
  const text = typeof body['body'] === 'string' ? body['body'] : ''

  const result = writeNewNote(project.handle.db, project.config, text, {
    title: typeof body['title'] === 'string' ? body['title'] : undefined,
    id: typeof body['id'] === 'string' ? body['id'] : undefined,
    author: context.author,
    batchId: context.batchId,
  })

  return { id: result.note.id, rev: result.note.rev, warning: result.warning?.message ?? null }
}

export function updateNoteFor(
  project: HotProject,
  id: string,
  body: Record<string, unknown>,
  context: WriteContext,
): { id: string; rev: number; warning: string | null } {
  const current = requireNote(project.handle.db, id)
  const text = typeof body['body'] === 'string' ? body['body'] : current.body

  const result = writeNoteBody(project.handle.db, project.config, id, text, {
    title: typeof body['title'] === 'string' ? body['title'] : undefined,
    author: context.author,
    batchId: context.batchId,
    expectedRev: typeof body['expectedRev'] === 'number' ? body['expectedRev'] : undefined,
  })

  if (Array.isArray(body['tags'])) {
    setNoteTags(
      project.handle.db,
      id,
      body['tags'].filter((tag): tag is string => typeof tag === 'string'),
    )
  }

  return { id: result.note.id, rev: result.note.rev, warning: result.warning?.message ?? null }
}

export function deleteNoteFor(
  project: HotProject,
  id: string,
  hard: boolean,
  context: WriteContext,
): { id: string; hard: boolean; status: string } {
  if (hard) assertDestructiveAllowed(project.config, 'deleting a note outright')

  const note = deleteNote(project.handle.db, id, {
    hard,
    author: context.author,
    batchId: context.batchId,
  })

  return { id: note.id, hard, status: hard ? 'deleted' : 'archived' }
}

export function linkNotes(
  project: HotProject,
  body: Record<string, unknown>,
  context: WriteContext,
): { from: string; to: string; rev: number } {
  const from = String(body['from'] ?? '')
  const to = String(body['to'] ?? '')
  const anchor = typeof body['anchor'] === 'string' ? body['anchor'] : null

  const change = addRelatedLink(
    project.handle.db,
    project.config,
    from,
    to,
    anchor,
    context.author,
  )

  return { from, to, rev: change.rev }
}

export function unlinkNotes(
  project: HotProject,
  body: Record<string, unknown>,
  context: WriteContext,
): { from: string; to: string; rev: number } {
  const from = String(body['from'] ?? '')
  const to = String(body['to'] ?? '')

  const change = removeRelatedLink(project.handle.db, project.config, from, to, context.author)
  return { from, to, rev: change.rev }
}

export function aliasNote(
  project: HotProject,
  body: Record<string, unknown>,
): { id: string; alias: string; removed: boolean } {
  const id = String(body['id'] ?? '')
  const alias = String(body['alias'] ?? '')
  const remove = body['remove'] === true

  requireNote(project.handle.db, id)

  if (remove) {
    removeAlias(project.handle.db, id, alias)
    return { id, alias, removed: true }
  }

  addAlias(project.handle.db, id, alias)
  return { id, alias, removed: false }
}

export type TermAction = 'add' | 'pin' | 'block' | 'unblock' | 'remove'

export function changeTerm(
  project: HotProject,
  body: Record<string, unknown>,
): { term: string; action: TermAction } {
  const term = String(body['term'] ?? '').trim()
  const action = String(body['action'] ?? 'add') as TermAction

  switch (action) {
    case 'add':
    case 'pin':
      upsertTerm(project.handle.db, {
        term,
        lemma: lemmaKey(term),
        source: 'manual',
        pinned: true,
      })
      break

    case 'block':
      setTermFlags(project.handle.db, term, { blocked: true, pinned: false })
      break

    case 'unblock':
      setTermFlags(project.handle.db, term, { blocked: false })
      break

    case 'remove':
      // Blocking is the reversible way to get rid of a term, and it survives
      // the next extraction; forgetting one is not, so it is gated.
      assertDestructiveAllowed(project.config, 'forgetting a term')
      deleteTerm(project.handle.db, term)
      break

    default:
      throw new BadRequestError(`unknown term action "${String(action)}"`, {
        details: { action },
        hint: 'use add, pin, block, unblock or remove',
      })
  }

  return { term, action }
}

export async function reindex(
  project: HotProject,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const full = body['full'] === true
  const model = typeof body['model'] === 'string' ? body['model'] : undefined

  if (model !== undefined && model !== project.config.model.active) {
    assertDestructiveAllowed(project.config, 'rebuilding with a different model')
  }

  const resolved = await createEmbedder(project.config, { model })
  const report = await indexProject(project.handle.db, project.config, resolved, { full })
  await resolved.embedder.dispose()

  // The rows moved; the pool revalidates by fingerprint, but dropping the
  // index now means the next search does not pay for noticing.
  project.loaded = null

  return { ...report }
}

export function undoWrites(
  project: HotProject,
  body: Record<string, unknown>,
  context: WriteContext,
): Record<string, unknown> {
  const batchId = typeof body['batchId'] === 'string' ? body['batchId'] : ''
  const revision = typeof body['rev'] === 'number' ? body['rev'] : null
  const id = typeof body['id'] === 'string' ? body['id'] : null

  if (id !== null && revision !== null) {
    return {
      ...revertNote(project.handle.db, project.config, id, revision, context.author),
    }
  }

  if (batchId === '') {
    throw new BadRequestError('nothing to undo', {
      details: {},
      hint: 'pass a batchId, or an id together with a rev',
    })
  }

  return { ...undoBatch(project.handle.db, project.config, batchId, context.author) }
}

export function exportNow(
  project: HotProject,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...exportProject(project.handle.db, project.config, project.handle.dir, {
      push: body['push'] === true,
    }),
  }
}

export function listVocabulary(project: HotProject, limit: number): Record<string, unknown> {
  return {
    terms: listTerms(project.handle.db, { limit }),
  }
}

export function termsOfNote(project: HotProject, id: string): Record<string, unknown> {
  requireNote(project.handle.db, id)
  return { id, terms: noteTerms(project.handle.db, id) }
}
