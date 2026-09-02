import { api } from '../api.js'
import type { NoteExplanation, NoteView, RevisionDiff } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { clear, el, when } from '../dom.js'
import { markdownEditor } from '../editor.js'
import { describeFields, describeMatch, markedBy } from '../matches.js'
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
  // Which render is the current one.
  //
  // The toolbar is a single element the router clears and refills per screen,
  // so anything appended to it from a callback has to check it is still the
  // one that asked. The search explanation is fetched after the render returns,
  // and without this a navigation during that request dropped its strip into
  // the next screen's toolbar.
  let generation = 0

  return {
    id: 'note',
    title: 'Notes',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const mine = ++generation
      const current = (): boolean => mine === generation

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
      renderEditor(surface, note, notes, current)
    },
  }
}

function renderEditor(
  surface: Surface,
  note: NoteView,
  notes: { id: string; title: string }[],
  current: () => boolean,
): void {
  const preview = el('div', { class: 'preview' })
  const status = el('span', { class: 'hint' })

  // What the search that led here matched, once it has been asked for. Held
  // beside the repaint so an edit re-renders with the marks still on.
  let explanation: NoteExplanation | null = null

  const repaint = (body: string): void => {
    // The only place this page produces markup, and every character of the
    // note went through an escape on the way (see markdown.ts).
    preview.innerHTML = renderMarkdown(body, markedBy(explanation))
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

  // The preview lives inside a pane the history card can take over, so a diff
  // replaces the rendered note without disturbing the editor or its unsaved text.
  const pane = el('div', { class: 'pane' }, [preview])

  // Arrived from a search: ask what it matched, and mark the body with it.
  if (surface.query !== null) {
    void (async () => {
      try {
        const found = await api.explain(surface.project, note.id, surface.query!)

        // The screen may have changed while that was in flight, and the toolbar
        // belongs to whatever is showing now.
        if (!current()) return

        explanation = found
        repaint(view.state.doc.toString())
        surface.bar.prepend(whyBar(surface, note, explanation))
      } catch (error) {
        if (current()) surface.fail(error)
      }
    })()
  }

  surface.body.append(
    el('div', { class: 'split editor' }, [
      el('div', { class: 'panes' }, [el('div', { class: 'code' }, [view.dom]), pane]),
      sidebar(surface, note, pane, preview),
    ]),
  )
}

function sidebar(
  surface: Surface,
  note: NoteView,
  pane: HTMLElement,
  preview: HTMLElement,
): HTMLElement {
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

    historyCard(surface, note, pane, preview),
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

/**
 * The revision log, and what each revision changed.
 *
 * Reading is not restoring. The log said when a note changed and who changed
 * it, and the only route to an old body was `revert` — so looking meant
 * editing. Every revision carries the whole body, so this asks the daemon and
 * shows the answer where the preview was; the editor and its unsaved text are
 * untouched underneath.
 */
function historyCard(
  surface: Surface,
  note: NoteView,
  pane: HTMLElement,
  preview: HTMLElement,
): HTMLElement {
  const list = el('div', { class: 'revisions' })

  const showPreview = (): void => {
    pane.replaceChildren(preview)
  }

  showPreview()

  const showDiff = async (rev: number): Promise<void> => {
    pane.replaceChildren(el('p', { class: 'hint', text: 'reading the log…' }))

    try {
      const result = await api.diff(surface.project, note.id, { from: rev })
      pane.replaceChildren(diffView(result, showPreview))
    } catch (error) {
      showPreview()
      surface.fail(error)
    }
  }

  void (async () => {
    try {
      const { revisions } = await api.revisions(surface.project, note.id)

      list.replaceChildren(
        ...revisions.map((revision) =>
          el('button', {
            class: 'revision',
            title: `What changed between revision ${revision.rev} and the note as it stands`,
            text: `${revision.rev}  ${revision.op}  ${revision.author}  ${when(revision.createdAt)}`,
            onclick: () => void showDiff(revision.rev),
          }),
        ),
      )

      if (revisions.length === 0) list.replaceChildren(el('p', { class: 'hint', text: 'None.' }))
    } catch (error) {
      surface.fail(error)
    }
  })()

  return el('div', { class: 'card' }, [
    el('h2', { text: 'History' }),
    el('p', {
      class: 'hint',
      text: 'Pick a revision to see what changed between it and the note as it stands. Nothing is restored.',
    }),
    list,
  ])
}

/**
 * A diff, in the shape a reader already knows from git.
 *
 * Built as elements rather than markup because the lines are note text: they go
 * through `textContent`, which is the one rule `dom.ts` exists to keep.
 */
function diffView(result: RevisionDiff, onClose: () => void): HTMLElement {
  const side = (at: RevisionDiff['from']): string =>
    at.rev === null ? 'as it stands' : `revision ${at.rev}${at.author === null ? '' : ` (${at.author})`}`

  const header = el('div', { class: 'diff-head' }, [
    el('h2', { text: `${side(result.from)} → ${side(result.to)}` }),
    el('span', {
      class: 'hint',
      text: result.diff.identical
        ? 'the two are the same text'
        : `+${result.diff.added} −${result.diff.removed}`,
    }),
    el('button', { text: 'Close', onclick: onClose }),
  ])

  const hunks = result.diff.hunks.map((hunk) =>
    el('div', { class: 'hunk' }, [
      el('div', {
        class: 'hunk-head',
        text: `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`,
      }),
      ...hunk.lines.map((line) =>
        el('div', { class: `diff-line ${line.op}` }, [
          el('span', { class: 'gutter', text: line.before === null ? '' : String(line.before) }),
          el('span', { class: 'gutter', text: line.after === null ? '' : String(line.after) }),
          el('span', {
            class: 'sign',
            text: line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' ',
          }),
          el('span', { class: 'text', text: line.text }),
        ]),
      ),
    ]),
  )

  // `truncated` means nothing was compared, so there is nothing to draw and the
  // page says why rather than showing an empty diff under a header.
  if (result.diff.truncated) {
    return el('div', { class: 'diff' }, [
      header,
      el('p', {
        class: 'hint warn',
        text:
          `Too large to compare line by line — ${result.diff.removed} line(s) against ` +
          `${result.diff.added}.`,
      }),
    ])
  }

  return el('div', { class: 'diff' }, [
    header,
    ...(hunks.length === 0 ? [el('p', { class: 'hint', text: 'No lines differ.' })] : hunks),
  ])
}

/**
 * The strip above the note when it was opened from a search.
 *
 * Says what was asked, how many passages answered, and what the query hit in
 * the note's own names and terms — the `why.meta` half, which unlike the vector
 * half *is* word level and exact.
 */
function whyBar(surface: Surface, note: NoteView, explanation: NoteExplanation): HTMLElement {
  const fields = describeFields(explanation)

  return el('span', { class: 'why-bar' }, [
    el('span', { class: 'hint', text: 'matched' }),
    el('code', { text: explanation.query }),
    el('span', {
      class: 'hint',
      text: describeMatch(explanation),
    }),
    ...(fields === null ? [] : [el('span', { class: 'hint', text: `· ${fields}` })]),
    el('button', {
      text: 'Clear',
      title: 'Show the note without the search marks',
      onclick: () => surface.go('note', note.id),
    }),
  ])
}
