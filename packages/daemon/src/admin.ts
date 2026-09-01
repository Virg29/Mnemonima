import fs from 'node:fs'
import { BadRequestError, applyPatch, flatten } from '@mnemonima/core'
import type { ConfigPatch, ProjectConfig } from '@mnemonima/core'
import {
  getActiveSpace,
  listBatches,
  listRevisions,
  listSpaces,
  requireNote,
  setActiveSpace,
  setConfig,
  spaceUsage,
} from '@mnemonima/store'
import { exportDirectory, runDoctor, fixDoctorFindings } from '@mnemonima/engine'
import type { DoctorFixReport, DoctorReport } from '@mnemonima/engine'
import type { HotProject } from './pool.js'

/**
 * The administration half of the daemon — configuration, embedding spaces,
 * integrity and the revision log.
 *
 * Separate from `writes.ts` for one reason that matters at runtime: nothing
 * here touches a note body, so nothing here schedules an export. Changing a
 * search weight must not produce a git commit.
 */

export interface ConfigView {
  readonly project: string
  readonly config: ProjectConfig
  /** Every settable dotted path, so a form can be built without a second copy of the shape. */
  readonly paths: string[]
  /**
   * Where `export.path` actually lands, and whether it is there.
   *
   * The setting is a relative path most of the time, so showing it back
   * verbatim tells the operator nothing about where the files will go — and
   * automatic export does nothing at all when the directory is missing.
   */
  readonly exportTarget: { readonly directory: string; readonly exists: boolean }
}

export function readConfig(project: HotProject): ConfigView {
  const directory = exportDirectory(project.handle.dir, project.config)

  return {
    project: project.name,
    config: project.config,
    paths: flatten(project.config).map(([key]) => key),
    exportTarget: { directory, exists: fs.existsSync(directory) },
  }
}

/**
 * Creates the export directory, on request.
 *
 * Automatic export deliberately does not do this: we keep a vault up to date,
 * we do not conjure one because an agent wrote a note. A button is the
 * operator saying yes, which is the missing half of that rule rather than an
 * exception to it.
 */
export function createExportDirectory(project: HotProject): ConfigView {
  fs.mkdirSync(exportDirectory(project.handle.dir, project.config), { recursive: true })
  return readConfig(project)
}

/**
 * Applies a patch of dotted paths and persists it.
 *
 * `applyPatch` validates every path before any of them is written and works on
 * a copy, so a body with one bad key changes nothing at all — the alternative
 * leaves the configuration half-updated and the caller unable to tell how far
 * it got.
 */
export function writeConfig(project: HotProject, body: Record<string, unknown>): ConfigView {
  const patch = body['set']

  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new BadRequestError('a configuration change needs a "set" object', {
      details: { received: patch === undefined ? 'nothing' : typeof patch },
      hint: 'send { "set": { "search.hybridWeights.text": 0.6 } }',
    })
  }

  const next = applyPatch(project.config, patch as ConfigPatch)
  setConfig(project.handle.db, next)

  // The pool re-reads configuration on every acquire, so the in-memory copy is
  // updated here only to keep this response honest about what was stored.
  project.config = next

  return readConfig(project)
}

export interface SpaceView {
  readonly id: string
  readonly model: string
  readonly dim: number
  readonly chunkerVersion: string
  readonly isActive: boolean
  readonly createdAt: number
  readonly chunks: number
  readonly embeddings: number
  readonly notes: number
}

export interface SpacesView {
  readonly project: string
  readonly active: string | null
  readonly spaces: SpaceView[]
}

export function readSpaces(project: HotProject): SpacesView {
  const active = getActiveSpace(project.handle.db)

  return {
    project: project.name,
    active: active?.id ?? null,
    spaces: listSpaces(project.handle.db).map((space) => {
      const usage = spaceUsage(project.handle.db, space.id)
      return {
        id: space.id,
        model: space.model,
        dim: space.dim,
        chunkerVersion: space.chunkerVersion,
        isActive: space.isActive,
        createdAt: space.createdAt,
        chunks: usage.chunks,
        embeddings: usage.embeddings,
        notes: usage.notes,
      }
    }),
  }
}

/**
 * Switches the active space.
 *
 * This is the rollback of DESIGN.md 6.4: the vectors of the other space were
 * never deleted, so going back costs one flag and no embedding. It is not a
 * destructive operation and is deliberately not gated.
 */
export function activateSpace(project: HotProject, id: string): SpacesView {
  setActiveSpace(project.handle.db, id)

  // The pool's index was built from the space that is no longer active; drop it
  // so the next search rebuilds rather than answering from the wrong vectors.
  project.loaded = null

  return readSpaces(project)
}

export function readDoctor(project: HotProject): DoctorReport & { readonly project: string } {
  return {
    project: project.name,
    ...runDoctor(project.handle.db, { dir: project.handle.dir }),
  }
}

export function repairProject(project: HotProject): DoctorFixReport {
  return fixDoctorFindings(project.handle.db)
}

export function readRevisions(
  project: HotProject,
  id: string,
): { readonly project: string; readonly id: string; readonly revisions: unknown[] } {
  // requireNote first, so an unknown id is a 404 with a hint rather than an
  // empty list that reads like a note with no history.
  const note = requireNote(project.handle.db, id)

  return {
    project: project.name,
    id: note.id,
    revisions: listRevisions(project.handle.db, note.id),
  }
}

export function readBatches(
  project: HotProject,
  limit: number,
): { readonly project: string; readonly batches: unknown[] } {
  return {
    project: project.name,
    batches: listBatches(project.handle.db, limit),
  }
}
