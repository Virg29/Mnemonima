import {
  DeterministicEmbedder,
  TransformersEmbedder,
  defaultThreadCount,
  resolveModel,
} from '@mnemonima/core'
import type { Embedder, ModelDescriptor, ProjectConfig } from '@mnemonima/core'
import { modelsDir } from '@mnemonima/store'

/**
 * Chooses an embedder for a project configuration.
 *
 * Models flagged `offline` in the registry never touch the network and never
 * load onnxruntime; everything else goes through transformers.js. The weights
 * cache is shared across projects in `~/.mnemonima/models`, so switching
 * projects does not re-download anything.
 */
export interface EmbedderOptions {
  /** Overrides `model.active` from the project configuration. */
  readonly model?: string | undefined
  readonly threads?: number | undefined
  readonly cacheDir?: string | undefined
  readonly batchSize?: number | undefined
}

export interface ResolvedEmbedder {
  readonly embedder: Embedder
  readonly model: ModelDescriptor
  readonly threads: number
}

export async function createEmbedder(
  config: ProjectConfig,
  options: EmbedderOptions = {},
): Promise<ResolvedEmbedder> {
  const model = resolveModel(options.model ?? config.model.active)
  const threads = options.threads ?? defaultThreadCount()

  if (model.offline) {
    return { embedder: new DeterministicEmbedder(model), model, threads: 1 }
  }

  const embedder = await TransformersEmbedder.create(model, {
    cacheDir: options.cacheDir ?? modelsDir(),
    threads,
    batchSize: options.batchSize ?? config.model.batchSize,
  })

  return { embedder, model, threads }
}
