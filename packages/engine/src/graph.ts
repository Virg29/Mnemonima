import { NotFoundError } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { degreeOf, getNote, loadNeighbours } from '@mnemonima/store'
import type { Db, NeighbourSets } from '@mnemonima/store'

/**
 * Graph-aware ranking — DESIGN.md 8.4.
 *
 * The graph is the thing this project has that a flat document store does not,
 * so it earns its place in the ranking twice:
 *
 * 1. **Boost by neighbourhood.** A note whose neighbours also scored is probably
 *    in the middle of the relevant cluster. One iteration, using the scores from
 *    before the boost, so the result does not depend on iteration order.
 *
 * 2. **Expansion.** A note that did not match itself but is pointed at by
 *    several results is a candidate, carrying `via` so the reader can see why it
 *    is there. This catches the case where the terminology differs but the
 *    subject is the same.
 *
 * Dividing by degree is what stops a hub note from being boosted by every query:
 * a note linked from forty others should need more than one relevant neighbour.
 */

export interface GraphNeighbour {
  readonly id: string
  readonly title: string
  readonly relation: 'links' | 'backlinks' | 'both'
}

export function loadGraph(db: Db): NeighbourSets {
  return loadNeighbours(db)
}

/** Direct neighbours of a note, both directions, for `--expand-links`. */
export function neighboursOf(db: Db, graph: NeighbourSets, id: string): GraphNeighbour[] {
  const out = graph.outgoing.get(id) ?? new Set<string>()
  const back = graph.incoming.get(id) ?? new Set<string>()

  const summaries: GraphNeighbour[] = []
  for (const neighbour of new Set([...out, ...back])) {
    const note = getNote(db, neighbour)
    if (note === null || note.status !== 'active') continue

    summaries.push({
      id: note.id,
      title: note.title,
      relation: out.has(neighbour) && back.has(neighbour) ? 'both' : out.has(neighbour) ? 'links' : 'backlinks',
    })
  }

  return summaries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export interface GraphAdjustment {
  /** Additional score for notes already in the results. */
  readonly boost: ReadonlyMap<string, number>
  /** Notes the graph pulled in, with the results that voted for them. */
  readonly expansion: ReadonlyMap<string, { readonly score: number; readonly via: string[] }>
}

export function computeGraphAdjustment(
  baseScores: ReadonlyMap<string, number>,
  graph: NeighbourSets,
  config: ProjectConfig,
): GraphAdjustment {
  const settings = config.search.graph
  const boost = new Map<string, number>()
  const expansion = new Map<string, { score: number; via: string[] }>()

  if (settings.boost <= 0 && settings.expandDepth <= 0) return { boost, expansion }

  const votes = new Map<string, string[]>()

  for (const [id, score] of baseScores) {
    const linked = new Set([
      ...(graph.outgoing.get(id) ?? []),
      ...(graph.incoming.get(id) ?? []),
    ])

    let fromNeighbours = 0
    for (const neighbour of linked) {
      const neighbourScore = baseScores.get(neighbour)
      if (neighbourScore !== undefined) {
        fromNeighbours += neighbourScore
        continue
      }

      const voters = votes.get(neighbour) ?? []
      voters.push(id)
      votes.set(neighbour, voters)
    }

    if (settings.boost > 0 && fromNeighbours > 0) {
      const degree = Math.max(1, degreeOf(graph, id))
      boost.set(id, (settings.boost * fromNeighbours) / degree)
    }
  }

  if (settings.expandDepth > 0) {
    for (const [candidate, voters] of votes) {
      if (voters.length < settings.expandMinVotes) continue

      const total = voters.reduce((sum, voter) => sum + (baseScores.get(voter) ?? 0), 0)
      expansion.set(candidate, {
        // Deliberately below the notes that voted for it: an expansion is a
        // suggestion, not a match.
        score: (settings.boost * total) / voters.length,
        via: [...voters].sort(),
      })
    }
  }

  return { boost, expansion }
}

export interface TraversalHit {
  readonly id: string
  readonly title: string
  readonly distance: number
  /** The note one step closer to the origin. */
  readonly via: string
}

/** Breadth-first walk from a note, for `--mode graph`. */
export function traverse(
  db: Db,
  graph: NeighbourSets,
  from: string,
  depth: number,
): TraversalHit[] {
  const origin = getNote(db, from)
  if (origin === null) {
    throw new NotFoundError(`no note ${from} in this project`, {
      details: { from },
      hint: 'run `mnemonima list` to see the ids that exist',
    })
  }

  const seen = new Set<string>([from])
  const out: TraversalHit[] = []
  let frontier: { id: string; via: string }[] = [{ id: from, via: from }]

  for (let distance = 1; distance <= depth; distance += 1) {
    const next: { id: string; via: string }[] = []

    for (const current of frontier) {
      const linked = new Set([
        ...(graph.outgoing.get(current.id) ?? []),
        ...(graph.incoming.get(current.id) ?? []),
      ])

      for (const neighbour of [...linked].sort()) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)

        const note = getNote(db, neighbour)
        if (note === null || note.status !== 'active') continue

        out.push({ id: note.id, title: note.title, distance, via: current.id })
        next.push({ id: neighbour, via: current.id })
      }
    }

    frontier = next
    if (frontier.length === 0) break
  }

  return out
}
