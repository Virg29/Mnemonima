import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import Sigma from 'sigma'
import { api } from '../api.js'
import type { GraphView, NoteExplanation, NoteView } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { el } from '../dom.js'
import { markdownEditor } from '../editor.js'
import type { NoteChoice } from '../editor.js'
import { LayoutStore, resolveLayout } from '../layout.js'
import type { Position } from '../layout.js'
import { renderMarkdown } from '../markdown.js'
import { describeFields, describeMatch, markedBy } from '../matches.js'
import { isDark, onThemeChange } from '../theme.js'

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

const ACTIVE_EDGE = '#2f6feb'

/**
 * What "dimmed" and "readable" mean, which depends on the ground.
 *
 * These were fixed light values, and on the dark theme that inverted the whole
 * screen: a note the query did not match was painted near-white and so came out
 * *brighter* than every hit, the unmatched edges drew a bright web over the
 * heat map, and the labels were black on near-black. The one thing a search is
 * supposed to make quiet was the loudest thing on the page.
 */
interface Ground {
  readonly dimNode: string
  readonly dimEdge: string
  /** A resolved link, at rest. */
  readonly edge: string
  /** A link to an id that does not exist, at rest. */
  readonly dangling: string
  readonly label: string
}

const LIGHT: Ground = {
  dimNode: '#dfe3e8',
  dimEdge: '#eceef1',
  edge: '#c7ccd4',
  dangling: '#e0a0a0',
  label: '#14171c',
}

const DARK: Ground = {
  dimNode: '#2a3038',
  dimEdge: '#242a32',
  edge: '#3b434e',
  dangling: '#6d4046',
  label: '#c9d0d9',
}

function currentGround(): Ground {
  return isDark() ? DARK : LIGHT
}

/**
 * The ramp a search paints its hits with, as `[position, r, g, b]`.
 *
 * Black-body order: indigo for the weakest match, red through the middle,
 * amber at the hot end. The stops are **not** evenly spaced — red sits at 0.57
 * — which is what keeps the top of the range readable: an even three-stop ramp
 * spends half its length getting out of the blues, and the difference between a
 * good answer and the best one is the part worth seeing.
 *
 * It stops short of yellow because the page is white as often as it is dark,
 * and a yellow disc on white is a disc nobody can find — the hottest note was
 * the hardest one to see, which is the exact inverse of the point.
 *
 * RGB triples rather than a CSS colour string because sigma's parser reads hex,
 * `rgb()` and the named HTML colours and nothing else — an `hsl()` string does
 * not fail, it comes out black.
 */
const HEAT: readonly (readonly [number, number, number, number])[] = [
  [0, 70, 58, 180],
  [0.57, 237, 0, 0],
  [1, 253, 175, 29],
]

/** A point on that ramp, `0` cold and `1` hot. */
function heat(value: number): string {
  const t = Math.min(1, Math.max(0, value))

  let index = 0
  while (index < HEAT.length - 2 && t > (HEAT[index + 1]?.[0] ?? 1)) index += 1

  const from = HEAT[index]!
  const to = HEAT[index + 1]!
  const span = to[0] - from[0]
  const fraction = span === 0 ? 0 : (t - from[0]) / span

  const mix = (channel: 1 | 2 | 3): number =>
    Math.round(from[channel] + (to[channel] - from[channel]) * fraction)

  return `rgb(${mix(1)}, ${mix(2)}, ${mix(3)})`
}

/**
 * Everything the side panel needs to draw itself and write back.
 *
 * Passed as one value because the three functions that render into it — the
 * note, the editor, the link dialog — each wanted a different four of these,
 * and a fourth parameter list was one too many.
 */
interface Panel {
  readonly surface: Surface
  readonly detail: HTMLElement
  readonly graph: Graph
  /** What the editor's `[[` completes over. */
  readonly notes: readonly NoteChoice[]
  /** The live search state, so the preview can mark what the query found. */
  readonly emphasis: Emphasis
}

/**
 * What the two reducers read.
 *
 * One object rather than a variable per feature: hovering and searching both
 * decide the colour of the same node, and two independent reducers would each
 * overwrite the other's answer depending on which refreshed last.
 */
interface Emphasis {
  /**
   * What a search matched, each note against its heat in `[0, 1]`, or null
   * when the box is empty.
   */
  hits: Map<string, number> | null
  /** The note under the pointer. */
  hovered: string | null
  /** The hovered note and its neighbours. */
  near: Set<string>
  /** The note being dragged from with shift held, mid-link. */
  linking: string | null
  /** The query behind `hits`, kept so a preview can explain itself. */
  query: string | null
}

export function graphScreen(): Screen {
  let live: Sigma | null = null
  let layout: LayoutStore | null = null

  // Registered once, for the life of the page: a tab closed mid-arrangement is
  // the case the local copy exists for, but flushing here means the other
  // machines see it too. `keepalive`, because an ordinary request would be
  // cancelled by the unload.
  window.addEventListener('pagehide', () => {
    void layout?.flush(true)
  })

  return {
    id: 'graph',
    title: 'Graph',
    needsProject: true,

    leave(): void {
      live?.kill()
      live = null

      // Leaving the screen is the commonest way a drag would be lost, so the
      // pending moves go out now rather than waiting for a timer that dies
      // with the screen.
      void layout?.flush()
      layout = null
    },

    async render(surface: Surface): Promise<void> {
      // The note list is for the editor's `[[` completion. Asked for alongside
      // the graph rather than when Edit is first pressed, so opening the editor
      // is instant and never fails halfway into a gesture.
      const [view, listing] = await Promise.all([
        api.graph(surface.project),
        api.notes(surface.project, 500),
      ])

      const canvas = el('div', { class: 'graph' })
      const detail = el('div', { class: 'graph-detail' })
      const handle = el('div', { class: 'splitter', title: 'Drag to resize' })
      const query = el('input', {
        type: 'search',
        class: 'grow',
        placeholder: 'highlight the notes that match…',
      })

      const legend = heatLegend()

      const placedCount = Object.keys(view.layout).length

      surface.bar.append(
        query,
        legend,
        el('span', {
          class: 'hint',
          text: `${view.nodes.length} notes, ${view.edges.length} links, ${view.phantoms.length} dangling`,
        }),
        el('button', {
          text: 'Arrange again',
          title:
            placedCount === 0
              ? 'Nothing has been placed by hand yet'
              : `Forget ${placedCount} placed note(s) and lay the graph out from scratch`,
          disabled: placedCount === 0,
          onclick: async () => {
            try {
              await layout?.reset()
              surface.reload()
            } catch (error) {
              surface.fail(error)
            }
          },
        }),
      )

      const split = el('div', { class: 'split graph-split' }, [canvas, handle, detail])
      surface.body.append(split)
      applyStoredWidth(split)

      const placed = resolveLayout(surface.project, view.layout)
      layout = new LayoutStore(surface.project).onError((error) => surface.fail(error))

      // Sigma measures the container, so it has to be in the document first.
      const graph = build(view, placed)

      // Whatever the layout just worked out becomes the remembered position.
      //
      // Storing only what was dragged was not enough: the force-directed pass
      // arranges the unplaced notes *around* the pinned ones, so pinning a
      // single note moved every other note on the next visit. The graph jumped
      // on every reload, which is worse than not remembering anything.
      //
      // Now a note is arranged once, on the first visit that sees it, and stays
      // where that put it. Everything after is a new note finding a spot in a
      // picture that no longer moves.
      const arranged = new Map<string, Position>()
      graph.forEachNode((id, attributes) => {
        if (placed.has(id)) return
        arranged.set(id, { x: Number(attributes['x']), y: Number(attributes['y']) })
      })
      layout.rememberMany(arranged)
      const renderer = new Sigma(graph, canvas, {
        defaultEdgeType: 'line',
        labelDensity: 0.6,
        labelRenderedSizeThreshold: 4,
        renderEdgeLabels: false,
        enableEdgeEvents: false,
      })

      live = renderer
      wireSplitter(split, handle, renderer)

      const emphasis: Emphasis = {
        hits: null,
        hovered: null,
        near: new Set(),
        linking: null,
        query: null,
      }
      const panel: Panel = { surface, detail, graph, notes: listing.notes, emphasis }

      wireEmphasis(renderer, graph, emphasis)
      wireDragging(panel, renderer, emphasis, layout)
      wireHighlight(surface, renderer, query, legend, emphasis)

      showHelp(detail)
    },
  }
}

/**
 * The graphology graph, laid out and coloured.
 *
 * A note that has been placed by hand keeps its position and is **fixed**, so
 * the force-directed pass arranges everything else around it rather than
 * sweeping it away. That is the whole point of remembering the layout: a new
 * note finds its own spot near its neighbours, and the picture somebody built
 * stays the picture they built.
 */
function build(view: GraphView, placed: ReadonlyMap<string, Position>): Graph {
  const graph = new Graph({ multi: false, type: 'directed' })

  for (const node of view.nodes) {
    const at = placed.get(node.id)

    graph.addNode(node.id, {
      label: node.title,
      title: node.title,
      phantom: false,
      degree: node.degree,
      size: 4 + Math.min(10, Math.sqrt(node.degree) * 3),
      x: at?.x ?? Math.cos(hash(node.id)) * 100,
      y: at?.y ?? Math.sin(hash(node.id)) * 100,
      fixed: at !== undefined,
    })
  }

  for (const node of view.phantoms) {
    const at = placed.get(node.id)

    graph.addNode(node.id, {
      label: node.id,
      title: `${node.id} — not a note here`,
      phantom: true,
      degree: node.degree,
      size: 3,
      color: '#9aa3af',
      x: at?.x ?? Math.cos(hash(node.id)) * 140,
      y: at?.y ?? Math.sin(hash(node.id)) * 140,
      fixed: at !== undefined,
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

  // Nothing to arrange when every node is already placed, and running the
  // layout anyway would be a second of work to produce the same picture.
  const unplaced = graph.reduceNodes(
    (count, _id, attributes) => count + (attributes['fixed'] === true ? 0 : 1),
    0,
  )

  if (graph.order > 1 && unplaced > 0) {
    forceAtlas2.assign(graph, {
      iterations: Math.max(50, Math.min(400, graph.order * 4)),
      settings: { ...forceAtlas2.inferSettings(graph), gravity: 1.2 },
    })
  }

  return graph
}

const PANEL_WIDTH = 'mnemonima.graph.panelWidth'
const PANEL_MIN = 280
const CANVAS_MIN = 320

/**
 * The remembered panel width, put on before sigma measures anything.
 *
 * Separate from the drag wiring because of the order the screen is built in:
 * sigma has to be constructed against a container that is already the right
 * size, and the container is only in the document once the split is appended.
 */
function applyStoredWidth(split: HTMLElement): void {
  const remembered = Number(read(PANEL_WIDTH))
  if (Number.isFinite(remembered) && remembered >= PANEL_MIN) {
    split.style.setProperty('--graph-panel', `${Math.round(remembered)}px`)
  }
}

/**
 * The bar between the graph and the panel, dragged to move it.
 *
 * The width is remembered per browser rather than per project: it is a property
 * of the window somebody is reading in, not of the notes. The custom property is
 * `--graph-panel` and not `--panel`, which `:root` already defines as the panel
 * *colour*: `var(--panel, 34%)` resolved to `#f6f7f9`, which made the whole
 * grid-template declaration invalid and collapsed the screen into one column.
 * `localStorage` is wrapped because a private window can refuse it, and a panel
 * that will not open is a worse failure than one that forgets how wide it was.
 *
 * **Sigma has to be told.** It does not observe its container — it re-measures
 * inside `render`, and the only thing that schedules one on its own is a
 * `window` resize. Moving the splitter is neither, so the column changed
 * immediately and the canvas kept its old pixel size until some later
 * interaction happened to trigger a frame: about half a second of the graph
 * visibly not fitting its box. `resize` then `refresh` on every pointer move is
 * what makes the canvas follow the bar instead of catching up with it.
 *
 * `skipIndexation` during the drag, a full refresh on release. Nothing about a
 * resize changes the graph's data, but the label grid is built from the
 * viewport, and rebuilding it sixty times a second is the one part worth
 * deferring to the end of the gesture.
 */
function wireSplitter(split: HTMLElement, handle: HTMLElement, renderer: Sigma): void {
  let dragging = false
  let frame = 0

  const apply = (width: number): void => {
    split.style.setProperty('--graph-panel', `${Math.round(width)}px`)

    // One resize per frame: pointermove can outrun rendering, and every extra
    // call would resize canvases nobody ever saw.
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      renderer.resize()
      renderer.refresh({ skipIndexation: true })
    })
  }

  /** The end of a gesture: one full refresh, with the label grid rebuilt. */
  const settle = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    renderer.resize()
    renderer.refresh()
  }

  /** Back to the default, for a panel dragged somewhere unusable. */
  const reset = (): void => {
    split.style.removeProperty('--graph-panel')
    write(PANEL_WIDTH, '')
    settle()
  }

  // Preventing the default action of `pointerdown` — which is what keeps the
  // drag from selecting the text either side of the bar — suppresses the
  // compatibility mouse events, `mousedown` among them. `dblclick` survives it,
  // which is why the reset hangs off that rather than off a click count on the
  // pointer event: `detail` is 0 on every pointer event, by specification.
  handle.addEventListener('dblclick', reset)

  handle.addEventListener('pointerdown', (event) => {
    dragging = true
    handle.setPointerCapture((event as PointerEvent).pointerId)
    handle.classList.add('dragging')
    event.preventDefault()
  })

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return

    const box = split.getBoundingClientRect()
    const wanted = box.right - (event as PointerEvent).clientX
    const most = Math.max(PANEL_MIN, box.width - CANVAS_MIN)

    apply(Math.min(most, Math.max(PANEL_MIN, wanted)))
  })

  const stop = (event: Event): void => {
    if (!dragging) return
    dragging = false
    handle.releasePointerCapture((event as PointerEvent).pointerId)
    handle.classList.remove('dragging')
    write(PANEL_WIDTH, String(split.getBoundingClientRect().width - handleLeft(split, handle)))
    settle()
  }

  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
}

/** How far the handle sits from the left edge of the split. */
function handleLeft(split: HTMLElement, handle: HTMLElement): number {
  return handle.getBoundingClientRect().right - split.getBoundingClientRect().left
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    if (value === '') localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // A browser that refuses storage still gets a working panel.
  }
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
  let ground = currentGround()

  const paint = (): void => {
    renderer.setSetting('labelColor', { color: ground.label })
    renderer.refresh()
  }

  // The theme can change with the page open — the switch in the sidebar, or the
  // system moving under `auto` — and the canvas is the one part of the page CSS
  // cannot restyle on its own.
  onThemeChange(() => {
    ground = currentGround()
    paint()
  })
  renderer.setSetting('nodeReducer', (node, data) => {
    // A hit is repainted rather than merely enlarged. The Louvain colour says
    // which cluster a note belongs to, which is the wrong question while a
    // query is on screen; the heat says how well it answered it. Size follows
    // the same number, so the best answers are what the eye lands on.
    //
    // Applied first, as the base every other state builds on, so that hovering
    // during a search keeps the heat instead of putting the cluster colours
    // back under the pointer.
    const hit = emphasis.hits?.get(node)
    const base =
      hit === undefined
        ? data
        : {
            ...data,
            color: heat(hit),
            size: Number(data['size'] ?? 4) * (1.25 + hit * 0.75),
          }

    const size = Number(base['size'] ?? 4)

    if (emphasis.linking === node) {
      return { ...base, zIndex: 2, size: size * 1.4, highlighted: true }
    }

    if (emphasis.hovered !== null) {
      if (node === emphasis.hovered) {
        return { ...base, zIndex: 2, size: size * 1.4, forceLabel: true }
      }
      if (emphasis.near.has(node)) return { ...base, zIndex: 1, forceLabel: true }
      return { ...data, color: ground.dimNode, label: '', zIndex: 0 }
    }

    if (emphasis.hits === null) return data
    if (hit !== undefined) return { ...base, zIndex: 1, forceLabel: hit > 0.75 }

    return { ...data, color: ground.dimNode, label: '', zIndex: 0 }
  })

  renderer.setSetting('edgeReducer', (edge, data) => {
    if (emphasis.hovered !== null) {
      const touches =
        graph.source(edge) === emphasis.hovered || graph.target(edge) === emphasis.hovered

      return touches
        ? { ...data, color: ACTIVE_EDGE, size: Number(data['size'] ?? 1) * 2.4, zIndex: 1 }
        : { ...data, color: ground.dimEdge, zIndex: 0 }
    }

    // At rest, the ground decides. The colour a link is built with was picked
    // for a white page and glowed on a dark one.
    const resting = {
      ...data,
      color: data['resolved'] === false ? ground.dangling : ground.edge,
    }

    if (emphasis.hits === null) return resting

    // A search dims the edges too, or the highlighted notes sit in a web that
    // is just as loud as they are.
    const both = emphasis.hits.has(graph.source(edge)) && emphasis.hits.has(graph.target(edge))
    return both ? resting : { ...data, color: ground.dimEdge, zIndex: 0 }
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

  paint()
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
  panel: Panel,
  renderer: Sigma,
  emphasis: Emphasis,
  layout: LayoutStore,
): void {
  const { surface, detail, graph } = panel

  const camera = renderer.getCamera()
  const captor = renderer.getMouseCaptor()
  const container = renderer.getContainer()

  let held: string | null = null
  let linking = false
  let moved = false
  let origin: { x: number; y: number } | null = null

  const finish = (): void => {
    // Where it was let go is where it stays. Written locally at once and
    // synced on a timer, so a reload or a closed tab keeps it either way.
    if (held !== null && moved && !linking) {
      layout.remember(held, {
        x: Number(graph.getNodeAttribute(held, 'x')),
        y: Number(graph.getNodeAttribute(held, 'y')),
      })
    }

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
      // Placed by hand from now on: a later layout arranges around it rather
      // than over it.
      graph.setNodeAttribute(held, 'fixed', true)
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
      void showNote(panel, source)
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

    confirmLink(panel, source, node)
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
async function showNote(panel: Panel, id: string): Promise<void> {
  const { surface, detail } = panel

  show(detail, [el('p', { class: 'hint', text: 'loading…' })])

  try {
    // Both at once: the explanation is a second round trip, and asking for it
    // after the note would show the body unmarked and then move it.
    const [note, explanation] = await Promise.all([
      api.note(surface.project, id),
      explain(panel, id),
    ])

    showPreview(panel, note, explanation)
  } catch (error) {
    surface.fail(error)
  }
}

/**
 * What the search on this screen found in one note, or null when there is no
 * search on screen.
 *
 * A failure is reported and swallowed: not being able to explain a note is no
 * reason to refuse to show it.
 */
async function explain(panel: Panel, id: string): Promise<NoteExplanation | null> {
  const query = panel.emphasis.query
  if (query === null) return null

  try {
    return await api.explain(panel.surface.project, id, query)
  } catch (error) {
    panel.surface.fail(error)
    return null
  }
}

function showPreview(panel: Panel, note: NoteView, explanation: NoteExplanation | null): void {
  const { surface, detail } = panel

  const body = el('div', { class: 'preview' })
  // The one place this page produces markup, and every character of the note
  // went through an escape on the way (see markdown.ts).
  body.innerHTML = renderMarkdown(note.body, markedBy(explanation))

  const fields = explanation === null ? null : describeFields(explanation)

  show(detail, [
    head(note, [
      el('button', { text: 'Edit', onclick: () => showEditor(panel, note) }),
      el('button', {
        text: 'Open',
        title: 'The full editor, with terms and backlinks',
        onclick: () => surface.go('note', note.id, panel.emphasis.query ?? undefined),
      }),
      el('span', {
        class: 'hint',
        text: ` ${note.links.length} out · ${note.backlinks.length} back`,
      }),
    ]),
    // What the search on this screen found in this note, said the same way the
    // note screen says it.
    ...(explanation === null
      ? []
      : [
          el('p', { class: 'hint matched-summary' }, [
            el('span', { text: describeMatch(explanation) }),
            ...(fields === null ? [] : [el('span', { text: ` · ${fields}` })]),
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
    void showNote(panel, target)
  })
}

/**
 * The editor, in the panel, over the note that is selected.
 *
 * The same CodeMirror the notes screen uses, over the same `PUT` with the same
 * `expectedRev`, so a second window editing the same note is refused here
 * exactly as it is there. What this screen adds is not a shortcut around the
 * write path — it is not having to leave the graph to use it.
 */
function showEditor(panel: Panel, note: NoteView): void {
  const { surface, detail } = panel

  const status = el('span', { class: 'hint' })
  const code = el('div', { class: 'code' })

  const save = el('button', {
    class: 'primary',
    text: 'Save',
    onclick: async () => {
      status.textContent = 'saving…'
      status.className = 'hint'

      try {
        await api.updateNote(surface.project, note.id, view.state.doc.toString(), note.rev)

        // Re-read rather than patching the note in hand: `PUT` answers with a
        // revision number, and the daemon has meanwhile resolved the links the
        // edit changed — which is what the graph needs.
        const fresh = await api.note(surface.project, note.id)
        syncEdges(panel, fresh)
        showPreview(panel, fresh, await explain(panel, note.id))
      } catch (error) {
        surface.fail(error)
      }
    },
  })

  const view = markdownEditor({
    doc: note.body,
    notes: panel.notes,
    onChange: () => {
      status.textContent = 'unsaved'
      status.className = 'hint warn'
    },
    onSave: () => save.click(),
  })

  code.append(view.dom)

  show(detail, [
    head(note, [
      save,
      el('button', { text: 'Cancel', onclick: () => void showNote(panel, note.id) }),
      status,
    ]),
    code,
  ])

  view.focus()
}

/** The title block every state of the panel shares. */
function head(note: NoteView, actions: Node[]): HTMLElement {
  return el('div', { class: 'graph-detail-head' }, [
    el('h2', { text: note.title }),
    el('p', { class: 'id', text: `${note.id} · rev ${note.rev} · ${note.status}` }),
    el('p', { class: 'actions' }, actions),
  ])
}

/**
 * The edges of one note, brought up to date without rebuilding the graph.
 *
 * A save can add or remove a link, and the graph has to say so. Reloading the
 * screen would be the easy way and is the wrong one: it re-runs the layout and
 * throws away the arrangement somebody just made by hand.
 *
 * Only edges between notes that are already on screen. A brand new dangling
 * target has no phantom node yet, and inventing one here would duplicate what
 * `build` does from the server's own count — that one waits for a reload.
 */
function syncEdges(panel: Panel, note: NoteView): void {
  const { graph } = panel
  if (!graph.hasNode(note.id)) return

  const wanted = new Set(
    note.links.filter((link) => link.resolved && graph.hasNode(link.dst)).map((link) => link.dst),
  )

  for (const edge of graph.outEdges(note.id)) {
    if (!wanted.has(graph.target(edge))) graph.dropEdge(edge)
  }

  for (const target of wanted) {
    if (graph.hasEdge(note.id, target)) continue
    graph.addDirectedEdge(note.id, target, { size: 1, color: '#c7ccd4', resolved: true })
  }
}

function show(detail: HTMLElement, children: Node[]): void {
  detail.replaceChildren(...children)
}

function confirmLink(panel: Panel, from: string, to: string): void {
  const { surface, detail, graph } = panel

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

/**
 * The heat of each hit, on a scale stretched across the result set.
 *
 * The top hit is always 1 and the weakest returned is always 0, so the ramp
 * spans whatever came back. Not the rank — the *score*, normalised — because
 * the two differ exactly where it matters: a note tied with the top stays red
 * instead of being demoted for being second, and a note that scored half as
 * well sits halfway down the ramp whatever position it holds.
 *
 * It is the same trade the fusion already makes for BM25 (DESIGN.md 8.4): a
 * per-set normalisation says nothing about how one query compares with another,
 * and everything about how these results compare with each other, which is the
 * only question a picture of one result set can answer.
 */
function heatOf(hits: readonly { id: string; score: number }[]): Map<string, number> {
  const scores = hits.map((hit) => hit.score)
  const top = Math.max(...scores)
  const bottom = Math.min(...scores)
  const range = top - bottom

  return new Map(
    // A single hit, or a set that scored identically, is all top: there is no
    // gradient to draw and pretending otherwise would invent a ranking.
    hits.map((hit) => [hit.id, range === 0 ? 1 : (hit.score - bottom) / range]),
  )
}

/**
 * A query dims everything it did not match, so the hits keep their position,
 * and paints what it did match by how well it matched.
 */
function wireHighlight(
  surface: Surface,
  renderer: Sigma,
  query: HTMLInputElement,
  legend: HTMLElement,
  emphasis: Emphasis,
): void {
  let generation = 0

  const run = async (): Promise<void> => {
    const mine = ++generation

    if (query.value.trim() === '') {
      emphasis.hits = null
      emphasis.query = null
      legend.classList.remove('on')
      renderer.refresh()
      return
    }

    try {
      const result = await api.search(surface.project, { query: query.value, limit: 25 })
      if (mine !== generation) return

      emphasis.hits = heatOf(result.hits)
      emphasis.query = query.value
      legend.classList.toggle('on', result.hits.length > 0)
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

/** The key to the ramp, shown only while a search is on screen. */
function heatLegend(): HTMLElement {
  const strip = el('span', { class: 'heat-strip' })
  // Built from the same stops the nodes are painted from, positions included,
  // so the key cannot drift away from what it is a key to.
  strip.style.background = `linear-gradient(90deg, ${HEAT.map(
    ([at, r, g, b]) => `rgb(${r}, ${g}, ${b}) ${Math.round(at * 100)}%`,
  ).join(', ')})`

  return el('span', { class: 'heat-legend' }, [
    el('span', { class: 'hint', text: 'weaker' }),
    strip,
    el('span', { class: 'hint', text: 'stronger' }),
  ])
}
