import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import Sigma from 'sigma'
import { api } from '../api.js'
import type { GraphView } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { el } from '../dom.js'
import { renderMarkdown } from '../markdown.js'

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
 * Three gestures, and which one is which was the decision worth recording.
 * **Dragging moves a node**, because that is what dragging a node does
 * everywhere else and because a layout the operator arranged by hand is the
 * only one that means anything to them. Link-by-drag, the only mutation here,
 * moved onto **shift**. Hovering lights up a note's own edges and dims
 * everything else, which is the question the graph is usually asked: not what
 * the whole corpus looks like, but what this one note is connected to.
 *
 * There is still no edge deletion with the mouse: removing a link means cutting
 * a wikilink out of a sentence, and where it sits in that sentence carries
 * meaning.
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

const DIMMED_NODE = '#dfe3e8'
const DIMMED_EDGE = '#eceef1'
const ACTIVE_EDGE = '#2f6feb'

/**
 * What the two reducers read.
 *
 * One object rather than a variable per feature: hovering and searching both
 * decide the colour of the same node, and two independent reducers would each
 * overwrite the other's answer depending on which refreshed last.
 */
interface Emphasis {
  /** The notes a search matched, or null when the box is empty. */
  hits: Set<string> | null
  /** The note under the pointer. */
  hovered: string | null
  /** The hovered note and its neighbours. */
  near: Set<string>
  /** The note being dragged from with shift held, mid-link. */
  linking: string | null
}

export function graphScreen(): Screen {
  let live: Sigma | null = null

  return {
    id: 'graph',
    title: 'Graph',
    needsProject: true,

    leave(): void {
      live?.kill()
      live = null
    },

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
        enableEdgeEvents: false,
      })

      live = renderer

      const emphasis: Emphasis ={ hits: null, hovered: null, near: new Set(), linking: null }

      wireEmphasis(renderer, graph, emphasis)
      wireDragging(surface, renderer, graph, detail, emphasis)
      wireHighlight(surface, renderer, query, emphasis)

      showHelp(detail)
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

/**
 * The hover and search emphasis, as one pair of reducers.
 *
 * A hovered note keeps its colour along with everything it touches, and the
 * edges between them are drawn thicker and in the accent; the rest of the graph
 * goes flat grey and loses its labels. Direction is kept — the arrow still
 * says which note points at which — because a backlink and a link are not the
 * same fact.
 */
function wireEmphasis(renderer: Sigma, graph: Graph, emphasis: Emphasis): void {
  renderer.setSetting('nodeReducer', (node, data) => {
    if (emphasis.linking === node) {
      return { ...data, zIndex: 2, size: Number(data['size'] ?? 4) * 1.4, highlighted: true }
    }

    if (emphasis.hovered !== null) {
      if (node === emphasis.hovered) {
        return { ...data, zIndex: 2, size: Number(data['size'] ?? 4) * 1.4, forceLabel: true }
      }
      if (emphasis.near.has(node)) return { ...data, zIndex: 1, forceLabel: true }
      return { ...data, color: DIMMED_NODE, label: '', zIndex: 0 }
    }

    if (emphasis.hits === null) return data
    if (emphasis.hits.has(node)) {
      return { ...data, zIndex: 1, size: Number(data['size'] ?? 4) * 1.6 }
    }

    return { ...data, color: DIMMED_NODE, label: '', zIndex: 0 }
  })

  renderer.setSetting('edgeReducer', (edge, data) => {
    if (emphasis.hovered !== null) {
      const touches =
        graph.source(edge) === emphasis.hovered || graph.target(edge) === emphasis.hovered

      return touches
        ? { ...data, color: ACTIVE_EDGE, size: Number(data['size'] ?? 1) * 2.4, zIndex: 1 }
        : { ...data, color: DIMMED_EDGE, zIndex: 0 }
    }

    if (emphasis.hits === null) return data

    // A search dims the edges too, or the highlighted notes sit in a web that
    // is just as loud as they are.
    const both = emphasis.hits.has(graph.source(edge)) && emphasis.hits.has(graph.target(edge))
    return both ? data : { ...data, color: DIMMED_EDGE, zIndex: 0 }
  })

  renderer.on('enterNode', ({ node }) => {
    emphasis.hovered = node
    emphasis.near = new Set([node, ...graph.neighbors(node)])
    renderer.refresh()
  })

  renderer.on('leaveNode', () => {
    emphasis.hovered = null
    emphasis.near = new Set()
    renderer.refresh()
  })
}

function shiftHeld(original: MouseEvent | TouchEvent): boolean {
  return 'shiftKey' in original && original.shiftKey
}

/**
 * Moving a node, selecting one, and linking two.
 *
 * All three start the same way — a press on a node — so they are one state
 * machine. Which one it becomes is decided by the shift key at the moment of
 * the press and by whether the pointer travelled: a mouse moves a few pixels
 * under a finger that meant to click, so a short drag is still a click.
 *
 * Camera panning is off for the duration of any press that started on a node.
 * Otherwise the drag pans the view, the node slides out from under the pointer,
 * and the gesture ends somewhere nobody aimed at.
 *
 * `setCustomBBox` is what keeps the camera still while a node is dragged past
 * the edge of the layout: without it sigma recomputes the bounding box, and
 * dragging one node outward zooms the whole graph out from under the hand.
 */
function wireDragging(
  surface: Surface,
  renderer: Sigma,
  graph: Graph,
  detail: HTMLElement,
  emphasis: Emphasis,
): void {
  const camera = renderer.getCamera()
  const captor = renderer.getMouseCaptor()
  const container = renderer.getContainer()

  let held: string | null = null
  let linking = false
  let moved = false
  let origin: { x: number; y: number } | null = null

  const finish = (): void => {
    held = null
    linking = false
    origin = null
    emphasis.linking = null
    camera.enabledPanning = true
    container.style.cursor = ''
    renderer.refresh()
  }

  renderer.on('downNode', ({ node, event }) => {
    // A phantom can be neither moved nor linked: there is no note behind it,
    // and its position is meaningless because we invented it.
    if (graph.getNodeAttribute(node, 'phantom') === true) {
      held = null
      return
    }

    held = node
    linking = shiftHeld(event.original)
    moved = false
    origin = { x: event.x, y: event.y }

    emphasis.linking = linking ? node : null
    camera.enabledPanning = false
    if (renderer.getCustomBBox() === null) renderer.setCustomBBox(renderer.getBBox())
    container.style.cursor = linking ? 'crosshair' : 'grabbing'
  })

  captor.on('mousemovebody', (event) => {
    if (held === null || origin === null) return

    if (!moved && Math.hypot(event.x - origin.x, event.y - origin.y) > 4) moved = true
    if (!moved) return

    if (!linking) {
      const position = renderer.viewportToGraph(event)
      graph.setNodeAttribute(held, 'x', position.x)
      graph.setNodeAttribute(held, 'y', position.y)
    }

    // Sigma would otherwise treat this as a camera gesture, and the browser as
    // a text selection.
    event.preventSigmaDefault()
    event.original.preventDefault()
    event.original.stopPropagation()
  })

  renderer.on('upNode', ({ node }) => {
    const source = held
    const dragged = moved
    const wasLinking = linking

    // A press that did not start on a note: the only thing an ending on one
    // can mean is that a phantom was clicked.
    if (source === null) {
      if (!dragged && graph.getNodeAttribute(node, 'phantom') === true) describePhantom(detail, node)
      return
    }

    if (!dragged) {
      void showNote(surface, detail, source)
      return
    }

    // A node follows the pointer, so a move always ends with the pointer over
    // the node it started on. Reading that as a click on it — which is what
    // `node === source` used to mean, back when a drag was only ever a link —
    // opened the note every time one was nudged.
    if (!wasLinking || node === source) return
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

  captor.on('mouseup', finish)

  // The pointer can leave the canvas without sigma noticing it left a node —
  // straight off the edge, or onto the panel — and the graph would stay lit up
  // around a note nobody is pointing at any more.
  captor.on('mouseleave', () => {
    emphasis.hovered = null
    emphasis.near = new Set()
    finish()
  })
}

function showHelp(detail: HTMLElement): void {
  show(detail, [
    el('h2', { text: 'The graph' }),
    el('ul', { class: 'help' }, [
      el('li', { text: 'Click a note to read it here.' }),
      el('li', { text: 'Drag a note to move it.' }),
      el('li', { text: 'Hover a note to light up what it is connected to.' }),
      el('li', { text: 'Shift-drag from one note onto another to link them.' }),
    ]),
    el('p', {
      class: 'hint',
      text: 'A grey node on a dashed edge is a link to an id that does not exist. It is kept as written.',
    }),
  ])
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

/**
 * The note itself, rendered, in the panel beside the graph.
 *
 * It used to be a title and a dozen terms, which answered "which note is this"
 * and nothing after it. Reading a note is the reason to click one, and going to
 * the editor to do it loses the graph — and the layout just arranged by hand.
 */
async function showNote(surface: Surface, detail: HTMLElement, id: string): Promise<void> {
  show(detail, [el('p', { class: 'hint', text: 'loading…' })])

  try {
    const note = await api.note(surface.project, id)

    const body = el('div', { class: 'preview' })
    // The one place this page produces markup, and every character of the note
    // went through an escape on the way (see markdown.ts).
    body.innerHTML = renderMarkdown(note.body)

    show(detail, [
      el('div', { class: 'graph-detail-head' }, [
        el('h2', { text: note.title }),
        el('p', { class: 'id', text: `${note.id} · rev ${note.rev} · ${note.status}` }),
        el('p', {}, [
          el('button', { text: 'Edit', onclick: () => surface.go('note', note.id) }),
          el('span', {
            class: 'hint',
            text: ` ${note.links.length} out · ${note.backlinks.length} back`,
          }),
        ]),
        ...(note.terms.length === 0
          ? []
          : [
              el(
                'p',
                { class: 'terms' },
                note.terms.slice(0, 12).map((term) => el('span', { class: 'tag', text: term.term })),
              ),
            ]),
      ]),
      body,
    ])

    // A wikilink in the preview moves the panel rather than leaving the graph.
    body.addEventListener('click', (event) => {
      const anchor = (event.target as Element | null)?.closest('a.wiki')
      const href = anchor?.getAttribute('href') ?? ''
      const target = href.startsWith('#note/') ? decodeURIComponent(href.slice(6)) : null
      if (target === null) return

      event.preventDefault()
      void showNote(surface, detail, target)
    })
  } catch (error) {
    surface.fail(error)
  }
}

function show(detail: HTMLElement, children: Node[]): void {
  detail.replaceChildren(...children)
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
      el('button', { text: 'Cancel', onclick: () => showHelp(detail) }),
    ]),
  ])
}

/** A query dims everything it did not match, so the hits keep their position. */
function wireHighlight(
  surface: Surface,
  renderer: Sigma,
  query: HTMLInputElement,
  emphasis: Emphasis,
): void {
  let generation = 0

  const run = async (): Promise<void> => {
    const mine = ++generation

    if (query.value.trim() === '') {
      emphasis.hits = null
      renderer.refresh()
      return
    }

    try {
      const result = await api.search(surface.project, { query: query.value, limit: 25 })
      if (mine !== generation) return
      emphasis.hits = new Set(result.hits.map((hit) => hit.id))
      renderer.refresh()
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
