import { api } from './api.js'

/**
 * Where the notes sit on the graph, kept in two places on purpose.
 *
 * **The database is the shared truth.** A layout arranged on one machine should
 * be there on the next, and on the other browser, and after the daemon
 * restarts. That is what makes it worth arranging.
 *
 * **`localStorage` is the write-ahead half.** A drag has to survive the moment
 * between letting go and the next flush — a reload, a closed tab, a daemon that
 * is not answering — so every move is written locally first and only cleared
 * once the server has acknowledged it. Nothing is lost if the sync never
 * happens; the picture simply stays local until it can.
 *
 * Merging is per note and last write wins. Two windows arranging the same graph
 * is a real thing an operator does, and the alternative — a whole-layout write
 * — would mean the slower window flattening the faster one's work.
 */

export interface Position {
  readonly x: number
  readonly y: number
}

export interface Stored {
  positions: Record<string, [number, number]>
  /** Ids written locally that the server has not confirmed. */
  pending: string[]
}

const EMPTY: Stored = { positions: {}, pending: [] }

/** Long enough that dragging a dozen notes is one request, short enough to feel saved. */
const FLUSH_AFTER_MS = 4000

function key(project: string): string {
  return `mnemonima.layout.${project}`
}

function read(project: string): Stored {
  try {
    const raw = localStorage.getItem(key(project))
    if (raw === null) return { positions: {}, pending: [] }

    const parsed = JSON.parse(raw) as Partial<Stored>
    return {
      positions: parsed.positions ?? {},
      pending: parsed.pending ?? [],
    }
  } catch {
    // Unreadable or refused: the graph still works, it just arranges itself.
    return { positions: {}, pending: [] }
  }
}

function write(project: string, stored: Stored): void {
  try {
    if (Object.keys(stored.positions).length === 0) localStorage.removeItem(key(project))
    else localStorage.setItem(key(project), JSON.stringify(stored))
  } catch {
    // Out of quota or a private window. The positions live for this session.
  }
}

/**
 * What the graph should draw with: the server's placements, with anything not
 * yet flushed on top, and the local copy filling whatever the server has no
 * answer for.
 *
 * That last part is not a fallback, it is the normal case for **phantom
 * nodes**. A phantom stands for a link to an id no note has, so there is no row
 * to hang a position on and the server drops it — and with only pending ids
 * overlaid, every phantom came back unplaced and was re-arranged on each visit.
 * Nine of them jumped on every reload of a project that otherwise stood still.
 *
 * It also covers a project the daemon has never been told about, or was told
 * while it was down: the page keeps the picture until it can hand it over.
 */
export function mergeLayout(
  fromServer: Record<string, Position>,
  stored: Stored,
): Map<string, Position> {
  const merged = new Map<string, Position>()

  for (const [id, at] of Object.entries(fromServer)) merged.set(id, at)

  const unflushed = new Set(stored.pending)
  for (const [id, [x, y]] of Object.entries(stored.positions)) {
    if (unflushed.has(id) || !merged.has(id)) merged.set(id, { x, y })
  }

  return merged
}

/** The same, against what this browser has stored for the project. */
export function resolveLayout(
  project: string,
  fromServer: Record<string, Position>,
): Map<string, Position> {
  return mergeLayout(fromServer, read(project))
}

/**
 * One project's positions, and the pending write behind them.
 *
 * Created per graph render, because the project can change under the screen and
 * a timer holding the previous one would flush the wrong notes.
 */
export class LayoutStore {
  readonly #project: string
  #timer: number | null = null
  #onError: ((error: unknown) => void) | null = null

  constructor(project: string) {
    this.#project = project
  }

  /** Where a failed flush goes. Nothing is lost either way — it stays pending. */
  onError(handler: (error: unknown) => void): this {
    this.#onError = handler
    return this
  }

  /** Records a move locally and schedules the sync. */
  remember(noteId: string, at: Position): void {
    this.rememberMany(new Map([[noteId, at]]))
  }

  /**
   * The same, for a whole arrangement at once.
   *
   * One read and one write of the stored blob rather than one per node: the
   * first visit to a project places every note it has, and doing that through
   * `remember` would be a hundred JSON round trips to save one picture.
   */
  rememberMany(positions: ReadonlyMap<string, Position>): void {
    if (positions.size === 0) return

    const stored = read(this.#project)
    const pending = new Set(stored.pending)

    for (const [noteId, at] of positions) {
      stored.positions[noteId] = [at.x, at.y]
      pending.add(noteId)
    }

    stored.pending = [...pending]
    write(this.#project, stored)

    this.#schedule()
  }

  #schedule(): void {
    if (this.#timer !== null) window.clearTimeout(this.#timer)
    this.#timer = window.setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, FLUSH_AFTER_MS)
  }

  /**
   * Sends what has not been acknowledged.
   *
   * @param keepalive for a flush on the way out of the page, where an ordinary
   *   request would be cancelled by the unload.
   */
  async flush(keepalive = false): Promise<void> {
    if (this.#timer !== null) {
      window.clearTimeout(this.#timer)
      this.#timer = null
    }

    const stored = read(this.#project)
    if (stored.pending.length === 0) return

    const positions: Record<string, Position> = {}
    for (const id of stored.pending) {
      const at = stored.positions[id]
      if (at !== undefined) positions[id] = { x: at[0], y: at[1] }
    }

    const sent = new Set(Object.keys(positions))

    try {
      await api.saveLayout(this.#project, positions, { keepalive })

      // Re-read rather than reusing what was read above: a drag during the
      // request has already been written, and clearing the whole list would
      // drop it.
      const now = read(this.#project)
      now.pending = now.pending.filter((id) => !sent.has(id))
      write(this.#project, now)
    } catch (error) {
      // Left pending on purpose, to go out with the next flush.
      this.#onError?.(error)
    }
  }

  /** Forgets every placement, here and on the server. */
  async reset(): Promise<void> {
    if (this.#timer !== null) {
      window.clearTimeout(this.#timer)
      this.#timer = null
    }

    write(this.#project, EMPTY)
    await api.clearLayout(this.#project)
  }
}
