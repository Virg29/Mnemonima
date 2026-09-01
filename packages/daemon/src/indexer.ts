import { indexProject } from '@mnemonima/engine'
import type { HotProject } from './pool.js'
import type { ProjectPool } from './pool.js'

/**
 * Debounced automatic indexing.
 *
 * A note that was written but never indexed is invisible to search, so every
 * writer had to remember to run one — and an agent that forgets produces a
 * project whose newest notes cannot be found, which looks like the search is
 * broken rather than like the index is stale.
 *
 * The daemon already sees every write, so it does it. A burst of writes resets
 * the timer and produces one run, and the run is incremental: chunk hashes
 * decide what is re-embedded, so a hundred writes to one note cost one note's
 * worth of embedding.
 *
 * Two properties matter and are easy to get wrong:
 *
 *  - **Never two runs at once for one project.** They would race on the same
 *    rows. A write that lands mid-run is remembered and scheduled after it.
 *  - **Export runs after indexing, not beside it.** Exported frontmatter
 *    carries the outline and the automatic terms, both of which the index run
 *    produces; exporting first would write a file that is one run out of date.
 *
 * Failures are logged and dropped. The note is already in SQLite, which is the
 * source of truth; a failed index run must never fail the write that triggered
 * it.
 */
export interface AutoIndexOptions {
  readonly onError?: (message: string) => void
  readonly onIndexed?: (project: string, report: IndexSummary) => void
  /** Called after a successful run, so the export sees fresh derived fields. */
  readonly onSettled?: (project: HotProject) => void
}

export interface IndexSummary {
  readonly notesChunked: number
  readonly embedded: number
  readonly tookMs: number
}

export class AutoIndexer {
  readonly #timers = new Map<string, NodeJS.Timeout>()
  readonly #running = new Set<string>()
  readonly #again = new Set<string>()
  readonly #pool: ProjectPool
  readonly #options: AutoIndexOptions

  constructor(pool: ProjectPool, options: AutoIndexOptions = {}) {
    this.#pool = pool
    this.#options = options
  }

  /** Called after every write. Resets the timer, so a burst indexes once. */
  schedule(project: HotProject): void {
    if (!project.config.index.auto) {
      // Auto-indexing off means the caller owns it, so the export must still
      // be scheduled or turning this off would also stop exporting.
      this.#options.onSettled?.(project)
      return
    }

    if (this.#running.has(project.name)) {
      this.#again.add(project.name)
      return
    }

    const existing = this.#timers.get(project.name)
    if (existing !== undefined) clearTimeout(existing)

    const delay = Math.max(1, project.config.index.debounceSec) * 1000
    const timer = setTimeout(() => {
      this.#timers.delete(project.name)
      void this.#run(project.name)
    }, delay)

    // A pending index must not hold the daemon open.
    timer.unref()
    this.#timers.set(project.name, timer)
  }

  /**
   * Cancels everything pending. Used when the daemon is stopping, and by tests
   * that would otherwise have a run reopen the database they are deleting.
   */
  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    this.#again.clear()
  }

  /** True while a run is in flight, for a caller that has to wait for it. */
  busy(): boolean {
    return this.#running.size > 0
  }

  cancel(name: string): void {
    const timer = this.#timers.get(name)
    if (timer === undefined) return

    clearTimeout(timer)
    this.#timers.delete(name)
  }

  pending(): string[] {
    return [...this.#timers.keys()]
  }

  async #run(name: string): Promise<void> {
    this.#running.add(name)

    try {
      // Re-acquired rather than captured: a project evicted between the write
      // and the timer has to be opened again, and its configuration re-read.
      const project = this.#pool.acquire(name)
      const resolved = await this.#pool.embedder(project)
      const report = await indexProject(project.handle.db, project.config, resolved)

      // The rows moved; the pool revalidates by fingerprint anyway, but
      // dropping it here means the next search does not pay for noticing.
      project.loaded = null

      this.#options.onIndexed?.(name, {
        notesChunked: report.notesChunked,
        embedded: report.embedded,
        tookMs: report.tookMs,
      })

      this.#options.onSettled?.(project)
    } catch (error) {
      this.#options.onError?.(
        `auto-index of "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      this.#running.delete(name)

      // A write arrived while this run was in flight; it has not been indexed.
      if (this.#again.delete(name)) {
        try {
          this.schedule(this.#pool.acquire(name))
        } catch {
          // The project is gone. Nothing to index, nothing to report.
        }
      }
    }
  }
}
