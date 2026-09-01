import {
  collapseNested,
  diversify,
  extractCandidates,
  extractEmphasised,
  lemmaKey,
  lemmatiseNoun,
  parseMarkdown,
  scoreCandidates,
  stripFencedCode,
  tokenise,
} from '@mnemonima/core'
import type { Note, ProjectConfig, ScoredTerm } from '@mnemonima/core'
import type { Root } from 'mdast'
import {
  allLinks,
  blockedLemmas,
  listNotes,
  manualTerms,
  recomputeTermFrequencies,
  setNoteTerms,
  tagsByNote,
} from '@mnemonima/store'
import type { Db, NoteTermInput } from '@mnemonima/store'
import type { ResolvedEmbedder } from './embedder.js'

/**
 * Term extraction — DESIGN.md 7.
 *
 * Three ranked signals fused by reciprocal rank (see `core/terms/score.ts`),
 * plus two things that are not guesses at all:
 *
 *  - the **gazetteer**: every manual term is matched literally in every note,
 *    so a term the operator entered attaches regardless of what any extractor
 *    thinks of it;
 *  - the **block list**: a term ruled out stays out.
 *
 * The embedding signal is bounded on purpose. Embedding every candidate of
 * every note would cost more vectors than the chunks themselves, so only the
 * top `candidatePool` candidates — already ranked by the two free signals — are
 * embedded, and a per-run cache means a candidate shared by forty notes is
 * embedded once.
 */

export interface TermContext {
  /** Lemma -> notes containing it. The signal that rejects "system" and "way". */
  readonly documentFrequency: ReadonlyMap<string, number>
  readonly corpusSize: number
  readonly gazetteer: readonly GazetteerEntry[]
  readonly blocked: ReadonlySet<string>
  /** Note id -> display text of links pointing at it. */
  readonly anchors: ReadonlyMap<string, string[]>
  readonly tags: ReadonlyMap<string, string[]>
}

export interface GazetteerEntry {
  readonly term: string
  readonly lemma: string
  readonly words: number
}

/**
 * Everything the per-note pass needs, computed once for the whole project.
 *
 * Document frequency is counted over lemmatised body tokens rather than over
 * previously extracted terms: an extraction must not be able to reinforce its
 * own mistakes on the next run.
 */
export function buildTermContext(db: Db): TermContext {
  const notes = listNotes(db, { status: 'active', limit: -1 })
  const documentFrequency = new Map<string, number>()

  for (const note of notes) {
    const seen = new Set<string>()
    for (const token of tokenise(parseMarkdown(note.body).plain)) seen.add(lemmatiseNoun(token))
    for (const lemma of seen) documentFrequency.set(lemma, (documentFrequency.get(lemma) ?? 0) + 1)
  }

  const anchors = new Map<string, string[]>()
  for (const link of allLinks(db)) {
    if (!link.resolved || link.anchor === null) continue
    const bucket = anchors.get(link.dst) ?? []
    bucket.push(link.anchor)
    anchors.set(link.dst, bucket)
  }

  return {
    documentFrequency,
    corpusSize: notes.length,
    gazetteer: manualTerms(db).map((term) => ({
      term: term.term,
      lemma: term.lemma,
      words: term.term.trim().split(/\s+/).length,
    })),
    blocked: blockedLemmas(db),
    anchors,
    tags: tagsByNote(db),
  }
}

export interface NoteVectorSource {
  /** Mean vector of a note's chunks, when the space has one. */
  vectorFor(noteId: string): Float32Array | null
}

export interface ExtractOptions {
  readonly context: TermContext
  readonly vectors?: NoteVectorSource | undefined
  /** Shared across the run so a repeated candidate is embedded once. */
  readonly candidateVectors?: Map<string, Float32Array> | undefined
}

export interface NoteTermResult {
  readonly keywords: readonly ScoredTerm[]
  readonly phrases: readonly ScoredTerm[]
  readonly manual: readonly string[]
}

export async function extractNoteTerms(
  db: Db,
  config: ProjectConfig,
  resolved: ResolvedEmbedder | null,
  note: Note,
  options: ExtractOptions,
  tree?: Root,
): Promise<NoteTermResult> {
  const settings = config.keywords
  const { context } = options

  const parsed = parseMarkdown(note.body, tree)
  const prose = parsed.plain

  // The gazetteer runs whatever the automatic settings say: a manual term is a
  // decision, not a suggestion.
  const manual = matchGazetteer(prose, context.gazetteer)

  let auto: ScoredTerm[] = []

  if (settings.autoEnabled) {
    const candidates = extractCandidates(prose).filter(
      (candidate) => !context.blocked.has(candidate.lemma),
    )

    const structural = {
      title: note.title,
      headings: parsed.headings.map((heading) => heading.text),
      // Emphasis has to be read from the source: the plain rendering is where
      // the markers that carry the signal have already been removed.
      emphasised: extractEmphasised(note.body),
      tags: context.tags.get(note.id) ?? [],
      anchors: settings.useLinkAnchors ? (context.anchors.get(note.id) ?? []) : [],
    }

    const preranked = scoreCandidates(candidates, prose, {
      documentFrequency: context.documentFrequency,
      corpusSize: context.corpusSize,
      structural,
    })

    const embeddingScores = await embedCandidates(
      resolved,
      note,
      preranked.slice(0, candidatePool(config)),
      options,
    )

    auto =
      embeddingScores === null
        ? preranked
        : scoreCandidates(candidates, prose, {
            documentFrequency: context.documentFrequency,
            corpusSize: context.corpusSize,
            structural,
            embeddingScores,
          })
  }

  const manualLemmas = new Set(manual.map((term) => lemmaKey(term)))
  const usable = collapseNested(
    auto.filter((term) => term.score >= settings.minScore && !manualLemmas.has(term.lemma)),
  )

  const keywords = diversify(
    usable.filter((term) => term.kind === 'keyword'),
    0.7,
    settings.topNKeywords,
  )
  const phrases = diversify(
    usable.filter((term) => term.kind === 'phrase'),
    0.7,
    settings.topNPhrases,
  )

  const entries: NoteTermInput[] = [
    ...manual.map((term) => ({
      term,
      lemma: lemmaKey(term),
      kind: (term.trim().split(/\s+/).length >= 3 ? 'phrase' : 'keyword') as NoteTermInput['kind'],
      score: 1,
      source: 'manual' as const,
    })),
    ...[...keywords, ...phrases].map((term) => ({
      term: term.text,
      lemma: term.lemma,
      kind: term.kind,
      score: term.score,
      source: 'auto' as const,
    })),
  ]

  setNoteTerms(db, note.id, entries)
  return { keywords, phrases, manual }
}

function candidatePool(config: ProjectConfig): number {
  return Math.max(config.keywords.topNKeywords + config.keywords.topNPhrases, 25)
}

/**
 * KeyBERT: cosine between the note and each candidate.
 *
 * The note is represented by the mean of its own chunk vectors, which is free —
 * they are already in the database — and more faithful than embedding a
 * truncated body.
 */
async function embedCandidates(
  resolved: ResolvedEmbedder | null,
  note: Note,
  candidates: readonly ScoredTerm[],
  options: ExtractOptions,
): Promise<Map<string, number> | null> {
  if (resolved === null || options.vectors === undefined || candidates.length === 0) return null

  const noteVector = options.vectors.vectorFor(note.id)
  if (noteVector === null) return null

  const cache = options.candidateVectors ?? new Map<string, Float32Array>()
  const missing = candidates.filter((candidate) => !cache.has(candidate.lemma))

  if (missing.length > 0) {
    const vectors = await resolved.embedder.embedDocuments(missing.map((entry) => entry.text))
    missing.forEach((entry, index) => {
      const vector = vectors[index]
      if (vector !== undefined) cache.set(entry.lemma, vector)
    })
  }

  const scores = new Map<string, number>()
  for (const candidate of candidates) {
    const vector = cache.get(candidate.lemma)
    if (vector === undefined) continue
    scores.set(candidate.lemma, dotProduct(noteVector, vector))
  }

  return scores
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += (a[i] ?? 0) * (b[i] ?? 0)
  return total
}

/**
 * Literal matching of manual terms.
 *
 * A linear scan per term rather than Aho–Corasick: at a few hundred manual
 * terms against a note of a few kilobytes this is microseconds, and the
 * automaton is worth building only once the vocabulary is large enough for the
 * difference to be measurable.
 */
export function matchGazetteer(text: string, gazetteer: readonly GazetteerEntry[]): string[] {
  const haystack = text.toLowerCase()
  const found: string[] = []

  for (const entry of gazetteer) {
    const needle = entry.term.toLowerCase()
    let index = haystack.indexOf(needle)

    while (index >= 0) {
      if (isWholeWord(haystack, index, needle.length)) {
        found.push(entry.term)
        break
      }
      index = haystack.indexOf(needle, index + 1)
    }
  }

  return found
}

function isWholeWord(text: string, index: number, length: number): boolean {
  const before = index === 0 ? '' : text[index - 1]
  const after = text[index + length] ?? ''
  return !/[a-z0-9]/.test(before ?? '') && !/[a-z0-9]/.test(after)
}

export function finishTermPass(db: Db): void {
  recomputeTermFrequencies(db)
}
