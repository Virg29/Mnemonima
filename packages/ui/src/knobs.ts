/**
 * The tuning knobs of DESIGN.md 8.5 and 7.3, with the ranges a slider needs.
 *
 * The ranges live here rather than in the configuration because they are a
 * presentation decision, not a rule: nothing stops `config set` from putting
 * `graph.boost` at 5, and the daemon would honour it. A slider still has to
 * stop somewhere, and these are the ends of the interval worth exploring.
 *
 * The paths are the same dotted paths `mnemonima config set` takes, which is
 * what lets the lab send them as a per-query override and then save the ones
 * that turned out to be right.
 */

export interface Knob {
  readonly path: string
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  readonly hint?: string
}

export interface KnobGroup {
  readonly title: string
  readonly hint: string
  readonly knobs: readonly Knob[]
}

export const KNOB_GROUPS: readonly KnobGroup[] = [
  {
    title: 'Text and vector',
    hint: 'How much of a chunk score comes from BM25 and how much from cosine.',
    knobs: [
      { path: 'search.hybridWeights.text', label: 'text', min: 0, max: 1, step: 0.05 },
      { path: 'search.hybridWeights.vector', label: 'vector', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: 'Strategies',
    hint: 'Fine chunks catch precise facts, coarse ones catch the sense of a passage.',
    knobs: [
      { path: 'search.strategyWeights.fine', label: 'fine', min: 0, max: 2, step: 0.05 },
      { path: 'search.strategyWeights.coarse', label: 'coarse', min: 0, max: 2, step: 0.05 },
    ],
  },
  {
    title: 'Fusion',
    hint: 'Passages against metadata, and the reward for a note that matched in several places.',
    knobs: [
      { path: 'search.fusion.chunk', label: 'chunk', min: 0, max: 1, step: 0.05 },
      { path: 'search.fusion.meta', label: 'meta', min: 0, max: 1, step: 0.05 },
      {
        path: 'search.fusion.lambdaMultiChunk',
        label: 'multi-chunk',
        min: 0,
        max: 1,
        step: 0.05,
        hint: 'Logarithmic, so five matching chunks beat one without winning on length alone.',
      },
    ],
  },
  {
    title: 'Metadata boosts',
    hint: 'What a match in each field is worth. Manual terms are deliberately above automatic ones.',
    knobs: [
      { path: 'search.boost.title', label: 'title', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.aliases', label: 'aliases', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.keywordsManual', label: 'keywords (manual)', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.keywordsAuto', label: 'keywords (auto)', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.phrasesManual', label: 'phrases (manual)', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.phrasesAuto', label: 'phrases (auto)', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.outline', label: 'outline', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.text', label: 'text', min: 0, max: 5, step: 0.1 },
      { path: 'search.boost.code', label: 'code', min: 0, max: 5, step: 0.1 },
    ],
  },
  {
    title: 'Graph',
    hint: 'A note whose neighbours also scored is probably in the middle of a relevant cluster.',
    knobs: [
      {
        path: 'search.graph.boost',
        label: 'boost',
        min: 0,
        max: 1,
        step: 0.01,
        hint: 'Divided by degree, so a hub is not boosted by every query.',
      },
      { path: 'search.graph.expandDepth', label: 'expand depth', min: 0, max: 3, step: 1 },
      {
        path: 'search.graph.expandMinVotes',
        label: 'expand votes',
        min: 1,
        max: 5,
        step: 1,
        hint: 'How many hits must point at a note before it is added on their word.',
      },
    ],
  },
  {
    title: 'Diversity',
    hint: 'Keeps the top from being five chunks of one note.',
    knobs: [{ path: 'search.mmr.lambda', label: 'MMR lambda', min: 0, max: 1, step: 0.05 }],
  },
  {
    title: 'Limits',
    hint: 'How wide the candidate set is, and how much of it survives.',
    knobs: [
      { path: 'search.limits.candidateK', label: 'candidates', min: 10, max: 500, step: 10 },
      { path: 'search.limits.resultK', label: 'results', min: 1, max: 50, step: 1 },
      {
        path: 'search.limits.minSimilarity',
        label: 'min similarity',
        min: 0,
        max: 1,
        step: 0.01,
        hint: 'A floor on the cosine. With gte-small it filters nothing below about 0.6.',
      },
    ],
  },
  {
    title: 'Terms',
    hint: 'How much the automatically extracted vocabulary counts for. Manual terms are unaffected.',
    knobs: [
      {
        path: 'keywords.autoWeight',
        label: 'auto weight',
        min: 0,
        max: 1,
        step: 0.05,
        hint: 'At zero the automatic fields drop out of the metadata search entirely.',
      },
      { path: 'keywords.topNKeywords', label: 'top keywords', min: 0, max: 30, step: 1 },
      { path: 'keywords.topNPhrases', label: 'top phrases', min: 0, max: 20, step: 1 },
      { path: 'keywords.minScore', label: 'min score', min: 0, max: 1, step: 0.05 },
    ],
  },
]

/** Reads a dotted path out of the configuration object the daemon returned. */
export function valueAt(config: Record<string, unknown>, path: string): number {
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
