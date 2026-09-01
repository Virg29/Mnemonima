import os from 'node:os'
import { CachingTokenCounter } from '../chunking.js'
import type { TokenCounter } from '../chunking.js'
import { BadRequestError, InternalError, NotFoundError } from '../errors.js'
import { l2Normalize } from '../vector.js'
import type { Embedder, ProgressCallback } from './embedder.js'
import type { ModelDescriptor } from './models.js'

/**
 * The real embedder: transformers.js on top of onnxruntime-node.
 *
 * Why one session rather than a pool of worker threads. onnxruntime already
 * parallelises a single session across `intraOpNumThreads`, and inference runs
 * on libuv's thread pool, so it does not block the event loop. N sessions would
 * cost N times the weights in RAM and N model loads to buy throughput the
 * single session already has. The pool becomes worthwhile when the daemon must
 * stay responsive during a long re-index, so this stays behind the `Embedder`
 * interface and can grow one later without touching a caller.
 *
 * CPU budget: the operator asked for at most half the machine, so threads
 * default to `ceil(cores / 2)` and the process drops below normal priority
 * while indexing.
 */

export interface TransformersOptions {
  /** Where weights are cached. Defaults to the transformers.js location. */
  readonly cacheDir?: string | undefined
  /** Intra-op thread count. Defaults to half the available cores. */
  readonly threads?: number | undefined
  readonly batchSize?: number | undefined
}

export function defaultThreadCount(): number {
  return Math.max(1, Math.ceil(os.cpus().length / 2))
}

/**
 * Drops the current process below normal priority so a long indexing run does
 * not make the machine feel stuck. Best effort: some platforms and permission
 * setups refuse, which is not an error worth failing on.
 */
export function lowerProcessPriority(): boolean {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
    return true
  } catch {
    return false
  }
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

type Tokenizer = { encode(text: string): number[] }

export class TransformersEmbedder implements Embedder {
  readonly model: ModelDescriptor
  readonly counter: TokenCounter

  readonly #extractor: FeatureExtractor
  readonly #batchSize: number

  private constructor(
    model: ModelDescriptor,
    extractor: FeatureExtractor,
    tokenizer: Tokenizer,
    batchSize: number,
  ) {
    this.model = model
    this.#extractor = extractor
    this.#batchSize = batchSize
    this.counter = new CachingTokenCounter({
      count: (text: string) => Math.max(1, tokenizer.encode(text).length),
    })
  }

  static async create(
    model: ModelDescriptor,
    options: TransformersOptions = {},
  ): Promise<TransformersEmbedder> {
    if (model.offline) {
      throw new NotFoundError(
        `model "${model.id}" is not a downloadable model and cannot be loaded here`,
        { details: { model: model.id }, hint: 'use DeterministicEmbedder for offline models' },
      )
    }

    const threads = options.threads ?? defaultThreadCount()

    // Imported lazily: onnxruntime is heavy, and commands that never embed
    // anything (project list, get, help) should not pay for loading it.
    const transformers = await import('@huggingface/transformers')
    const { AutoTokenizer, env, pipeline } = transformers

    if (options.cacheDir !== undefined) env.cacheDir = options.cacheDir
    env.allowLocalModels = true

    try {
      const tokenizer = (await AutoTokenizer.from_pretrained(model.id)) as unknown as Tokenizer
      const extractor = (await pipeline('feature-extraction', model.id, {
        session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
      })) as unknown as FeatureExtractor

      return new TransformersEmbedder(model, extractor, tokenizer, options.batchSize ?? 32)
    } catch (cause) {
      // Not an InternalError: the usual cause is no network on first use, which
      // the operator can fix. Exit code 70 tells an agent "this is a bug in
      // mnemonima" and stops it retrying something worth retrying.
      throw new BadRequestError(
        `failed to load embedding model "${model.id}": ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          details: { model: model.id, cacheDir: options.cacheDir },
          hint:
            `the weights (~${model.sizeMb} MB) are downloaded on first use — ` +
            `run \`mnemonima models pull ${model.id}\` while online`,
        },
      )
    }
  }

  async embedDocuments(
    texts: readonly string[],
    onProgress?: ProgressCallback,
  ): Promise<Float32Array[]> {
    const out: Float32Array[] = []

    for (let start = 0; start < texts.length; start += this.#batchSize) {
      const batch = texts
        .slice(start, start + this.#batchSize)
        .map((text) => this.model.docPrefix + text)

      const output = await this.#extractor(batch, { pooling: 'mean', normalize: this.model.normalize })
      for (const row of output.tolist()) out.push(toVector(row, this.model))

      onProgress?.({ done: Math.min(start + this.#batchSize, texts.length), total: texts.length })
    }

    return out
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const output = await this.#extractor([this.model.queryPrefix + text], {
      pooling: 'mean',
      normalize: this.model.normalize,
    })

    const row = output.tolist()[0]
    if (row === undefined) {
      throw new InternalError('embedding model returned no vector for the query')
    }
    return toVector(row, this.model)
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

function toVector(row: readonly number[], model: ModelDescriptor): Float32Array {
  if (row.length !== model.dim) {
    throw new InternalError(
      `model "${model.id}" returned ${row.length} dimensions, expected ${model.dim}`,
      {
        details: { got: row.length, expected: model.dim },
        hint: 'the model registry entry disagrees with the downloaded weights',
      },
    )
  }

  // Normalised again defensively: storage assumes unit vectors so that search
  // can use a dot product instead of a full cosine.
  return l2Normalize(Float32Array.from(row))
}
