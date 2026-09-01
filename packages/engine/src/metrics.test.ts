import { describe, expect, it } from 'vitest'
import { meanOf, ndcgAt, negativesAt, percentile, recallAt, reciprocalRank } from './metrics.js'

/**
 * The metrics are the point of stage 9, so they are checked against worked
 * examples rather than against themselves. Every expected number here can be
 * arrived at with a pen.
 */

// Two relevant answers, at positions 2 and 4 of five results.
const query = {
  returned: ['SL-0013', 'SL-0042', 'SL-0002', 'SL-0007', 'SL-0031'],
  relevant: ['SL-0042', 'SL-0007'],
}

describe('recall', () => {
  it('counts how many of the answers are in the window', () => {
    expect(recallAt(query, 5)).toBe(1)
    expect(recallAt(query, 3)).toBe(0.5)
    expect(recallAt(query, 1)).toBe(0)
  })

  it('has nothing to say about a query with no answers marked', () => {
    // Not zero: a query nobody labelled must not drag the average down.
    expect(recallAt({ returned: ['SL-0001'], relevant: [] }, 5)).toBeNull()
  })
})

describe('reciprocal rank', () => {
  it('is one over the position of the first correct answer', () => {
    expect(reciprocalRank(query)).toBe(0.5)
    expect(reciprocalRank({ returned: ['SL-0042'], relevant: ['SL-0042'] })).toBe(1)
    expect(reciprocalRank({ returned: ['a', 'b', 'SL-0042'], relevant: ['SL-0042'] })).toBeCloseTo(
      1 / 3,
    )
  })

  it('is zero when nothing relevant came back at all', () => {
    expect(reciprocalRank({ returned: ['a', 'b'], relevant: ['SL-0042'] })).toBe(0)
  })

  it('ignores everything after the first hit', () => {
    // The agent reads the top of the list; what is below it does not change
    // how quickly the answer was reached.
    const early = { returned: ['SL-0042', 'x', 'y'], relevant: ['SL-0042'] }
    const alsoEarly = { returned: ['SL-0042', 'SL-0007', 'y'], relevant: ['SL-0042'] }

    expect(reciprocalRank(early)).toBe(reciprocalRank(alsoEarly))
  })
})

describe('nDCG', () => {
  it('is one for a perfect ordering', () => {
    const perfect = { returned: ['SL-0042', 'SL-0007', 'x'], relevant: ['SL-0042', 'SL-0007'] }
    expect(ndcgAt(perfect, 10)).toBe(1)
  })

  it('falls when the same answers sit lower', () => {
    // DCG = 1/log2(3) + 1/log2(5) = 0.6309 + 0.4307 = 1.0616
    // IDCG = 1/log2(2) + 1/log2(3) = 1 + 0.6309 = 1.6309
    expect(ndcgAt(query, 10)).toBeCloseTo(1.0616 / 1.6309, 3)
  })

  it('weighs the top of the list far more than the bottom', () => {
    const first = { returned: ['SL-0042', 'a', 'b', 'c', 'd'], relevant: ['SL-0042'] }
    const second = { returned: ['a', 'SL-0042', 'b', 'c', 'd'], relevant: ['SL-0042'] }
    const fifth = { returned: ['a', 'b', 'c', 'd', 'SL-0042'], relevant: ['SL-0042'] }

    const drop = (ndcgAt(first, 10) ?? 0) - (ndcgAt(second, 10) ?? 0)
    const laterDrop = (ndcgAt(second, 10) ?? 0) - (ndcgAt(fifth, 10) ?? 0)

    expect(drop).toBeGreaterThan(laterDrop / 2)
  })

  it('is zero when nothing relevant is in the window', () => {
    expect(ndcgAt(query, 1)).toBe(0)
  })
})

describe('the three together', () => {
  it('disagree, which is why there are three of them', () => {
    // The change a single score would hide: both answers are now found, and
    // the best one is no longer first. Recall calls that better, MRR calls it
    // worse, and both are right about the thing they measure.
    const before = { returned: ['SL-0042'], relevant: ['SL-0042', 'SL-0007'] }
    const after = { returned: ['x', 'SL-0042', 'SL-0007'], relevant: ['SL-0042', 'SL-0007'] }

    expect(recallAt(after, 5)).toBeGreaterThan(recallAt(before, 5) ?? 0)
    expect(reciprocalRank(after)).toBeLessThan(reciprocalRank(before) ?? 0)
  })

  it('agree that finding a second answer late still beats not finding it', () => {
    // nDCG discounts position, it does not punish coverage: an answer at rank
    // five is worth less than one at rank two and more than one that is absent.
    const missing = { returned: ['SL-0042'], relevant: ['SL-0042', 'SL-0007'] }
    const late = { returned: ['SL-0042', 'x', 'y', 'z', 'SL-0007'], relevant: ['SL-0042', 'SL-0007'] }

    expect(ndcgAt(late, 5)).toBeGreaterThan(ndcgAt(missing, 5) ?? 0)
    expect(ndcgAt(late, 5)).toBeLessThan(1)
  })
})

describe('negatives', () => {
  it('are counted, not folded into a score', () => {
    expect(negativesAt(['a', 'SL-0002', 'c'], ['SL-0002'], 3)).toBe(1)
    expect(negativesAt(['a', 'b', 'SL-0002'], ['SL-0002'], 2)).toBe(0)
    expect(negativesAt(['a'], [], 5)).toBe(0)
  })
})

describe('averaging', () => {
  it('skips the queries that had nothing to measure', () => {
    expect(meanOf([1, null, 0])).toBe(0.5)
    expect(meanOf([null, null])).toBe(0)
  })
})

describe('percentiles', () => {
  it('takes the nearest rank', () => {
    const sample = [10, 20, 30, 40, 50]

    expect(percentile(sample, 0.5)).toBe(30)
    expect(percentile(sample, 0.95)).toBe(50)
    expect(percentile([], 0.5)).toBe(0)
  })

  it('does not care what order the sample arrived in', () => {
    expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30)
  })
})
