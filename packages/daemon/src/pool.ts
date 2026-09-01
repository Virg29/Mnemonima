import type { ProjectConfig } from '@mnemonima/core'
import { dataFingerprint, openProject, projectConfig, requireActiveSpace } from '@mnemonima/store'
import type { ProjectHandle } from '@mnemonima/store'
import { buildSearchIndex, createEmbedder } from '@mnemonima/engine'
import type { ResolvedEmbedder, SearchIndex } from '@mnemonima/engine'

/**
 * The hot-project pool — DESIGN.md 4.1.
 *
 * Holding one or two projects in memory is the whole point of the daemon: the
 * CLI rebuilds both Orama indexes on every invocation, and the daemon does it
 * once. Capacity is deliberately small, because a hot project costs hundreds of
 * megabytes and the operator asked for a 2–4 GB budget.
 *
 * Staleness is impossible rather than merely unlikely. A loaded index remembers
 * the fingerprint of the rows it was built from, and every request re-checks it:
 * if the CLI indexed or wrote a note behind the daemon's back, the next search
 * rebuilds. That is a handful of COUNT queries against the cost of serving a
 * wrong answer.
 */

export interface LoadedIndex {
  readonly index: SearchIndex
  readonly fingerprint: string
  readonly builtAt: number
}

export interface HotProject {
  readonly name: string
  readonly handle: ProjectHandle
  config: ProjectConfig
  loaded: LoadedIndex | null
  embedder: ResolvedEmbedder | null
  readonly loadedAt: number
  lastUsedAt: number
  uses: number
}

export interface PoolOptions {
  /** Projects kept in memory at once. */
  readonly capacity?: number
  /** Evict a project untouched for this long, in milliseconds. */
  readonly idleMs?: number
  /** Store and restore Orama snapshots. Worth it here, not in the CLI. */
  readonly snapshots?: boolean
}

export interface ProjectStatus {
  readonly name: string
  readonly dir: string
  readonly prefix: string
  readonly loadedAt: number
  readonly lastUsedAt: number
  readonly idleMs: number
  readonly uses: number
  readonly index: {
    readonly spaceId: string
    readonly model: string
    readonly dim: number
    readonly chunks: number
    readonly notes: number
    readonly fromSnapshot: boolean
    readonly builtInMs: number
    readonly builtAt: number
  } | null
  readonly embedder: { readonly model: string; readonly threads: number } | null
}

export class ProjectPool {
  readonly #projects = new Map<string, HotProject>()
  readonly #capacity: number
  readonly #idleMs: number
  readonly #snapshots: boolean

  constructor(options: PoolOptions = {}) {
    this.#capacity = Math.max(1, options.capacity ?? 2)
    this.#idleMs = options.idleMs ?? 15 * 60_000
    this.#snapshots = options.snapshots ?? true
  }

  get capacity(): number {
    return this.#capacity
  }

  /** Opens the project if it is not already hot, and marks it used. */
  acquire(name: string): HotProject {
    this.evictIdle()

    const existing = this.#projects.get(name)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      existing.uses += 1
      // Configuration lives in the database and can change under us.
      existing.config = projectConfig(existing.handle.db)
      return existing
    }

    const handle = openProject(name)
    const now = Date.now()

    const project: HotProject = {
      name: handle.name,
      handle,
      config: projectConfig(handle.db),
      loaded: null,
      embedder: null,
      loadedAt: now,
      lastUsedAt: now,
      uses: 1,
    }

    this.#projects.set(handle.name, project)
    this.evictOverCapacity()
    return project
  }

  /**
   * The search index, built or reused. Rebuilds when the underlying rows moved,
   * which is what keeps a CLI `index` run from being invisible to the daemon.
   */
  async index(project: HotProject): Promise<SearchIndex> {
    const space = requireActiveSpace(project.handle.db)
    const fingerprint = dataFingerprint(project.handle.db, space.id)

    if (project.loaded !== null && project.loaded.fingerprint === fingerprint) {
      return project.loaded.index
    }

    const index = await buildSearchIndex(project.handle.db, space, { snapshots: this.#snapshots })
    project.loaded = { index, fingerprint, builtAt: Date.now() }
    return index
  }

  /** The embedder, loaded once per project. Modes that never embed skip this. */
  async embedder(project: HotProject): Promise<ResolvedEmbedder> {
    if (project.embedder !== null) return project.embedder

    const resolved = await createEmbedder(project.config)
    project.embedder = resolved
    return resolved
  }

  status(): ProjectStatus[] {
    const now = Date.now()

    return [...this.#projects.values()]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((project) => ({
        name: project.name,
        dir: project.handle.dir,
        prefix: project.handle.prefix,
        loadedAt: project.loadedAt,
        lastUsedAt: project.lastUsedAt,
        idleMs: now - project.lastUsedAt,
        uses: project.uses,
        index:
          project.loaded === null
            ? null
            : {
                spaceId: project.loaded.index.spaceId,
                model: project.embedder?.model.id ?? '',
                dim: project.loaded.index.dim,
                chunks: project.loaded.index.chunkCount,
                notes: project.loaded.index.noteCount,
                fromSnapshot: project.loaded.index.fromSnapshot,
                builtInMs: project.loaded.index.builtInMs,
                builtAt: project.loaded.builtAt,
              },
        embedder:
          project.embedder === null
            ? null
            : { model: project.embedder.model.id, threads: project.embedder.threads },
      }))
  }

  /** The live entries, for callers that need to act on all of them at once. */
  hotProjects(): HotProject[] {
    return [...this.#projects.values()]
  }

  isLoaded(name: string): boolean {
    return this.#projects.has(name)
  }

  release(name: string): boolean {
    const project = this.#projects.get(name)
    if (project === undefined) return false

    this.#close(project)
    this.#projects.delete(name)
    return true
  }

  evictIdle(): string[] {
    const now = Date.now()
    const evicted: string[] = []

    for (const [name, project] of this.#projects) {
      if (now - project.lastUsedAt < this.#idleMs) continue
      this.#close(project)
      this.#projects.delete(name)
      evicted.push(name)
    }

    return evicted
  }

  evictOverCapacity(): string[] {
    const evicted: string[] = []

    while (this.#projects.size > this.#capacity) {
      let oldest: HotProject | null = null
      for (const project of this.#projects.values()) {
        if (oldest === null || project.lastUsedAt < oldest.lastUsedAt) oldest = project
      }
      if (oldest === null) break

      this.#close(oldest)
      this.#projects.delete(oldest.name)
      evicted.push(oldest.name)
    }

    return evicted
  }

  closeAll(): void {
    for (const project of this.#projects.values()) this.#close(project)
    this.#projects.clear()
  }

  #close(project: HotProject): void {
    void project.embedder?.embedder.dispose()
    try {
      project.handle.db.close()
    } catch {
      // Already closed, or closing during shutdown; not worth failing over.
    }
  }
}
