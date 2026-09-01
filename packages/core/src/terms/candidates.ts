import posTagger from 'wink-pos-tagger'
import type { TermKind } from '../types.js'
import { isStopword, lemmaKey, splitSentences } from './tokens.js'

/**
 * Candidate generation — DESIGN.md 7.1, step one.
 *
 * Part-of-speech tagging rather than a dictionary of nouns. The operator's
 * original idea was a noun list, but a list cannot tell "render" the verb from
 * "render" the noun, and it cannot see that "fragment shader" is one thing.
 * A tagger reads the word *in context*, which is what makes the difference.
 *
 * The pattern is the standard one for terminology extraction: a run of
 * adjectives, past participles and nouns ending in a noun. "standard layout
 * rules" and "rasterized pixel" survive; "runs once per" does not.
 *
 * Candidates are only proposals. Which of them is worth keeping is decided by
 * statistics in `score.ts`, never here.
 */

const tagger = posTagger()

/** Penn Treebank tags that may appear inside a noun phrase. */
const MODIFIER = new Set(['JJ', 'JJR', 'JJS', 'VBN', 'NN', 'NNS', 'NNP', 'NNPS'])
const HEAD = new Set(['NN', 'NNS', 'NNP', 'NNPS'])

export interface Candidate {
  /** Surface form as written, whitespace normalised. */
  readonly text: string
  /** Lemmatised key: what decides that two surface forms are the same term. */
  readonly lemma: string
  readonly words: number
  readonly kind: TermKind
  /** Occurrences in the document. */
  readonly count: number
  /** Index of the first sentence it appears in, for the positional feature. */
  readonly firstSentence: number
  /** Sentences it appears in at all, for the spread feature. */
  readonly sentences: number
}

export interface CandidateOptions {
  /** Longest phrase to propose. Beyond four words a phrase is a sentence. */
  readonly maxWords?: number
}

export function extractCandidates(text: string, options: CandidateOptions = {}): Candidate[] {
  const maxWords = options.maxWords ?? 4
  const sentences = splitSentences(text)

  interface Accumulator {
    text: string
    lemma: string
    words: number
    count: number
    firstSentence: number
    sentences: Set<number>
  }

  const found = new Map<string, Accumulator>()

  const record = (surface: string, index: number): void => {
    const lemma = lemmaKey(surface)
    if (lemma === '') return

    const existing = found.get(lemma)
    if (existing === undefined) {
      found.set(lemma, {
        // A single word is stored as its lemma: "shaders" and "shader" are the
        // same term, and the singular is the form a reader would search for.
        // Phrases keep their surface form, which reads better than a phrase
        // with every word singularised.
        text: surface.includes(' ') ? surface : lemma,
        lemma,
        words: surface.split(/\s+/).length,
        count: 1,
        firstSentence: index,
        sentences: new Set([index]),
      })
      return
    }

    existing.count += 1
    existing.sentences.add(index)
  }

  sentences.forEach((sentence, index) => {
    const tagged = tagger.tagSentence(sentence)
    let run: { value: string; pos: string }[] = []

    const flush = (): void => {
      // Trim modifiers that are not followed by a head: "single" alone is not a
      // term, "single colour" is.
      while (run.length > 0 && !HEAD.has(run[run.length - 1]?.pos ?? '')) run.pop()
      if (run.length === 0) return

      for (const span of spansOf(run, maxWords)) {
        record(span.map((token) => token.value).join(' '), index)
      }
      run = []
    }

    for (const token of tagged) {
      const pos = token.pos
      const value = token.value

      if (MODIFIER.has(pos) && !isStopword(value)) {
        run.push({ value, pos })
        continue
      }

      flush()
    }

    flush()
  })

  return [...found.values()]
    .map((entry) => ({
      text: entry.text,
      lemma: entry.lemma,
      words: entry.words,
      kind: (entry.words >= 3 ? 'phrase' : 'keyword') as TermKind,
      count: entry.count,
      firstSentence: entry.firstSentence,
      sentences: entry.sentences.size,
    }))
    .filter((candidate) => candidate.lemma.length > 2)
}

/**
 * The whole noun phrase plus its head noun.
 *
 * Both are wanted: "fragment shader" is the phrase a reader would search for,
 * and "shader" is the keyword that ties the note to its neighbours. Everything
 * in between is noise, so the middle spans are not proposed.
 */
function spansOf(
  run: readonly { value: string; pos: string }[],
  maxWords: number,
): { value: string; pos: string }[][] {
  const trimmed = run.slice(-maxWords)
  const spans: { value: string; pos: string }[][] = [trimmed]

  const head = trimmed[trimmed.length - 1]
  if (trimmed.length > 1 && head !== undefined) spans.push([head])

  // A two-word phrase inside a longer run is usually the useful unit.
  if (trimmed.length > 2) spans.push(trimmed.slice(-2))

  return spans
}
