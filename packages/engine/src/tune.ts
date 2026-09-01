import { applyPatch } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import type { Db } from '@mnemonima/store'
import type { ResolvedEmbedder } from './embedder.js'
import { runEval } from './eval.js'
import type { EvalMetrics, EvalQuerySet } from './eval.js'
import type { SearchIndex } from './orama.js'

/**
 * Weight search — DESIGN.md 9.
 *
 * Every candidate is scored by running the whole golden set, which is only
 * affordable because none of it touches the index: each knob is read at query
 * time, so a candidate is a patch applied to a copy of the configuration. The
 * same mechanism the search lab uses to try a weight without saving it.
 *
 * **This overfits, and the smaller the set the harder.** On eight queries it
 * will find weights that are perfect for those eight and useless for anything
 * else. The report says so rather than presenting a winner as a finding, and
 * the caller is expected to pass that on.
 *
 * Random search rather than a grid, because the space is nine-dimensional and a
 * grid coarse enough to finish is coarser than the differences worth finding.
 */

/** The knobs worth searching, and the interval each is explored over. */
const DIMENSIONS: readonly { readonly path: string; readonly min: number; readonly max: number }[] =
  [
    { path: 'search.hybridWeights.text', min: 0, max: 1 },
    { path: 'search.hybridWeights.vector', min: 0, max: 1 },
    { path: 'search.strategyWeights.fine', min: 0.2, max: 1.5 },
    { path: 'search.strategyWeights.coarse', min: 0.2, max: 1.5 },
    { path: 'search.fusion.chunk', min: 0.3, max: 1 },
    { path: 'search.fusion.meta', min: 0, max: 0.7 },
    { path: 'search.fusion.lambdaMultiChunk', min: 0, max: 0.4 },
    { path: 'search.graph.boost', min: 0, max: 0.4 },
    { path: 'search.boost.title', min: 1, max: 5 },
  ]

export type TuneObjective = 'ndcg' | 'mrr' | 'recall'

export interface TuneOptions {
  readonly trials?: number | undefined
  readonly objective?: TuneObjective | undefined
  readonly index?: SearchIndex | undefined
  readonly recallK?: number | undefined
  readonly ndcgK?: number | undefined
  /**
   * Fraction of the set held back from the search and used only to check the
   * winner. Zero turns it off, which makes the reported win meaningless — see
   * the note on `TuneReport.holdout`.
   */
  readonly holdout?: number | undefined
  /** Injected so a test is not at the mercy of the random number generator. */
  readonly random?: (() => number) | undefined
  readonly onTrial?: (done: number, total: number, best: number) => void
}

export interface TuneCandidate {
  readonly patch: Record<string, number>
  readonly metrics: EvalMetrics
  readonly score: number
}

/**
 * What the winning weights scored on queries the search never saw.
 *
 * This is the only number in the report that means anything. Measured on the
 * project this was written for: tuning on half the set reached a perfect 1.000
 * on that half both times it was tried, and moved the other half by exactly
 * nothing — not a smaller gain, an identical score to three decimals, in both
 * directions. Every point of the apparent win was the search fitting the
 * twelve queries it was scored on.
 */
export interface TuneHoldout {
  readonly queries: number
  readonly baseline: EvalMetrics
  readonly best: EvalMetrics
  readonly baselineScore: number
  readonly bestScore: number
  readonly improved: boolean
}

export interface TuneReport {
  readonly objective: TuneObjective
  readonly trials: number
  /** Scores on the queries the search was allowed to see. Flattering by design. */
  readonly baseline: TuneCandidate
  readonly best: TuneCandidate
  /** Null only when the caller switched the check off. */
  readonly holdout: TuneHoldout | null
  /** Only the settings that actually moved, so the diff is readable. */
  readonly changes: readonly { readonly path: string; readonly from: number; readonly to: number }[]
  /** Improved where it counts: on the holdout, when there is one. */
  readonly improved: boolean
  readonly warning: string | null
}

/**
 * Splits the set for a holdout check.
 *
 * Every `stride`-th query is held back rather than the tail: a set is usually
 * written topic by topic, so taking the last half would hold back one subject
 * entirely and measure whether the weights transfer between topics instead of
 * whether they transfer at all. Deterministic, so a run can be repeated.
 */
export function splitQueries<T>(
  queries: readonly T[],
  fraction: number,
): { readonly tune: T[]; readonly holdout: T[] } {
  if (fraction <= 0 || queries.length < 4) return { tune: [...queries], holdout: [] }

  const stride = Math.max(2, Math.round(1 / Math.min(fraction, 0.5)))

  const tune: T[] = []
  const holdout: T[] = []
  queries.forEach((query, index) => {
    if ((index + 1) % stride === 0) holdout.push(query)
    else tune.push(query)
  })

  // A split that leaves nothing to search on is not a split.
  return tune.length === 0 ? { tune: [...queries], holdout: [] } : { tune, holdout }
}

export function scoreOf(metrics: EvalMetrics, objective: TuneObjective): number {
  if (objective === 'mrr') return metrics.mrr
  if (objective === 'recall') return metrics.recallAtK
  return metrics.ndcgAtK
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function readNumber(config: ProjectConfig, path: string): number {
  const value = path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      config,
    )

  return typeof value === 'number' ? value : 0
}

export async function tuneWeights(
  db: Db,
  config: ProjectConfig,
  resolved: ResolvedEmbedder | null,
  set: EvalQuerySet,
  project: string,
  options: TuneOptions = {},
): Promise<TuneReport> {
  const trials = Math.max(1, options.trials ?? 60)
  const objective = options.objective ?? 'ndcg'
  const random = options.random ?? Math.random
  const fraction = options.holdout ?? 0.5

  const parts = splitQueries(set.queries, fraction)
  const searchSet: EvalQuerySet = { path: set.path, queries: parts.tune }
  const checkSet: EvalQuerySet = { path: set.path, queries: parts.holdout }

  const scoreAgainst = async (
    against: EvalQuerySet,
    patch: Record<string, number>,
  ): Promise<TuneCandidate> => {
    const candidate = Object.keys(patch).length === 0 ? config : applyPatch(config, patch)
    const report = await runEval(db, config, resolved, against, project, {
      config: candidate,
      index: options.index,
      recallK: options.recallK,
      ndcgK: options.ndcgK,
    })

    return { patch, metrics: report.metrics, score: scoreOf(report.metrics, objective) }
  }

  const score = (patch: Record<string, number>): Promise<TuneCandidate> =>
    scoreAgainst(searchSet, patch)

  const baseline = await score({})
  let best = baseline

  for (let trial = 0; trial < trials; trial += 1) {
    const patch: Record<string, number> = {}
    for (const knob of DIMENSIONS) {
      patch[knob.path] = round(knob.min + random() * (knob.max - knob.min))
    }

    // A candidate where both hybrid weights land on zero is not a search, and
    // `resolveWeights` refuses it. Skipping is cheaper than special-casing it
    // in the scorer.
    const text = patch['search.hybridWeights.text'] ?? 0
    const vector = patch['search.hybridWeights.vector'] ?? 0
    if (text + vector === 0) continue

    const candidate = await score(patch)
    if (candidate.score > best.score) best = candidate

    options.onTrial?.(trial + 1, trials, best.score)
  }

  const changes = Object.entries(best.patch)
    .map(([path, to]) => ({ path, from: readNumber(config, path), to }))
    .filter((change) => change.from !== change.to)
    .sort((a, b) => a.path.localeCompare(b.path))

  // The winner, scored on queries it never saw. Only done once, at the end:
  // checking every candidate against the holdout would make the holdout part
  // of the search and defeat the point of having one.
  let holdout: TuneHoldout | null = null

  if (checkSet.queries.length > 0) {
    const before = await scoreAgainst(checkSet, {})
    const after = await scoreAgainst(checkSet, best.patch)

    holdout = {
      queries: checkSet.queries.length,
      baseline: before.metrics,
      best: after.metrics,
      baselineScore: before.score,
      bestScore: after.score,
      improved: after.score > before.score,
    }
  }

  return {
    objective,
    trials,
    baseline,
    best,
    holdout,
    changes,
    // On the holdout when there is one: a win on the queries the search was
    // scored against is not evidence of anything.
    improved: holdout === null ? best.score > baseline.score : holdout.improved,
    warning:
      holdout === null
        ? 'no holdout: the win below was measured on the same queries the search was scored ' +
          'against, so it is not evidence that these weights are better'
        : parts.tune.length < 10
        ? `searched on ${parts.tune.length} queries and checked on ${holdout.queries}: both halves ` +
          'are small enough that either number could be luck'
        : null,
  }
}
