import { NotFoundError } from '../errors.js'

/**
 * Registry of embedding models — DESIGN.md 6.3.
 *
 * `queryPrefix` and `docPrefix` exist because model families disagree about
 * them. gte needs none; bge and e5 want an instruction in front of the query
 * ("Represent this sentence for searching relevant passages: "). Keeping the
 * prefixes in the descriptor means adding such a model is a data change, not a
 * code change — and the prefixes are part of the embedding space id, so
 * changing them invalidates the cache automatically.
 */
export interface ModelDescriptor {
  readonly id: string
  readonly dim: number
  /** Hard limit of the model's context window, in tokens. */
  readonly maxTokens: number
  readonly queryPrefix: string
  readonly docPrefix: string
  readonly normalize: boolean
  /** Approximate on-disk size of the ONNX weights, in megabytes. */
  readonly sizeMb: number
  /** True when the model needs no download and no network. */
  readonly offline: boolean
  readonly note: string
}

export const DEFAULT_MODEL_ID = 'Supabase/gte-small'

/**
 * A deterministic hashing vectoriser. Not a neural model: it exists so the test
 * suite and offline development can exercise the whole indexing and search path
 * without a download. Never select it for real content.
 */
export const TEST_MODEL_ID = 'test/deterministic-384'

export const MODELS: readonly ModelDescriptor[] = [
  {
    id: DEFAULT_MODEL_ID,
    dim: 384,
    maxTokens: 512,
    queryPrefix: '',
    docPrefix: '',
    normalize: true,
    sizeMb: 34,
    offline: false,
    note: 'default; English only, no query prefix required',
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    maxTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    docPrefix: '',
    normalize: true,
    sizeMb: 34,
    offline: false,
    note: 'needs an instruction prefix on the query side',
  },
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    maxTokens: 256,
    queryPrefix: '',
    docPrefix: '',
    normalize: true,
    sizeMb: 23,
    offline: false,
    note: 'faster and weaker; short context',
  },
  {
    id: 'Xenova/gte-base',
    dim: 768,
    maxTokens: 512,
    queryPrefix: '',
    docPrefix: '',
    normalize: true,
    sizeMb: 110,
    offline: false,
    note: 'more accurate, twice the memory per vector',
  },
  {
    id: TEST_MODEL_ID,
    dim: 384,
    maxTokens: 512,
    queryPrefix: '',
    docPrefix: '',
    normalize: true,
    sizeMb: 0,
    offline: true,
    note: 'hashing vectoriser for tests and offline development, not a real model',
  },
]

export function listModels(): readonly ModelDescriptor[] {
  return MODELS
}

export function findModel(id: string): ModelDescriptor | null {
  return MODELS.find((model) => model.id === id) ?? null
}

export function resolveModel(id: string): ModelDescriptor {
  const model = findModel(id)
  if (model !== null) return model

  throw new NotFoundError(`unknown embedding model "${id}"`, {
    details: { id, known: MODELS.map((entry) => entry.id) },
    hint: `run \`mnemonima models list\` — known ids: ${MODELS.map((entry) => entry.id).join(', ')}`,
  })
}
