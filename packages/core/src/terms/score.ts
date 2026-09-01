import type { TermKind } from '../types.js'
import type { Candidate } from './candidates.js'
import { lemmaKey } from './tokens.js'
import { yakeScores } from './yake.js'

/**
 * Ranking candidates — DESIGN.md 7.1, steps two and three.
 *
 * Three independent signals, fused by reciprocal rank rather than by adding
 * scores. They live on completely different scales — a YAKE cost, an inverse
 * document frequency and a cosine — and rank fusion needs no calibration
 * between them, which is exactly what we cannot do honestly before the eval
 * harness exists.
 *
 *   YAKE         is this word behaving like a keyword *inside this note*
 *   IDF          does it distinguish this note *from the rest of the project* —
 *                the only signal that can reject "system" and "way"
 *   embedding    is it close in meaning to the note as a whole (KeyBERT)
 *
 * On top sits a structural multiplier, which is free and the strongest of the
 * lot: the title, the headings, the tags, and the display text of links that
 * point *at* this note. The last one is how the corpus names the note in its own
 * words, and no amount of NLP substitutes for it.
 */

/** Reciprocal-rank fusion constant; 60 is the value the original paper uses. */
const RRF_K = 60

export interface StructuralSignals {
  readonly title?: string
  readonly headings?: readonly string[]
  /** Bold text and inline code. */
  readonly emphasised?: readonly string[]
  readonly tags?: readonly string[]
  /** Display text of links pointing at this note. */
  readonly anchors?: readonly string[]
}

export interface TermSignals {
  readonly yake: number
  readonly idf: number
  readonly embedding: number | null
  readonly structural: number
}

export interface ScoredTerm {
  readonly text: string
  readonly lemma: string
  readonly kind: TermKind
  readonly count: number
  /** 0..1 within this document, so `minScore` means the same thing everywhere. */
  readonly score: number
  readonly signals: TermSignals
}

export interface ScoreOptions {
  /** Lemma -> number of notes containing it. */
  readonly documentFrequency?: ReadonlyMap<string, number>
  readonly corpusSize?: number
  /** Lemma -> cosine between the candidate and the note, when available. */
  readonly embeddingScores?: ReadonlyMap<string, number>
  readonly structural?: StructuralSignals
}

export function scoreCandidates(
  candidates: readonly Candidate[],
  text: string,
  options: ScoreOptions = {},
): ScoredTerm[] {
  if (candidates.length === 0) return []

  const yake = yakeScores(text)
  const structural = buildStructuralIndex(options.structural ?? {})

  const corpusSize = Math.max(1, options.corpusSize ?? 1)
  const frequencies = options.documentFrequency ?? new Map<string, number>()

  const measured = candidates.map((candidate) => {
    // YAKE is a cost; invert once, here, so everything downstream is
    // "higher is better".
    const cost = yake.score(candidate.text)
    const yakeScore = Number.isFinite(cost) ? 1 / (1 + cost) : 0

    const df = frequencies.get(candidate.lemma) ?? 0
    // Smoothed IDF. A term in every note scores zero; an unseen one is treated
    // as appearing once, so a fresh project does not rank everything equally.
    const idf = Math.log((corpusSize + 1) / (Math.max(1, df) + 0.5))

    return {
      candidate,
      yake: yakeScore,
      idf,
      embedding: options.embeddingScores?.get(candidate.lemma) ?? null,
      structural: structuralMultiplier(candidate, structural),
    }
  })

  const ranks = [
    rankOf(measured, (entry) => entry.yake),
    rankOf(measured, (entry) => entry.idf),
    ...(measured.some((entry) => entry.embedding !== null)
      ? [rankOf(measured, (entry) => entry.embedding ?? 0)]
      : []),
  ]

  const fused = measured.map((entry, index) => {
    const rrf = ranks.reduce((total, rank) => total + 1 / (RRF_K + (rank[index] ?? 0)), 0)
    return { entry, raw: rrf * entry.structural }
  })

  const max = fused.reduce((best, item) => Math.max(best, item.raw), 0)

  return fused
    .map(({ entry, raw }) => ({
      text: entry.candidate.text,
      lemma: entry.candidate.lemma,
      kind: entry.candidate.kind,
      count: entry.candidate.count,
      score: max > 0 ? raw / max : 0,
      signals: {
        yake: round(entry.yake),
        idf: round(entry.idf),
        embedding: entry.embedding === null ? null : round(entry.embedding),
        structural: round(entry.structural),
      },
    }))
    .sort((a, b) => b.score - a.score || (a.lemma < b.lemma ? -1 : 1))
}

function rankOf<T>(items: readonly T[], value: (item: T) => number): number[] {
  const order = items
    .map((item, index) => ({ index, value: value(item) }))
    .sort((a, b) => b.value - a.value)

  const ranks = new Array<number>(items.length).fill(items.length)
  order.forEach((item, position) => {
    ranks[item.index] = position + 1
  })
  return ranks
}

interface StructuralIndex {
  readonly title: Set<string>
  readonly headings: Set<string>
  readonly emphasised: Set<string>
  readonly tags: Set<string>
  readonly anchors: Map<string, number>
}

function buildStructuralIndex(signals: StructuralSignals): StructuralIndex {
  const anchors = new Map<string, number>()
  for (const anchor of signals.anchors ?? []) {
    const key = lemmaKey(anchor)
    if (key !== '') anchors.set(key, (anchors.get(key) ?? 0) + 1)
  }

  return {
    title: lemmaSet(signals.title === undefined ? [] : [signals.title]),
    headings: lemmaSet(signals.headings ?? []),
    emphasised: lemmaSet(signals.emphasised ?? []),
    tags: lemmaSet(signals.tags ?? []),
    anchors,
  }
}

function lemmaSet(values: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const value of values) {
    const key = lemmaKey(value)
    if (key === '') continue
    out.add(key)
    // Individual words too, so "Fragment stage" boosts "stage".
    for (const word of key.split(' ')) out.add(word)
  }
  return out
}

function structuralMultiplier(candidate: Candidate, index: StructuralIndex): number {
  let multiplier = 1

  if (index.title.has(candidate.lemma)) multiplier += 1
  if (index.headings.has(candidate.lemma)) multiplier += 0.5
  if (index.emphasised.has(candidate.lemma)) multiplier += 0.3
  if (index.tags.has(candidate.lemma)) multiplier += 1

  // How the rest of the corpus refers to this note, capped so one prolific
  // linker cannot decide the vocabulary on its own.
  const anchors = index.anchors.get(candidate.lemma) ?? 0
  if (anchors > 0) multiplier += Math.min(2, 1 + Math.log(anchors))

  return multiplier
}

/**
 * Drops a multi-word term contained in a better-scoring one of the same kind.
 *
 * Two rules, and the second one matters more than it looks. Keywords and phrases
 * are collapsed separately, because "fragment shader" is the phrase a reader
 * searches for while "shader" is the keyword that ties the note to its
 * neighbours. And a **single word is never collapsed into a phrase**: without
 * that, a note titled "Shaders introduction" loses "shader" entirely, which is
 * the one term its neighbours share.
 */
export function collapseNested(terms: readonly ScoredTerm[]): ScoredTerm[] {
  const kept: ScoredTerm[] = []

  for (const term of terms) {
    if (!term.lemma.includes(' ')) {
      kept.push(term)
      continue
    }

    const covered = kept.some(
      (better) => better.kind === term.kind && containsPhrase(better.lemma, term.lemma),
    )
    if (!covered) kept.push(term)
  }

  return kept
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (haystack === needle) return false
  return ` ${haystack} `.includes(` ${needle} `)
}

/**
 * Maximal marginal relevance over lemma overlap.
 *
 * Ten near-synonyms tell the reader less than five distinct terms, and lexical
 * overlap is enough to notice that without spending an embedding on it.
 */
export function diversify(terms: readonly ScoredTerm[], lambda: number, limit: number): ScoredTerm[] {
  if (limit <= 0) return []
  if (lambda >= 1 || terms.length <= 1) return terms.slice(0, limit)

  const remaining = [...terms]
  const selected: ScoredTerm[] = []

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0
    let bestValue = -Infinity

    remaining.forEach((candidate, index) => {
      const similarity = selected.reduce(
        (worst, chosen) => Math.max(worst, jaccard(candidate.lemma, chosen.lemma)),
        0,
      )
      const value = lambda * candidate.score - (1 - lambda) * similarity

      if (value > bestValue) {
        bestValue = value
        bestIndex = index
      }
    })

    selected.push(remaining[bestIndex]!)
    remaining.splice(bestIndex, 1)
  }

  return selected
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(' '))
  const right = new Set(b.split(' '))

  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1

  const union = left.size + right.size - shared
  return union === 0 ? 0 : shared / union
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
