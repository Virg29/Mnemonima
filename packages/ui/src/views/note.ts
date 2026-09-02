import { api } from '../api.js'
import type { NoteView } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { clear, el, when } from '../dom.js'
import { markdownEditor } from '../editor.js'
import { renderMarkdown } from '../markdown.js'

/**
 * The note editor — DESIGN.md 13.3.
 *
 * Writes go through the ordinary API with the revision the editor loaded, so
 * two windows editing one note produce a refusal rather than a silent
 * overwrite. That is the same `expectedRev` the CLI and MCP use; the editor has
 * no privileged path.
 *
 * The `[[` completion is over ids, titles and aliases, and it inserts the id
 * followed by the title — the filename form of DESIGN.md 5.1 — so a link stays
 * resolvable by id while reading as something a human wrote.
 *
 * Manual terms are a separate field from the automatic ones, and the automatic
 * ones are not editable here. They are derived from the body: making them
 * typeable would create a second source of truth for them, which is the thing
 * 7.2 exists to avoid.
 */
export function noteScreen(): Screen {
  return {
    id: 'note',
    title: 'Notes',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const { notes } = await api.notes(surface.project, 500)
      const id = surface.argument ?? notes[0]?.id ?? null

      const picker = el(
        'select',
        {},
        notes.map((note) =>
          el('option', {
            value: note.id,
            text: `${note.id} — ${note.title}`,
            ...(note.id === id ? { selected: true } : {}),
          }),
        ),
      )
      picker.addEventListener('change', () => surface.go('note', picker.value))

      surface.bar.append(picker)

      if (id === null) {
        surface.body.append(
          el('div', { class: 'empty' }, [
            el('p', { text: 'This project has no notes yet.' }),
            el('p', { class: 'hint', text: 'Create one with `mnemonima new --file note.md`.' }),
          ]),
        )
        return
      }

      const note = await api.note(surface.project, id)
      renderEditor(surface, note, notes)
    },
  }
}

function renderEditor(
  surface: Surface,
  note: NoteView,
  notes: { id: string; title: string }[],
): void {
  const preview = el('div', { class: 'preview' })
  const status = el('span', { class: 'hint' })

  const repaint = (body: string): void => {
    // The only place this page produces markup, and every character of the
    // note went through an escape on the way (see markdown.ts).
    preview.innerHTML = renderMarkdown(body)
  }

  const view = markdownEditor({
    doc: note.body,
    notes,
    onChange: (body) => {
      repaint(body)
      status.textContent = 'unsaved'
      status.className = 'hint warn'
    },
    onSave: () => save.click(),
  })

  repaint(note.body)

  const save = el('button', {
    class: 'primary',
    text: 'Save',
    onclick: async () => {
      try {
        const result = await api.updateNote(
          surface.project,
          note.id,
          view.state.doc.toString(),
          note.rev,
        )
        status.textContent = `saved as revision ${result.rev}`
        status.className = 'hint ok'
        surface.go('note', note.id)
      } catch (error) {
        surface.fail(error)
      }
    },
  })

  const reindex = el('button', {
    text: 'Regenerate',
    title: 'Re-chunk, re-embed and re-extract terms for whatever changed.',
    onclick: async () => {
      status.textContent = 'indexing…'
      status.className = 'hint'
      try {
        await api.index(surface.project)
        surface.reload()
      } catch (error) {
        surface.fail(error)
      }
    },
  })

  surface.bar.append(
    el('span', { class: 'id', text: `${note.id} · rev ${note.rev} · ${note.status}` }),
    el('span', { class: 'grow' }),
    status,
    save,
    reindex,
  )

  surface.body.append(
    el('div', { class: 'split editor' }, [
      el('div', { class: 'panes' }, [el('div', { class: 'code' }, [view.dom]), preview]),
      sidebar(surface, note),
    ]),
  )
}

function sidebar(surface: Surface, note: NoteView): HTMLElement {
  const manual = note.terms.filter((term) => term.source === 'manual')
  const automatic = note.terms.filter((term) => term.source !== 'manual')

  const newTerm = el('input', { placeholder: 'fragment shader', class: 'grow' })

  const addTerm = async (): Promise<void> => {
    const term = newTerm.value.trim()
    if (term === '') return

    try {
      await api.changeTerm(surface.project, term, 'add')
      surface.reload()
    } catch (error) {
      surface.fail(error)
    }
  }

  return el('div', {}, [
    el('div', { class: 'card' }, [
      el('h2', { text: 'Note' }),
      el('dl', { class: 'fields' }, [
        el('dt', { text: 'title' }),
        el('dd', { text: note.title }),
        el('dt', { text: 'updated' }),
        el('dd', { text: when(note.updatedAt) }),
        el('dt', { text: 'status' }),
        el('dd', { text: note.status }),
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: `Links out (${note.links.length})` }),
      ...(note.links.length === 0
        ? [el('p', { class: 'hint', text: 'None.' })]
        : note.links.map((link) =>
            el('div', {}, [
              link.resolved
                ? noteLink(surface, link.dst, link.dst)
                : el('span', { class: 'id bad', text: `${link.dst} (dangling)` }),
              ...(link.anchor === null ? [] : [el('span', { class: 'hint', text: ` — ${link.anchor}` })]),
            ]),
          )),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: `Backlinks (${note.backlinks.length})` }),
      ...(note.backlinks.length === 0
        ? [
            el('p', {
              class: 'hint',
              text: 'Nothing points here. Backlinks are derived, never edited.',
            }),
          ]
        : note.backlinks.map((src) => el('div', {}, [noteLink(surface, src, src)]))),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Terms, by hand' }),
      el('p', {
        class: 'hint',
        text: 'Matched literally in every note, and weighted above anything an extractor proposes.',
      }),
      el('p', {}, manual.map((term) => el('span', { class: 'tag manual', text: term.term }))),
      el('div', { class: 'bar', style: 'padding:0;border:0' }, [
        newTerm,
        el('button', { text: 'Add', onclick: () => void addTerm() }),
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: `Terms, extracted (${automatic.length})` }),
      el('p', {
        class: 'hint',
        text: 'Derived from the body, so they are not editable here — Regenerate rebuilds them.',
      }),
      el(
        'p',
        {},
        automatic.map((term) =>
          el('span', { class: 'tag', title: term.score.toFixed(3), text: term.term }),
        ),
      ),
    ]),
  ])
}

function noteLink(surface: Surface, id: string, label: string): HTMLElement {
  return el('a', {
    href: `#note/${encodeURIComponent(id)}`,
    text: label,
    onclick: (event: Event) => {
      event.preventDefault()
      surface.go('note', id)
    },
  })
}
