import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BadRequestError, NotFoundError } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import type { Db } from '@mnemonima/store'
import { projectDataDir } from '@mnemonima/store'
import type { ResolvedEmbedder } from './embedder.js'
import { meanOf, ndcgAt, negativesAt, percentile, recallAt, reciprocalRank } from './metrics.js'
import { searchNotes } from './search.js'
import type { SearchIndex } from './orama.js'

/**
 * The eval harness — DESIGN.md 9.
 *
 * Without one, moving a weight in the search lab optimises for the last query
 * anyone happened to look at. This runs the whole golden set and produces three
 * numbers that disagree with each other on purpose (see `metrics.ts`).
 *
 * The set is a file the operator writes, and it is the expensive half: code
 * that computes nDCG is an afternoon, twenty queries phrased the way an agent
 * actually asks them are not. Everything here is built so that file stays cheap
 * to edit — a missing note id is reported rather than silently scoring zero,
 * and every query keeps its own row so a bad average can be traced to the one
 * question that caused it.
 */

/** Below this, the numbers move more with the set than with the engine. */
export const NOISY_BELOW = 20

export interface EvalQuery {
  readonly q: string
  readonly relevant: readonly string[]
  readonly irrelevant: readonly string[]
}

export interface EvalQuerySet {
  readonly path: string
  readonly queries: readonly EvalQuery[]
}

export interface QueryOutcome {
  readonly query: string
  readonly returned: readonly string[]
  readonly relevant: readonly string[]
  readonly recall: number | null
  readonly reciprocalRank: number | null
  readonly ndcg: number | null
  readonly negatives: number
  readonly tookMs: number
}

export interface EvalMetrics {
  readonly queries: number
  readonly recallAtK: number
  readonly mrr: number
  readonly ndcgAtK: number
  readonly negatives: number
  readonly p50Ms: number
  readonly p95Ms: number
}

export interface EvalReport {
  readonly project: string
  readonly set: string
  readonly recallK: number
  readonly ndcgK: number
  readonly metrics: EvalMetrics
  readonly outcomes: readonly QueryOutcome[]
  /** Ids named in the set that no longer exist, if any. */
  readonly unknownIds: readonly string[]
  /** Set when the set is too small for the numbers to mean much. */
  readonly warning: string | null
}

export interface EvalOptions {
  readonly recallK?: number | undefined
  readonly ndcgK?: number | undefined
  /** A warm index, so a hundred tuning runs do not rebuild it a hundred times. */
  readonly index?: SearchIndex | undefined
  /** Applied to a copy of the configuration for this run only. */
  readonly config?: ProjectConfig | undefined
}

export function evalSetPath(projectDir: string): string {
  return path.join(projectDataDir(projectDir), 'eval', 'queries.yaml')
}

function asIdList(value: unknown, field: string, query: string): string[] {
  if (value === undefined || value === null) return []

  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new BadRequestError(`"${field}" must be a list of note ids`, {
      details: { query, field, value },
      hint: 'write it as `relevant: [SL-0042, SL-0007]`',
    })
  }

  return value as string[]
}

/** Reads the golden set, refusing a file that would silently score nothing. */
export function readQuerySet(projectDir: string): EvalQuerySet {
  const file = evalSetPath(projectDir)

  if (!fs.existsSync(file)) {
    throw new NotFoundError('this project has no golden set', {
      details: { path: file },
      hint: `write one at ${file} — a list of \`- q: "..."\` with the ids that answer each`,
    })
  }

  const parsed: unknown = parseYaml(fs.readFileSync(file, 'utf8'))

  if (!Array.isArray(parsed)) {
    throw new BadRequestError('the golden set must be a list of queries', {
      details: { path: file },
      hint: 'each entry is `- q: "how a fragment shader runs"` with `relevant: [...]` under it',
    })
  }

  const queries = parsed.map((entry, index): EvalQuery => {
    const row = (entry ?? {}) as Record<string, unknown>
    const q = row['q']

    if (typeof q !== 'string' || q.trim() === '') {
      throw new BadRequestError(`entry ${index + 1} of the golden set has no query`, {
        details: { path: file, index },
        hint: 'every entry needs a `q:` line with the question as it would be asked',
      })
    }

    return {
      q,
      relevant: asIdList(row['relevant'], 'relevant', q),
      irrelevant: asIdList(row['irrelevant'], 'irrelevant', q),
    }
  })

  return { path: file, queries }
}

/**
 * Runs the set and scores it.
 *
 * `limit` is deliberately the larger of the two cut-offs rather than the
 * project's `resultK`: measuring recall@5 with a search that returned three
 * results measures the setting, not the engine.
 */
export async function runEval(
  db: Db,
  config: ProjectConfig,
  resolved: ResolvedEmbedder | null,
  set: EvalQuerySet,
  project: string,
  options: EvalOptions = {},
): Promise<EvalReport> {
  const recallK = options.recallK ?? 5
  const ndcgK = options.ndcgK ?? 10
  const effective = options.config ?? config
  const limit = Math.max(recallK, ndcgK)

  const outcomes: QueryOutcome[] = []
  const latencies: number[] = []

  for (const query of set.queries) {
    const started = Date.now()
    const result = await searchNotes(db, effective, resolved, query.q, {
      limit,
      index: options.index,
    })
    const tookMs = Date.now() - started
    latencies.push(tookMs)

    const returned = result.hits.map((hit) => hit.id)
    const ranked = { returned, relevant: query.relevant }

    outcomes.push({
      query: query.q,
      returned,
      relevant: query.relevant,
      recall: recallAt(ranked, recallK),
      reciprocalRank: reciprocalRank(ranked),
      ndcg: ndcgAt(ranked, ndcgK),
      negatives: negativesAt(returned, query.irrelevant, ndcgK),
      tookMs,
    })
  }

  return {
    project,
    set: set.path,
    recallK,
    ndcgK,
    metrics: {
      queries: set.queries.length,
      recallAtK: meanOf(outcomes.map((outcome) => outcome.recall)),
      mrr: meanOf(outcomes.map((outcome) => outcome.reciprocalRank)),
      ndcgAtK: meanOf(outcomes.map((outcome) => outcome.ndcg)),
      negatives: outcomes.reduce((sum, outcome) => sum + outcome.negatives, 0),
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
    },
    outcomes,
    unknownIds: unknownIds(db, set),
    warning:
      set.queries.length < NOISY_BELOW
        ? `${set.queries.length} queries is below ${NOISY_BELOW}: the numbers move more with the ` +
          'set than with the engine, so treat a difference as a hint rather than a result'
        : null,
  }
}

/**
 * Ids the set names that the project does not have.
 *
 * A renamed file or a note that was archived turns a correct engine into a
 * failing score, and the failure looks exactly like a ranking problem. Saying
 * so is the difference between a set that is maintained and one that is quietly
 * wrong.
 */
function unknownIds(db: Db, set: EvalQuerySet): string[] {
  const named = new Set<string>()
  for (const query of set.queries) {
    for (const id of query.relevant) named.add(id)
    for (const id of query.irrelevant) named.add(id)
  }

  if (named.size === 0) return []

  const rows = db
    .prepare(`SELECT id FROM notes WHERE id IN (${[...named].map(() => '?').join(', ')})`)
    .all(...named) as { id: string }[]

  const present = new Set(rows.map((row) => row.id))
  return [...named].filter((id) => !present.has(id)).sort()
}
