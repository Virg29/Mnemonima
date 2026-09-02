import { autocompletion } from '@codemirror/autocomplete'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'

/**
 * The markdown editor, in one place.
 *
 * Two screens open it now — the notes screen and the graph's panel — and there
 * is no version of this where they should differ. The `[[` completion in
 * particular is a rule about how a link is written (DESIGN.md 5.1: the id
 * leads, the title follows), and a second copy of it is a second chance to get
 * that wrong.
 */

export interface NoteChoice {
  readonly id: string
  readonly title: string
}

export interface EditorOptions {
  readonly doc: string
  /** What `[[` completes over. */
  readonly notes: readonly NoteChoice[]
  readonly onChange?: (doc: string) => void
  /** Called on Ctrl/Cmd-S, so the keyboard reaches Save from inside the editor. */
  readonly onSave?: () => void
}

export function markdownEditor(options: EditorOptions): EditorView {
  const keys = [...defaultKeymap, ...historyKeymap]

  if (options.onSave !== undefined) {
    keys.unshift({
      key: 'Mod-s',
      run: () => {
        options.onSave?.()
        // Claimed, so the browser's own save dialog stays shut.
        return true
      },
    })
  }

  return new EditorView({
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        lineNumbers(),
        history(),
        markdown(),
        placeholder('# Title\n\nThe body, in English.'),
        autocompletion({ override: [wikilinkCompletion(options.notes)] }),
        keymap.of(keys),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange?.(update.state.doc.toString())
        }),
      ],
    }),
  })
}

/** Completion over ids and titles, offered after `[[`. */
function wikilinkCompletion(notes: readonly NoteChoice[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^\]\n]*/)
    if (before === null) return null

    const typed = before.text.slice(2).toLowerCase()

    return {
      from: before.from + 2,
      options: notes
        .filter(
          (note) =>
            typed === '' ||
            note.id.toLowerCase().includes(typed) ||
            note.title.toLowerCase().includes(typed),
        )
        .map((note) => ({
          label: `${note.id} ${note.title}`,
          detail: note.id,
          // The id leads, so resolution never depends on the title, while
          // Obsidian still shows something readable (DESIGN.md 5.1).
          apply: `${note.id} ${note.title}]]`,
        })),
    }
  }
}
