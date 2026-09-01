import lemmatizer from 'wink-lemmatizer'

/**
 * Tokenisation, stop words and lemmatisation for term extraction.
 *
 * Everything here is deliberately small and dependency-light: the expensive
 * signal comes from statistics over the corpus and from the embedder, not from
 * clever morphology.
 */

/**
 * Function words plus the handful of near-empty nouns that any noun-phrase
 * extractor otherwise proposes for every note ever written.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
  'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each',
  'either', 'else', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her',
  'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'however', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'itself', 'just', 'let', 'like', 'may', 'me', 'might', 'more', 'most',
  'must', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or',
  'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'per', 'rather', 'same',
  'shall', 'she', 'should', 'so', 'some', 'still', 'such', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'therefore', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'whether', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours', 'yourself', 'yourselves',
  // Nouns so general that they describe nothing.
  'case', 'cases', 'end', 'example', 'examples', 'fact', 'kind', 'lot', 'matter', 'means',
  'part', 'parts', 'point', 'points', 'something', 'sort', 'stuff', 'thing', 'things', 'time',
  'times', 'way', 'ways',
  // Words that name a section rather than a subject. They sit in titles and
  // headings, where the structural multiplier would otherwise push them to the
  // top of every note that has one.
  'appendix', 'conclusion', 'introduction', 'overview', 'summary',
])

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase())
}

/** Words, keeping the internal punctuation that technical identifiers rely on. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/)
    .map((token) => token.replace(/^[.\-_]+|[.\-_]+$/g, ''))
    .filter((token) => token.length > 1 && /[a-z]/.test(token))
}

const lemmaCache = new Map<string, string>()

/**
 * Singularises a noun.
 *
 * wink-lemmatizer only knows words in its dictionary, and technical vocabulary
 * mostly is not: it turns "buffers" into "buffer" but leaves "shaders" alone.
 * The fallback applies the regular English plural rules to whatever it did not
 * recognise, while leaving the shapes those rules would damage.
 */
export function lemmatiseNoun(word: string): string {
  const cached = lemmaCache.get(word)
  if (cached !== undefined) return cached

  const value = computeLemma(word)
  // Bounded: a corpus scan sees millions of tokens but only tens of thousands
  // of distinct ones, and an unbounded map here would outlive its usefulness.
  if (lemmaCache.size < 50_000) lemmaCache.set(word, value)
  return value
}

function computeLemma(word: string): string {
  const lower = word.toLowerCase()
  const known = lemmatizer.noun(lower)
  if (known !== lower) return known

  if (lower.length < 4) return lower
  if (/(ss|us|is|as|os)$/.test(lower)) return lower

  if (/[^aeiou]ies$/.test(lower)) return `${lower.slice(0, -3)}y`
  if (/(ch|sh|s|x|z)es$/.test(lower)) return lower.slice(0, -2)
  if (/[^s]s$/.test(lower)) return lower.slice(0, -1)

  return lower
}

/** Lemma key of a whole phrase: what decides that two surface forms are one term. */
export function lemmaKey(phrase: string): string {
  return tokenise(phrase).map(lemmatiseNoun).join(' ')
}

/**
 * Sentence split, good enough for the positional features of YAKE. Abbreviation
 * handling is not worth it here: a wrong split shifts a score slightly, it never
 * changes what a term is.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-*#>|])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}
