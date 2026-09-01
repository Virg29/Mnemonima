import { CHUNKER_VERSION } from '../chunking.js'
import type { ChunkingConfig } from '../config.js'
import { hashObject } from '../hash.js'
import type { ModelDescriptor } from './models.js'

/**
 * Embedding spaces — DESIGN.md 6.4.
 *
 * A space is addressed by the hash of *everything that can invalidate it*:
 * model, dimensions, prefixes, normalisation, chunker version and chunking
 * settings. Change any of them and you get a different space id, so the old
 * vectors stay valid for the old configuration and the new ones are built
 * beside them. There is no migration step and no "why did search break after
 * the upgrade" — the two spaces simply do not collide.
 *
 * The id is a 16-character prefix of the SHA-256: 64 bits is far beyond what a
 * single project needs, and it stays readable in logs and directory names.
 */
export const SPACE_ID_LENGTH = 16

export interface SpaceDescriptor {
  readonly model: string
  readonly dim: number
  readonly chunkerVersion: string
  readonly normalize: boolean
  readonly queryPrefix: string
  readonly docPrefix: string
  readonly chunking: ChunkingConfig
}

export function describeSpace(model: ModelDescriptor, chunking: ChunkingConfig): SpaceDescriptor {
  return {
    model: model.id,
    dim: model.dim,
    chunkerVersion: CHUNKER_VERSION,
    normalize: model.normalize,
    queryPrefix: model.queryPrefix,
    docPrefix: model.docPrefix,
    chunking,
  }
}

export function spaceId(descriptor: SpaceDescriptor): string {
  return hashObject(descriptor).slice(0, SPACE_ID_LENGTH)
}
