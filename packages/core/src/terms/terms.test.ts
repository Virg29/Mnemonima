import { describe, expect, it } from 'vitest'
import { extractCandidates } from './candidates.js'
import { collapseNested, diversify, scoreCandidates } from './score.js'
import { isStopword, lemmaKey, lemmatiseNoun, splitSentences, tokenise } from './tokens.js'
import { yakeScores } from './yake.js'

const SHADERS = [
  'A fragment shader runs once per rasterized pixel and writes a single colour to the framebuffer.',
  'The rasterizer decides which pixels a triangle covers, and the fragment shader decides the colour.',
  'Interpolated attributes arrive from the vertex stage.',
].join(' ')

describe('tokens', () => {
  it('keeps the punctuation technical identifiers rely on', () => {
    expect(tokenise('gl_FragColor and vec4 in C# code')).toEqual([
      'gl_fragcolor',
      'and',
      'vec4',
      'in',
      'c#',
      'code',
    ])
  })

  it('singularises words the dictionary knows', () => {
    expect(lemmatiseNoun('buffers')).toBe('buffer')
    expect(lemmatiseNoun('pixels')).toBe('pixel')
  })

  it('falls back to plural rules for technical vocabulary', () => {
    // wink-lemmatizer does not know these, and leaving them plural would split
    // one term into two.
    expect(lemmatiseNoun('shaders')).toBe('shader')
    expect(lemmatiseNoun('rasterizers')).toBe('rasterizer')
    expect(lemmatiseNoun('queries')).toBe('query')
    expect(lemmatiseNoun('meshes')).toBe('mesh')
  })

  it('leaves the shapes those rules would damage', () => {
    for (const word of ['analysis', 'bias', 'status', 'chaos', 'gloss']) {
      expect(lemmatiseNoun(word)).toBe(word)
    }
  })

  it('builds a lemma key for a whole phrase', () => {
    expect(lemmaKey('Fragment Shaders')).toBe('fragment shader')
    expect(lemmaKey('  ')).toBe('')
  })

  it('treats function words and empty nouns as stop words', () => {
    expect(isStopword('the')).toBe(true)
    expect(isStopword('thing')).toBe(true)
    expect(isStopword('introduction')).toBe(true)
    expect(isStopword('shader')).toBe(false)
  })

  it('splits sentences on terminators and blank lines', () => {
    expect(splitSentences('One. Two!\n\nThree')).toEqual(['One.', 'Two!', 'Three'])
  })
})

describe('candidates', () => {
  it('proposes noun phrases and their head nouns', () => {
    const lemmas = extractCandidates(SHADERS).map((candidate) => candidate.lemma)

    expect(lemmas).toContain('fragment shader')
    expect(lemmas).toContain('shader')
    expect(lemmas).toContain('rasterized pixel')
  })

  it('does not propose verbs or function words', () => {
    const lemmas = extractCandidates(SHADERS).map((candidate) => candidate.lemma)

    expect(lemmas).not.toContain('runs')
    expect(lemmas).not.toContain('decides')
    expect(lemmas).not.toContain('the')
  })

  it('stores a single word as its lemma and a phrase as written', () => {
    const candidates = extractCandidates('Shaders and uniform buffers matter.')

    expect(candidates.find((entry) => entry.lemma === 'shader')?.text).toBe('shader')
    expect(candidates.find((entry) => entry.lemma === 'uniform buffer')?.text).toBe(
      'uniform buffers',
    )
  })

  it('counts repeats rather than duplicating them', () => {
    const shader = extractCandidates(SHADERS).find((entry) => entry.lemma === 'fragment shader')

    expect(shader?.count).toBe(2)
    expect(shader?.sentences).toBe(2)
  })

  it('returns nothing for text with no noun phrase', () => {
    expect(extractCandidates('and then it did')).toEqual([])
  })
})

describe('yake', () => {
  it('scores a repeated content word better than a scattered one', () => {
    const scores = yakeScores(SHADERS)

    // Lower is better: the paper's score is a cost.
    expect(scores.score('shader')).toBeLessThan(scores.score('triangle'))
  })

  it('gives an unknown phrase a finite cost rather than throwing', () => {
    expect(Number.isFinite(yakeScores(SHADERS).score('quantum chromodynamics'))).toBe(true)
  })

  it('handles an empty document', () => {
    expect(yakeScores('').words.size).toBe(0)
  })
})

describe('scoring', () => {
  const candidates = extractCandidates(SHADERS)

  it('normalises scores into 0..1 so minScore means one thing', () => {
    const scored = scoreCandidates(candidates, SHADERS)

    expect(scored[0]?.score).toBeCloseTo(1, 6)
    expect(scored.every((term) => term.score >= 0 && term.score <= 1)).toBe(true)
  })

  it('demotes a term that appears in every note', () => {
    const everywhere = new Map([
      ['shader', 100],
      ['framebuffer', 1],
    ])

    const scored = scoreCandidates(candidates, SHADERS, {
      documentFrequency: everywhere,
      corpusSize: 100,
    })

    const shader = scored.find((term) => term.lemma === 'shader')
    const framebuffer = scored.find((term) => term.lemma === 'framebuffer')

    expect(shader?.signals.idf).toBeLessThan(framebuffer?.signals.idf ?? 0)
  })

  it('boosts what the title, the headings and the incoming links call it', () => {
    const plain = scoreCandidates(candidates, SHADERS)
    const boosted = scoreCandidates(candidates, SHADERS, {
      structural: { title: 'Framebuffer', anchors: ['framebuffer', 'framebuffer'] },
    })

    const before = plain.find((term) => term.lemma === 'framebuffer')?.signals.structural ?? 0
    const after = boosted.find((term) => term.lemma === 'framebuffer')?.signals.structural ?? 0

    expect(before).toBe(1)
    expect(after).toBeGreaterThan(2)
  })

  it('uses the embedding signal when it is supplied', () => {
    const withoutVectors = scoreCandidates(candidates, SHADERS)
    const withVectors = scoreCandidates(candidates, SHADERS, {
      embeddingScores: new Map([['framebuffer', 0.99]]),
    })

    expect(withoutVectors[0]?.signals.embedding).toBeNull()
    expect(withVectors.find((term) => term.lemma === 'framebuffer')?.signals.embedding).toBe(0.99)
  })
})

describe('collapseNested', () => {
  const term = (lemma: string, score: number, kind: 'keyword' | 'phrase' = 'keyword') => ({
    text: lemma,
    lemma,
    kind,
    count: 1,
    score,
    signals: { yake: 0, idf: 0, embedding: null, structural: 1 },
  })

  it('drops a phrase contained in a better one', () => {
    const kept = collapseNested([
      term('standard layout rule', 1, 'phrase'),
      term('layout rule', 0.5, 'phrase'),
    ])

    expect(kept.map((entry) => entry.lemma)).toEqual(['standard layout rule'])
  })

  it('never collapses a single word into a phrase', () => {
    // Otherwise a note titled "Shaders introduction" loses "shader" entirely.
    const kept = collapseNested([term('shader introduction', 1), term('shader', 0.9)])

    expect(kept.map((entry) => entry.lemma)).toEqual(['shader introduction', 'shader'])
  })

  it('keeps a phrase and its head noun apart across kinds', () => {
    const kept = collapseNested([term('fragment shader stage', 1, 'phrase'), term('shader', 0.8)])

    expect(kept).toHaveLength(2)
  })
})

describe('diversify', () => {
  const term = (lemma: string, score: number) => ({
    text: lemma,
    lemma,
    kind: 'keyword' as const,
    count: 1,
    score,
    signals: { yake: 0, idf: 0, embedding: null, structural: 1 },
  })

  it('trades relevance for distinctness as lambda falls', () => {
    const terms = [term('fragment shader', 1), term('fragment stage', 0.9), term('compost bed', 0.5)]

    // At 0.5 the near-repeat still wins on its own score: half a point of
    // relevance beats a third of a point of overlap.
    expect(diversify(terms, 0.5, 2).map((entry) => entry.lemma)).toEqual([
      'fragment shader',
      'fragment stage',
    ])

    // Weight distinctness more and the unrelated term takes the second slot.
    expect(diversify(terms, 0.3, 2).map((entry) => entry.lemma)).toEqual([
      'fragment shader',
      'compost bed',
    ])
  })

  it('honours the limit and returns the top slice when lambda is 1', () => {
    const terms = [term('a', 1), term('b', 0.9), term('c', 0.8)]

    expect(diversify(terms, 1, 2).map((entry) => entry.lemma)).toEqual(['a', 'b'])
    expect(diversify(terms, 0.5, 0)).toEqual([])
  })
})
