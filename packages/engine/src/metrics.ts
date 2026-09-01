/**
 * Retrieval metrics — DESIGN.md 9.
 *
 * Three numbers rather than one, because they fail differently and a single
 * score hides which way. Widening the candidate set raises recall and lowers
 * MRR: the answer is now somewhere in the list instead of at the top. Only
 * seeing both says so.
 *
 * Relevance is binary here. Graded relevance would let nDCG say more, but it
 * needs a golden set someone graded, and asking an operator to rank a note as
 * "2 out of 3 relevant" produces numbers less honest than the ones it replaces.
 */

export interface RankedQuery {
  /** Note ids the search returned, best first. */
  readonly returned: readonly string[]
  /** Note ids that answer the question. */
  readonly relevant: readonly string[]
}

/**
 * How much of what should have been found was found, in the first `k`.
 *
 * Answers "does the engine know where the answer is at all", and says nothing
 * about the order. A query with no relevant ids has nothing to recall, so it
 * contributes nothing rather than a free 1.0.
 */
export function recallAt(query: RankedQuery, k: number): number | null {
  if (query.relevant.length === 0) return null

  const top = new Set(query.returned.slice(0, k))
  const found = query.relevant.filter((id) => top.has(id)).length

  return found / query.relevant.length
}

/**
 * The reciprocal of the rank of the first correct answer.
 *
 * The agent's metric: an agent reads the top of the result list and often only
 * the first entry, so second place is worth half of first. Zero when nothing
 * relevant was returned at all.
 */
export function reciprocalRank(query: RankedQuery): number | null {
  if (query.relevant.length === 0) return null

  const relevant = new Set(query.relevant)
  const rank = query.returned.findIndex((id) => relevant.has(id))

  return rank === -1 ? 0 : 1 / (rank + 1)
}

/**
 * Discounted cumulative gain over the first `k`, normalised by the best
 * possible ordering of the same answers.
 *
 * The human's metric: it reads the whole list and cares that the order is
 * sensible, not only that the first entry is right. A perfect ordering scores
 * 1; the discount is logarithmic, so the difference between positions 1 and 2
 * matters far more than between 9 and 10.
 */
export function ndcgAt(query: RankedQuery, k: number): number | null {
  if (query.relevant.length === 0) return null

  const relevant = new Set(query.relevant)
  const gain = (position: number): number => 1 / Math.log2(position + 2)

  const dcg = query.returned
    .slice(0, k)
    .reduce((sum, id, index) => (relevant.has(id) ? sum + gain(index) : sum), 0)

  // The ideal: every relevant note at the top, capped by how many fit in k.
  const ideal = Array.from({ length: Math.min(k, relevant.size) }).reduce<number>(
    (sum, _, index) => sum + gain(index),
    0,
  )

  return ideal === 0 ? 0 : dcg / ideal
}

/** Negatives that turned up in the first `k`, counted rather than scored. */
export function negativesAt(
  returned: readonly string[],
  irrelevant: readonly string[],
  k: number,
): number {
  if (irrelevant.length === 0) return 0

  const top = new Set(returned.slice(0, k))
  return irrelevant.filter((id) => top.has(id)).length
}

/**
 * Averages the values that exist.
 *
 * A query with no relevant ids yields null from every metric above, and
 * counting it as zero would report the set as worse than it is while counting
 * it as one would report it as better.
 */
export function meanOf(values: readonly (number | null)[]): number {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return 0

  return present.reduce((sum, value) => sum + value, 0) / present.length
}

/** The percentile of a latency sample, nearest-rank. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))

  return sorted[index] ?? 0
}
