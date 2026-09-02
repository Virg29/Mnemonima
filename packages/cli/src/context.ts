import { BadRequestError } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { listEntries, openProject, projectConfig } from '@mnemonima/store'
import type { ProjectHandle } from '@mnemonima/store'
import { createEmbedder } from '@mnemonima/engine'
import type { ResolvedEmbedder } from '@mnemonima/engine'
import { printNote } from './output.js'

/**
 * Resolving which project a command acts on.
 *
 * Order: the explicit `-p` flag, then `MNEMONIMA_PROJECT`, then — when exactly
 * one project is registered — that one. The last rule is what makes the common
 * single-project setup pleasant to use; it announces itself on stderr so the
 * behaviour is never a silent surprise.
 */
export function resolveProjectName(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit

  const fromEnv = process.env['MNEMONIMA_PROJECT']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  const entries = listEntries()
  if (entries.length === 1) {
    const only = entries[0]!.name
    printNote(`using the only registered project: "${only}"`)
    return only
  }

  throw new BadRequestError('no project selected', {
    details: { registered: entries.map((entry) => entry.name) },
    hint:
      entries.length === 0
        ? 'create one first: `mnemonima project add "My Notes" --dir <path>`'
        : `pass -p <name>, or set MNEMONIMA_PROJECT — registered: ${entries
            .map((entry) => `"${entry.name}"`)
            .join(', ')}`,
  })
}

export interface ProjectContext {
  readonly project: ProjectHandle
  readonly config: ProjectConfig
  close(): void
}

export function openContext(explicit?: string): ProjectContext {
  const project = openProject(resolveProjectName(explicit))

  return {
    project,
    config: projectConfig(project.db),
    close: () => {
      project.db.close()
    },
  }
}

export interface EmbedderFlags {
  readonly model?: string | undefined
  readonly threads?: string | number | undefined
}

/**
 * Builds the embedder for a command. Loading it is deliberately lazy: commands
 * that never embed anything (`get`, `list`, `project list`) must not pay for
 * onnxruntime.
 */
export async function openEmbedder(
  context: ProjectContext,
  flags: EmbedderFlags = {},
): Promise<ResolvedEmbedder> {
  return createEmbedder(context.config, {
    model: flags.model,
    threads: parseThreads(flags.threads),
  })
}

function parseThreads(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined

  const threads = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isInteger(threads) || threads < 1) {
    throw new BadRequestError(`--threads must be a positive integer, got "${String(value)}"`, {
      details: { value },
      hint: 'omit it to use half the available cores, which is the intended CPU budget',
    })
  }

  return threads
}

export function parsePositiveInt(
  value: string,
  flag: string,
  // `diff --context 0` is a real request: show the changed lines and nothing
  // around them.
  options: { allowZero?: boolean } = {},
): number {
  const least = options.allowZero === true ? 0 : 1
  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed) || parsed < least) {
    throw new BadRequestError(
      `${flag} must be ${least === 0 ? 'zero or a positive integer' : 'a positive integer'}, got "${value}"`,
      { details: { value } },
    )
  }

  return parsed
}

export function parseUnitInterval(value: string, flag: string): number {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new BadRequestError(`${flag} must be a number between 0 and 1, got "${value}"`, {
      details: { value },
    })
  }
  return parsed
}
