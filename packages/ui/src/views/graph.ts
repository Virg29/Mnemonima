import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import Sigma from 'sigma'
import { api } from '../api.js'
import type { GraphView } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { el } from '../dom.js'

/**
 * The graph — DESIGN.md 13.2.
 *
 * Node size is degree, colour is the Louvain community, and a search
 * highlights its hits in place rather than opening a list beside the graph:
 * the point of having the graph on screen is to see *where* the answers sit.
 *
 * Dangling targets are drawn as phantom nodes on a dashed edge. They are data,
 * not corruption (3.4), so hiding them would hide the case worth seeing —
 * and the phantom is not clickable, because there is nothing to open.
 *
 * The only mutation is creating a link by dragging (13.1). There is no edge
 * deletion with the mouse: removing a link means cutting a wikilink out of a
 * sentence, and where it sits in that sentence carries meaning.
 */

const PALETTE = [
  '#2f6feb',
  '#1a7f4b',
  '#a25c00',
  '#b3261e',
  '#7048e8',
  '#0b7285',
  '#c2255c',
  '#5c7cfa',
]

export function graphScreen(): Screen {
  return {
    id: 'graph',
    title: 'Graph',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const view = await api.graph(surface.project)

      const canvas = el('div', { class: 'graph' })
      const detail = el('div', { class: 'graph-detail' })
      const query = el('input', {
        type: 'search',
        class: 'grow',
        placeholder: 'highlight the notes that match…',
      })

      surface.bar.append(
        query,
        el('span', {
          class: 'hint',
          text: `${view.nodes.length} notes, ${view.edges.length} links, ${view.phantoms.length} dangling`,
        }),
      )

      surface.body.append(el('div', { class: 'split graph-split' }, [canvas, detail]))

      // Sigma measures the container, so it has to be in the document first.
      const graph = build(view)
      const renderer = new Sigma(graph, canvas, {
        defaultEdgeType: 'line',
        labelDensity: 0.6,
        labelRenderedSizeThreshold: 4,
        renderEdgeLabels: false,
      })

      wireInteraction(surface, renderer, graph, detail)
      wireHighlight(surface, renderer, query)

      detail.append(
        el('p', {
          class: 'hint',
          text: 'Click a note to see it. Drag from one note onto another to link them.',
        }),
      )
    },
  }
}

/** The graphology graph, laid out and coloured. */
function build(view: GraphView): Graph {
  const graph = new Graph({ multi: false, type: 'directed' })

  for (const node of view.nodes) {
    graph.addNode(node.id, {
      label: node.title,
      title: node.title,
      phantom: false,
      degree: node.degree,
      size: 4 + Math.min(10, Math.sqrt(node.degree) * 3),
      x: Math.cos(hash(node.id)) * 100,
      y: Math.sin(hash(node.id)) * 100,
    })
  }

  for (const node of view.phantoms) {
    graph.addNode(node.id, {
      label: node.id,
      title: `${node.id} — not a note here`,
      phantom: true,
      degree: node.degree,
      size: 3,
      color: '#9aa3af',
      x: Math.cos(hash(node.id)) * 140,
      y: Math.sin(hash(node.id)) * 140,
    })
  }

  for (const edge of view.edges) {
    if (graph.hasEdge(edge.from, edge.to)) continue

    graph.addDirectedEdge(edge.from, edge.to, {
      size: edge.resolved ? 1 : 0.6,
      color: edge.resolved ? '#c7ccd4' : '#e0a0a0',
      resolved: edge.resolved,
    })
  }

  // Louvain needs at least one edge; a project with no links is common early on.
  // It handles a directed graph directly, using directed modularity.
  if (graph.size > 0) {
    const communities = louvain(graph)
    graph.forEachNode((id, attributes) => {
      if (attributes['phantom'] === true) return
      const community = communities[id] ?? 0
      graph.setNodeAttribute(id, 'color', PALETTE[community % PALETTE.length])
    })
  } else {
    graph.forEachNode((id, attributes) => {
      if (attributes['phantom'] !== true) graph.setNodeAttribute(id, 'color', PALETTE[0])
    })
  }

  if (graph.order > 1) {
    forceAtlas2.assign(graph, {
      iterations: Math.max(50, Math.min(400, graph.order * 4)),
      settings: { ...forceAtlas2.inferSettings(graph), gravity: 1.2 },
    })
  }

  return graph
}

/** A stable pseudo-angle per id, so a reload starts from the same layout. */
function hash(id: string): number {
  let value = 0
  for (let index = 0; index < id.length; index += 1) {
    value = (value * 31 + id.charCodeAt(index)) % 100000
  }
  return (value / 100000) * Math.PI * 2
}

function describePhantom(detail: HTMLElement, id: string): void {
  show(detail, [
    el('h2', { text: id }),
    el('p', {
      class: 'hint',
      text: 'A link points here, but no note has this id. It is kept exactly as written.',
    }),
  ])
}

async function showNote(surface: Surface, detail: HTMLElement, id: string): Promise<void> {
  try {
    const note = await api.note(surface.project, id)

    show(detail, [
      el('h2', { text: note.title }),
      el('p', { class: 'id', text: `${note.id} · rev ${note.rev} · ${note.status}` }),
      el('p', {}, [
        el('button', { text: 'Open in the editor', onclick: () => surface.go('note', note.id) }),
      ]),
      el('p', { class: 'hint', text: `${note.links.length} out, ${note.backlinks.length} back` }),
      el('p', {}, note.terms.slice(0, 12).map((term) => el('span', { class: 'tag', text: term.term }))),
    ])
  } catch (error) {
    surface.fail(error)
  }
}

function show(detail: HTMLElement, children: Node[]): void {
  detail.replaceChildren(...children)
}

/**
 * Selecting a note, and creating a link by dragging.
 *
 * One state machine rather than two, because the two gestures start
 * identically: press on a node and either release without moving (select) or
 * release on another node (link).
 *
 * Camera panning is switched off for the duration of a press that started on a
 * node. Otherwise the drag pans the view, the target slides out from under the
 * pointer, and the gesture lands on empty space — which is exactly what it did
 * before this was here.
 */
function wireInteraction(surface: Surface, renderer: Sigma, graph: Graph, detail: HTMLElement): void {
  const camera = renderer.getCamera()
  const captor = renderer.getMouseCaptor()

  let from: string | null = null
  let moved = false
  let origin: { x: number; y: number } | null = null

  const finish = (): void => {
    from = null
    origin = null
    camera.enabledPanning = true
    renderer.getContainer().style.cursor = ''
  }

  renderer.on('downNode', ({ node, event }) => {
    if (graph.getNodeAttribute(node, 'phantom') === true) {
      from = null
      return
    }

    from = node
    moved = false
    origin = { x: event.x, y: event.y }
    camera.enabledPanning = false
  })

  captor.on('mousemove', (event) => {
    if (origin === null) return
    // A few pixels of travel is a press, not a drag: a mouse moves under a
    // finger that meant to click.
    if (Math.hypot(event.x - origin.x, event.y - origin.y) > 4) {
      moved = true
      renderer.getContainer().style.cursor = 'crosshair'
    }
  })

  renderer.on('upNode', ({ node }) => {
    const source = from
    const dragged = moved

    // Sigma emits this before the captor's own mouseup, which is where the
    // state is cleared, so reading it here is safe.
    if (source === null) {
      if (!dragged && graph.getNodeAttribute(node, 'phantom') === true) describePhantom(detail, node)
      return
    }

    if (!dragged || node === source) {
      void showNote(surface, detail, source)
      return
    }

    if (graph.getNodeAttribute(node, 'phantom') === true) return

    if (graph.hasEdge(source, node)) {
      show(detail, [
        el('h2', { text: 'Already linked' }),
        el('p', {
          class: 'hint',
          text: `${source} already points at ${node}. Change the anchor by editing the body.`,
        }),
      ])
      return
    }

    confirmLink(surface, graph, detail, source, node)
  })

  // A press that ends anywhere but on a node is not a link, and a press that
  // never started on one must leave panning alone.
  captor.on('mouseup', finish)
}

function confirmLink(
  surface: Surface,
  graph: Graph,
  detail: HTMLElement,
  from: string,
  to: string,
): void {
  const anchor = el('input', { class: 'grow', placeholder: 'anchor text (optional)' })
  const title = String(graph.getNodeAttribute(to, 'title') ?? to)
  const preview = el('code', { text: `- [[${to} ${title}]]` })

  anchor.addEventListener('input', () => {
    preview.textContent =
      anchor.value.trim() === ''
        ? `- [[${to} ${title}]]`
        : `- [[${to} ${title}|${anchor.value.trim()}]]`
  })

  show(detail, [
    el('h2', { text: 'Link these notes' }),
    el('p', { class: 'hint', text: `${from} will point at ${to}.` }),
    el('p', {
      class: 'hint',
      text: 'The line below is appended to a ## Related section in the source note. Prose is not touched.',
    }),
    el('pre', {}, [preview]),
    anchor,
    el('p', {}, [
      el('button', {
        class: 'primary',
        text: 'Link',
        onclick: async () => {
          try {
            await api.link(
              surface.project,
              from,
              to,
              anchor.value.trim() === '' ? undefined : anchor.value.trim(),
            )
            surface.reload()
          } catch (error) {
            surface.fail(error)
          }
        },
      }),
      el('button', { text: 'Cancel', onclick: () => show(detail, []) }),
    ]),
  ])
}

/** A query dims everything it did not match, so the hits keep their position. */
function wireHighlight(surface: Surface, renderer: Sigma, query: HTMLInputElement): void {
  let generation = 0

  const apply = (hits: Set<string> | null): void => {
    renderer.setSetting('nodeReducer', (node, data) => {
      if (hits === null) return data
      if (hits.has(node)) return { ...data, zIndex: 1, size: Number(data['size'] ?? 4) * 1.6 }
      return { ...data, color: '#c7ccd4', label: '', zIndex: 0 }
    })
    renderer.refresh()
  }

  const run = async (): Promise<void> => {
    const mine = ++generation

    if (query.value.trim() === '') {
      apply(null)
      return
    }

    try {
      const result = await api.search(surface.project, { query: query.value, limit: 25 })
      if (mine !== generation) return
      apply(new Set(result.hits.map((hit) => hit.id)))
    } catch (error) {
      if (mine !== generation) return
      surface.fail(error)
    }
  }

  query.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void run()
  })
  query.addEventListener('search', () => void run())
}
