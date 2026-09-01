import { isStopword, splitSentences, tokenise } from './tokens.js'

/**
 * YAKE — Campos et al., "YAKE! Keyword extraction from single documents using
 * multiple local features" (2020).
 *
 * Unsupervised and single-document: it needs no corpus and no training, which
 * is what makes it the right partner for the corpus-wide IDF signal. Five
 * features per word:
 *
 *   casing       capitalised or acronym use, normalised by frequency
 *   position     earlier in the document is more likely to be a keyword
 *   frequency    term frequency against the mean and spread of the document
 *   relatedness  how many *distinct* neighbours a word has — a word that sits
 *                next to everything is behaving like a stop word, whatever the
 *                stop list says
 *   spread       how many sentences it appears in
 *
 * The paper's score is a cost: **lower is better**. `yakeScores` returns it
 * unchanged so the arithmetic stays recognisable against the paper; the fusion
 * inverts it once, in one place.
 *
 * Implemented here rather than taken from npm because there is no maintained
 * JavaScript port, and a dead dependency in the middle of the ranking pipeline
 * is worse than a hundred lines we own.
 */

export interface YakeResult {
  /** Word -> cost. Lower is a better keyword. */
  readonly words: ReadonlyMap<string, number>
  /** Cost of a whole phrase, derived from its words. */
  score(phrase: string): number
}

interface WordStats {
  tf: number
  capitalised: number
  acronym: number
  sentences: Set<number>
  firstOffset: number
  left: Map<string, number>
  right: Map<string, number>
}

export function yakeScores(text: string): YakeResult {
  const sentences = splitSentences(text)
  const stats = new Map<string, WordStats>()

  let offset = 0
  let total = 0

  sentences.forEach((sentence, index) => {
    // Raw split keeps the original casing, which two of the features need.
    const raw = sentence.split(/[^A-Za-z0-9_+#.-]+/).filter((word) => word.length > 1)
    const words = raw.map((word) => word.toLowerCase())

    words.forEach((word, position) => {
      total += 1
      offset += 1

      const entry =
        stats.get(word) ??
        ({
          tf: 0,
          capitalised: 0,
          acronym: 0,
          sentences: new Set<number>(),
          firstOffset: offset,
          left: new Map<string, number>(),
          right: new Map<string, number>(),
        } satisfies WordStats)

      const original = raw[position] ?? word
      entry.tf += 1
      entry.sentences.add(index)
      if (/^[A-Z][a-z]/.test(original) && position > 0) entry.capitalised += 1
      if (/^[A-Z0-9_]{2,}$/.test(original)) entry.acronym += 1

      const before = words[position - 1]
      if (before !== undefined) entry.left.set(before, (entry.left.get(before) ?? 0) + 1)

      const after = words[position + 1]
      if (after !== undefined) entry.right.set(after, (entry.right.get(after) ?? 0) + 1)

      stats.set(word, entry)
    })
  })

  const contentFrequencies = [...stats.entries()]
    .filter(([word]) => !isStopword(word))
    .map(([, entry]) => entry.tf)

  const mean = average(contentFrequencies)
  const deviation = standardDeviation(contentFrequencies, mean)
  const maxTf = contentFrequencies.reduce((max, value) => Math.max(max, value), 1)

  const words = new Map<string, number>()

  for (const [word, entry] of stats) {
    const casing = Math.max(entry.capitalised, entry.acronym) / (1 + Math.log(entry.tf))
    const position = Math.log(Math.log(3 + medianSentence(entry, sentences.length)))
    const frequency = entry.tf / Math.max(1e-9, mean + deviation)

    const leftDispersion = entry.left.size / Math.max(1, sum([...entry.left.values()]))
    const rightDispersion = entry.right.size / Math.max(1, sum([...entry.right.values()]))
    const relatedness = 1 + (leftDispersion + rightDispersion) * (entry.tf / maxTf)

    const spread = entry.sentences.size / Math.max(1, sentences.length)

    const cost =
      (relatedness * position) /
      Math.max(1e-9, casing + frequency / relatedness + spread / relatedness)

    words.set(word, cost)
  }

  return {
    words,
    score(phrase: string): number {
      const parts = tokenise(phrase)
      if (parts.length === 0) return Number.POSITIVE_INFINITY

      let product = 1
      let total = 0

      for (const part of parts) {
        const cost = words.get(part) ?? 1
        product *= cost
        total += cost
      }

      // The paper's n-gram rule: the product of the word costs, damped by how
      // often the whole phrase occurs and by the sum of its parts.
      const occurrences = countOccurrences(text, phrase)
      return product / (Math.max(1, occurrences) * (1 + total))
    },
  }
}

function medianSentence(entry: WordStats, sentences: number): number {
  const positions = [...entry.sentences].sort((a, b) => a - b)
  const middle = positions[Math.floor(positions.length / 2)] ?? 0
  return sentences === 0 ? 0 : middle
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 1 : sum(values) / values.length
}

function standardDeviation(values: readonly number[], mean: number): number {
  if (values.length === 0) return 0
  const variance = sum(values.map((value) => (value - mean) ** 2)) / values.length
  return Math.sqrt(variance)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function countOccurrences(text: string, phrase: string): number {
  const haystack = text.toLowerCase()
  const needle = phrase.toLowerCase()
  if (needle === '') return 0

  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
