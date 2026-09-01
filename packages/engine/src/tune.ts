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
  /** Injected so a test is not at the mercy of the random number generator. */
  readonly random?: (() => number) | undefined
  readonly onTrial?: (done: number, total: number, best: number) => void
}

export interface TuneCandidate {
  readonly patch: Record<string, number>
  readonly metrics: EvalMetrics
  readonly score: number
}

export interface TuneReport {
  readonly objective: TuneObjective
  readonly trials: number
  readonly baseline: TuneCandidate
  readonly best: TuneCandidate
  /** Only the settings that actually moved, so the diff is readable. */
  readonly changes: readonly { readonly path: string; readonly from: number; readonly to: number }[]
  readonly improved: boolean
  readonly warning: string | null
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

  const score = async (patch: Record<string, number>): Promise<TuneCandidate> => {
    const candidate = Object.keys(patch).length === 0 ? config : applyPatch(config, patch)
    const report = await runEval(db, config, resolved, set, project, {
      config: candidate,
      index: options.index,
      recallK: options.recallK,
      ndcgK: options.ndcgK,
    })

    return { patch, metrics: report.metrics, score: scoreOf(report.metrics, objective) }
  }

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

  return {
    objective,
    trials,
    baseline,
    best,
    changes,
    improved: best.score > baseline.score,
    warning:
      set.queries.length < 20
        ? `tuned on ${set.queries.length} queries: this will have found weights that suit those ` +
          'queries rather than this project, so verify a win before saving it'
        : null,
  }
}
