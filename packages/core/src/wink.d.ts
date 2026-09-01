/**
 * Minimal ambient types for the two wink packages, which ship no declarations.
 *
 * Only the surface we actually call is declared, so a change in what we use
 * shows up here as a compile error rather than as `any` leaking through the
 * term pipeline.
 */

declare module 'wink-pos-tagger' {
  interface Token {
    readonly value: string
    /** Penn Treebank tag. */
    readonly pos: string
    readonly tag: string
    readonly lemma?: string
    readonly normal?: string
  }

  interface Tagger {
    tagSentence(sentence: string): Token[]
    tagRawTokens(tokens: { value: string; tag: string }[]): Token[]
    defineConfig(config: Record<string, boolean>): unknown
  }

  export default function posTagger(): Tagger
}

declare module 'wink-lemmatizer' {
  interface Lemmatizer {
    noun(word: string): string
    verb(word: string): string
    adjective(word: string): string
  }

  const lemmatizer: Lemmatizer
  export default lemmatizer
}
