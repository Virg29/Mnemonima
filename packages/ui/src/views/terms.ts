import { api } from '../api.js'
import type { VocabularyEntry } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { el, empty, table } from '../dom.js'

/**
 * The project vocabulary — DESIGN.md 13.5.
 *
 * Three lists, because the terms in them are not the same kind of thing. Manual
 * terms are a gazetteer: matched literally in every note whatever an extractor
 * thinks, and weighted above anything automatic. Automatic terms are derived
 * and come back on the next index run. Candidates are automatic terms that have
 * appeared often enough, and confidently enough, to be worth a decision.
 *
 * Every action here is reversible except one. `remove` forgets a term outright
 * and is refused unless the project turns destructive operations on; `block` is
 * the form that survives the next extraction, and the screen says so rather
 * than letting the operator find out by failing.
 */
export function termsScreen(): Screen {
  return {
    id: 'terms',
    title: 'Terms',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const vocabulary = await api.terms(surface.project)

      const act = async (term: string, action: string): Promise<void> => {
        try {
          await api.changeTerm(surface.project, term, action)
          surface.reload()
        } catch (error) {
          surface.fail(error)
        }
      }

      const entry = el('input', { class: 'grow', placeholder: 'fragment shader' })

      surface.bar.append(
        entry,
        el('button', {
          class: 'primary',
          text: 'Add by hand',
          onclick: () => {
            if (entry.value.trim() !== '') void act(entry.value.trim(), 'add')
          },
        }),
        el('span', { class: 'grow' }),
        el('button', { text: 'Refresh', onclick: () => surface.reload() }),
      )

      const terms = vocabulary.terms ?? []
      const manual = terms.filter((term) => term.pinned && !term.blocked)
      const blocked = terms.filter((term) => term.blocked)
      const automatic = terms.filter((term) => !term.pinned && !term.blocked)

      section(surface.body, 'By hand', manual, [
        'Matched literally in every note, and weighted above anything automatic.',
        'Never overwritten by an extraction.',
      ])
      if (manual.length > 0) {
        surface.body.append(
          rows(manual, (term) => [
            el('button', { text: 'Block', onclick: () => void act(term.term, 'block') }),
          ]),
        )
      }

      section(surface.body, 'Waiting for a decision', vocabulary.candidates ?? [], [
        'Automatic terms above both thresholds: seen in enough notes, and scored well in at least one.',
        'Pin the useful ones, block the noise.',
      ])
      if ((vocabulary.candidates ?? []).length > 0) {
        surface.body.append(
          rows(vocabulary.candidates, (term) => [
            el('button', { text: 'Pin', onclick: () => void act(term.term, 'pin') }),
            el('button', { text: 'Block', onclick: () => void act(term.term, 'block') }),
          ]),
        )
      }

      section(surface.body, 'Blocked', blocked, [
        'Kept out of every future extraction. Reversible, which is why it is the form to prefer.',
      ])
      if (blocked.length > 0) {
        surface.body.append(
          rows(blocked, (term) => [
            el('button', { text: 'Unblock', onclick: () => void act(term.term, 'unblock') }),
            el('button', {
              text: 'Forget',
              title: 'Destructive: refused unless mcp.allowDestructive is on.',
              onclick: () => void act(term.term, 'remove'),
            }),
          ]),
        )
      }

      section(surface.body, 'Extracted', automatic, [
        'Derived from the bodies by fusing YAKE, corpus IDF and the note vector.',
        'An index run rebuilds them, so editing them here would not survive.',
      ])
      if (automatic.length > 0) {
        surface.body.append(
          rows(automatic, (term) => [
            el('button', { text: 'Pin', onclick: () => void act(term.term, 'pin') }),
            el('button', { text: 'Block', onclick: () => void act(term.term, 'block') }),
          ]),
        )
      }
    },
  }
}

function section(
  body: HTMLElement,
  title: string,
  items: readonly VocabularyEntry[],
  hints: string[],
): void {
  body.append(el('h2', { text: `${title} (${items.length})` }))
  for (const hint of hints) body.append(el('p', { class: 'hint', text: hint }))
  if (items.length === 0) body.append(empty('Nothing here yet.'))
}

function rows(
  items: readonly VocabularyEntry[],
  actions: (term: VocabularyEntry) => HTMLElement[],
): HTMLElement {
  return table(
    ['term', 'lemma', 'notes', 'weight', ''],
    items.map((term) => [
      term.term,
      el('span', { class: 'id', text: term.lemma }),
      String(term.df),
      term.weight.toFixed(2),
      el('span', {}, actions(term)),
    ]),
  )
}
