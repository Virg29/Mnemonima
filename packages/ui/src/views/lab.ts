import { api } from '../api.js'
import type { Hit, SearchResult } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { failure } from '../app.js'
import { clear, el, empty } from '../dom.js'
import { KNOB_GROUPS, valueAt } from '../knobs.js'

/**
 * The search lab — DESIGN.md 13.4.
 *
 * The screen exists because tuning weights without seeing the effect is
 * guesswork. Every knob is a per-query override, so moving one re-runs the
 * search against the same warm index and nothing is written; the numbers move
 * immediately and the configuration does not until "Save" is pressed.
 *
 * Each hit shows its `why` as a stacked bar. The parts sum to the score exactly
 * (DESIGN.md 8.6), which is the whole reason the fusion takes the best chunk per
 * strategy rather than a sum, so the bar is a picture of the arithmetic rather
 * than an impression of it.
 */

const MODES = ['hybrid', 'semantic', 'lexical', 'exact', 'id'] as const

export function labScreen(): Screen {
  return {
    id: 'lab',
    title: 'Search lab',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const { config } = await api.config(surface.project)

      /** What the knobs are set to now, as dotted paths — the override body. */
      const overrides = new Map<string, number>()
      const results = el('div')
      const meta = el('span', { class: 'hint' })

      const query = el('input', {
        type: 'search',
        class: 'grow',
        placeholder: 'how a fragment shader runs',
        value: surface.argument ?? '',
      })

      const mode = el('select', {}, MODES.map((name) => el('option', { value: name, text: name })))
      mode.value = String((config['search'] as Record<string, unknown>)['mode'] ?? 'hybrid')

      let generation = 0

      const run = async (): Promise<void> => {
        if (query.value.trim() === '') {
          clear(results)
          results.append(
            empty('Nothing searched yet.', 'Type a query; every knob re-runs it as you move it.'),
          )
          meta.textContent = ''
          return
        }

        // Only the newest answer may paint. A slider produces a request per
        // step, and they do not necessarily come back in order.
        const mine = ++generation

        try {
          const result = await api.search(surface.project, {
            query: query.value,
            mode: mode.value,
            ...(overrides.size === 0
              ? {}
              : { overrides: Object.fromEntries(overrides) as Record<string, unknown> }),
          })

          if (mine !== generation) return
          paint(surface, results, meta, result)
        } catch (error) {
          if (mine !== generation) return
          clear(results)
          results.append(failure(error))
          meta.textContent = ''
        }
      }

      const save = el('button', {
        text: 'Save these',
        disabled: true,
        onclick: async () => {
          try {
            await api.setConfig(surface.project, Object.fromEntries(overrides))
            surface.reload()
          } catch (error) {
            surface.fail(error)
          }
        },
      })

      const reset = el('button', {
        text: 'Reset',
        disabled: true,
        onclick: () => surface.reload(),
      })

      const touched = (): void => {
        save.disabled = overrides.size === 0
        reset.disabled = overrides.size === 0
      }

      surface.bar.append(
        query,
        mode,
        el('button', { class: 'primary', text: 'Search', onclick: () => void run() }),
        save,
        reset,
        meta,
      )

      query.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') void run()
      })
      mode.addEventListener('change', () => void run())

      surface.body.append(
        el('div', { class: 'split' }, [
          panel(config, overrides, () => {
            touched()
            void run()
          }),
          results,
        ]),
      )

      await run()
    },
  }
}

/** The knob column. One row per setting, live-updating its own read-out. */
function panel(
  config: Record<string, unknown>,
  overrides: Map<string, number>,
  changed: () => void,
): HTMLElement {
  const column = el('div')

  for (const group of KNOB_GROUPS) {
    const rows = group.knobs.map((knob) => {
      const stored = valueAt(config, knob.path)
      const readout = el('span', { class: 'id', text: format(stored) })

      const slider = el('input', {
        type: 'range',
        min: knob.min,
        max: knob.max,
        step: knob.step,
        value: stored,
        title: knob.hint ?? knob.path,
      })

      slider.addEventListener('input', () => {
        const value = Number(slider.value)
        readout.textContent = format(value)

        // Back at the stored value is not an override: leaving it in the map
        // would make "Save" write settings the operator never moved.
        if (value === stored) overrides.delete(knob.path)
        else overrides.set(knob.path, value)

        readout.className = value === stored ? 'id' : 'id warn'
        changed()
      })

      return el('div', { class: 'knob' }, [
        el('label', { text: knob.label, title: knob.path }),
        slider,
        readout,
      ])
    })

    column.append(
      el('div', { class: 'card' }, [
        el('h2', { text: group.title }),
        el('p', { class: 'hint', text: group.hint }),
        ...rows,
      ]),
    )
  }

  return column
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function paint(
  surface: Surface,
  results: HTMLElement,
  meta: HTMLElement,
  result: SearchResult,
): void {
  clear(results)

  meta.textContent =
    `${result.hits.length} of ${result.candidates} candidates · ${Math.round(result.tookMs)} ms` +
    (result.model === null ? '' : ` · ${result.model}`)

  if (result.warning !== null) {
    results.append(el('p', { class: 'hint warn', text: result.warning }))
  }

  if (result.hits.length === 0) {
    results.append(
      empty(
        'Nothing matched.',
        'Widen the candidate set, lower the similarity floor, or try lexical mode.',
      ),
    )
    return
  }

  for (const hit of result.hits) results.append(hitCard(surface, hit))
}

/** The five parts of `why`, drawn in the proportion they contribute. */
const PARTS: { key: keyof Hit['why']; label: string; colour: string }[] = [
  { key: 'text', label: 'text', colour: 'var(--accent)' },
  { key: 'vector', label: 'vector', colour: 'var(--ok)' },
  { key: 'meta', label: 'meta', colour: 'var(--warn)' },
  { key: 'graph', label: 'graph', colour: 'var(--bad)' },
  { key: 'multiChunk', label: 'multi-chunk', colour: 'var(--muted)' },
]

function hitCard(surface: Surface, hit: Hit): HTMLElement {
  const total = PARTS.reduce((sum, part) => sum + Math.max(0, Number(hit.why[part.key])), 0)

  const bar = el(
    'div',
    { class: 'why' },
    PARTS.filter((part) => Number(hit.why[part.key]) > 0).map((part) =>
      el('span', {
        style: `width:${((Number(hit.why[part.key]) / (total || 1)) * 100).toFixed(2)}%;background:${part.colour}`,
        title: `${part.label}: ${Number(hit.why[part.key]).toFixed(3)}`,
      }),
    ),
  )

  const legend = el(
    'p',
    { class: 'hint' },
    PARTS.filter((part) => Number(hit.why[part.key]) > 0).map((part) =>
      el('span', {
        class: 'tag',
        text: `${part.label} ${Number(hit.why[part.key]).toFixed(3)}`,
      }),
    ),
  )

  return el('div', { class: 'card' }, [
    el('div', { class: 'bar', style: 'padding:0;border:0' }, [
      el('a', {
        href: `#note/${encodeURIComponent(hit.id)}`,
        text: hit.title,
        onclick: (event: Event) => {
          event.preventDefault()
          surface.go('note', hit.id)
        },
      }),
      el('span', { class: 'id', text: hit.id }),
      el('span', { class: 'grow' }),
      el('span', { class: 'id', text: hit.score.toFixed(3) }),
    ]),
    bar,
    legend,
    ...(hit.via === null
      ? []
      : [
          el('p', {
            class: 'hint',
            text: `added by the graph, on the word of ${hit.via.join(', ')}`,
          }),
        ]),
    ...hit.snippets.map((snippet) =>
      el('blockquote', {}, [
        el('div', {
          class: 'hint id',
          text: `${snippet.headingPath ?? '—'} · ${snippet.strategy} · ${snippet.score.toFixed(3)}`,
        }),
        el('div', { text: snippet.text }),
      ]),
    ),
  ])
}
