import fs from 'node:fs'
import { exportDirectory, exportProject } from '@mnemonima/engine'
import type { HotProject } from './pool.js'

/**
 * Debounced automatic export — DESIGN.md 5.3, deferred to this stage because it
 * needs a process that sees the writes, and until the daemon owned the write
 * path there was none.
 *
 * Two rules keep it from being a surprise:
 *
 *  - `export.enabled` has to be on, and
 *  - **the export directory has to exist already.** We keep a vault up to date;
 *    we do not conjure one. An operator who has never exported gets no files
 *    appearing under their project because an agent wrote a note.
 *
 * Failures are logged and dropped. An export that cannot be written must never
 * fail the write that triggered it: the note is already safely in SQLite, which
 * is the source of truth.
 */
export interface AutoExportOptions {
  readonly onError?: (message: string) => void
  readonly onExport?: (project: string, files: number) => void
}

export class AutoExporter {
  readonly #timers = new Map<string, NodeJS.Timeout>()
  readonly #options: AutoExportOptions

  constructor(options: AutoExportOptions = {}) {
    this.#options = options
  }

  /** Called after every write. Resets the timer, so a burst exports once. */
  schedule(project: HotProject): void {
    if (!project.config.export.enabled) return

    const dir = exportDirectory(project.handle.dir, project.config)
    if (!fs.existsSync(dir)) return

    const existing = this.#timers.get(project.name)
    if (existing !== undefined) clearTimeout(existing)

    const delay = Math.max(1, project.config.export.debounceSec) * 1000
    const timer = setTimeout(() => {
      this.#timers.delete(project.name)
      this.#run(project)
    }, delay)

    // The daemon should not be held open by a pending export.
    timer.unref()
    this.#timers.set(project.name, timer)
  }

  /** Runs any pending export now. Used on shutdown so nothing is lost. */
  flushAll(projects: readonly HotProject[]): void {
    for (const project of projects) {
      const timer = this.#timers.get(project.name)
      if (timer === undefined) continue

      clearTimeout(timer)
      this.#timers.delete(project.name)
      this.#run(project)
    }
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

  #run(project: HotProject): void {
    try {
      const report = exportProject(project.handle.db, project.config, project.handle.dir)
      const files = report.created.length + report.updated.length + report.removed.length

      if (files > 0) this.#options.onExport?.(project.name, files)
      if (report.note !== null) this.#options.onError?.(report.note)
    } catch (error) {
      this.#options.onError?.(
        `auto-export of "${project.name}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
