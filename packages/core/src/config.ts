/**
 * Project configuration. Persisted as JSON in the `meta` table under the
 * `config` key. Mirrors DESIGN.md 7.3, 8.5 and 12.
 */

import type { LanguageGateMode } from './language.js'

export interface LanguageConfig {
  gate: LanguageGateMode
  /** Fenced code blocks may legitimately contain non-English string literals. */
  gateCodeBlocks: boolean
}

export interface ModelConfig {
  active: string
  batchSize: number
}

export interface ChunkStrategyConfig {
  targetTokens: number
  /** Fraction of the target window repeated between neighbours, 0..1. */
  overlap: number
  minTokens: number
}

export interface ChunkingConfig {
  strategies: {
    fine: ChunkStrategyConfig
    coarse: ChunkStrategyConfig
  }
  /** Prepend the heading breadcrumb to a chunk before embedding it. */
  prependHeadings: boolean
  indexCode: boolean
}

export interface KeywordsConfig {
  autoEnabled: boolean
  topNKeywords: number
  topNPhrases: number
  minScore: number
  /** Multiplier of automatic terms relative to manual ones when ranking. */
  autoWeight: number
  promoteMinDf: number
  promoteMinScore: number
  useLinkAnchors: boolean
}

export interface SearchConfig {
  mode: 'hybrid' | 'semantic' | 'lexical' | 'exact' | 'graph' | 'id'
  hybridWeights: { text: number; vector: number }
  strategyWeights: { fine: number; coarse: number }
  fusion: { chunk: number; meta: number; lambdaMultiChunk: number }
  boost: {
    title: number
    aliases: number
    keywordsManual: number
    keywordsAuto: number
    phrasesManual: number
    phrasesAuto: number
    outline: number
    text: number
    code: number
  }
  graph: { boost: number; expandDepth: number; expandMinVotes: number }
  rerank: {
    recencyHalfLifeDays: number
    degreePrior: number
    /** Cross-encoder reranking is post-MVP (DESIGN.md 14.2). */
    crossEncoder: boolean
  }
  mmr: { enabled: boolean; lambda: number }
  expand: { synonyms: boolean }
  limits: { candidateK: number; resultK: number; minSimilarity: number }
  tolerance: number
}

export interface LinksConfig {
  /** Mirror derived backlinks into exported frontmatter. */
  materializeBacklinks: boolean
}

/**
 * Re-indexing without being asked.
 *
 * A note that has been written but not indexed is invisible to search, so
 * every writer had to remember to run one. The daemon sees the writes, so it
 * can do it: a burst of them debounces into a single incremental run, which
 * re-embeds only the chunks whose text actually changed.
 */
export interface IndexConfig {
  /** Re-index what changed after a write through the daemon. */
  auto: boolean
  /** How long to wait for the writing to stop before starting. */
  debounceSec: number
}

export interface ExportConfig {
  enabled: boolean
  /**
   * Where the markdown goes, relative to the directory the project was created
   * with — so `docs/notes` means `<project>/docs/notes`. The default says
   * `.mnemonima/` out loud rather than hiding it in the resolution, because a
   * relative path that silently landed somewhere else was how an export aimed
   * at a repository ended up inside the ignored directory.
   */
  path: string
  debounceSec: number
  commit: boolean
  /** Pushing is never automatic. */
  push: boolean
}

export interface DaemonConfig {
  /** Start a daemon automatically when a command would benefit from one. */
  autoStart: boolean
  idleTimeoutMin: number
  maxHotProjects: number
  projectIdleMin: number
  /** 0 means "pick a free port". */
  port: number
}

export interface McpConfig {
  /** Hard delete, space removal and full re-index with a different model. */
  allowDestructive: boolean
}

export interface ProjectConfig {
  language: LanguageConfig
  model: ModelConfig
  chunking: ChunkingConfig
  keywords: KeywordsConfig
  search: SearchConfig
  links: LinksConfig
  index: IndexConfig
  export: ExportConfig
  daemon: DaemonConfig
  mcp: McpConfig
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  language: { gate: 'strict', gateCodeBlocks: false },
  model: { active: 'Supabase/gte-small', batchSize: 32 },
  chunking: {
    strategies: {
      fine: { targetTokens: 120, overlap: 0, minTokens: 30 },
      coarse: { targetTokens: 400, overlap: 0.15, minTokens: 50 },
    },
    prependHeadings: true,
    indexCode: true,
  },
  keywords: {
    autoEnabled: true,
    topNKeywords: 12,
    topNPhrases: 6,
    minScore: 0.35,
    autoWeight: 1,
    promoteMinDf: 3,
    promoteMinScore: 0.5,
    useLinkAnchors: true,
  },
  search: {
    mode: 'hybrid',
    hybridWeights: { text: 0.5, vector: 0.5 },
    strategyWeights: { fine: 1, coarse: 0.9 },
    fusion: { chunk: 0.7, meta: 0.3, lambdaMultiChunk: 0.15 },
    boost: {
      title: 3,
      aliases: 2.5,
      keywordsManual: 2.5,
      keywordsAuto: 1.5,
      phrasesManual: 2,
      phrasesAuto: 1.2,
      outline: 1.5,
      text: 1,
      code: 0.5,
    },
    graph: { boost: 0.15, expandDepth: 1, expandMinVotes: 2 },
    rerank: { recencyHalfLifeDays: 0, degreePrior: 0, crossEncoder: false },
    mmr: { enabled: true, lambda: 0.7 },
    expand: { synonyms: true },
    limits: { candidateK: 150, resultK: 10, minSimilarity: 0.25 },
    tolerance: 1,
  },
  links: { materializeBacklinks: false },
  index: { auto: true, debounceSec: 30 },
  export: { enabled: true, path: '.mnemonima/export', debounceSec: 60, commit: true, push: false },
  daemon: { autoStart: true, idleTimeoutMin: 30, maxHotProjects: 2, projectIdleMin: 15, port: 0 },
  mcp: { allowDestructive: false },
}

export function defaultProjectConfig(): ProjectConfig {
  return structuredClone(DEFAULT_PROJECT_CONFIG)
}
