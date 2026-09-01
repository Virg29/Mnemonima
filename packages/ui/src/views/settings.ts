import { api } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { el } from '../dom.js'
import { CHOICES, EFFECTS, NOTES, SECTIONS, labelFor } from '../settings.js'
import type { Section } from '../settings.js'
import { valueAt } from '../knobs.js'

/**
 * Every setting `mnemonima config set` accepts, on one screen.
 *
 * The controls are built from the paths the daemon reports, not from a list
 * kept here, so a setting added to `ProjectConfig` appears without anyone
 * remembering to add it — and one that is removed cannot linger as a control
 * that writes a key nothing reads.
 *
 * Nothing is written until Save, and Save sends only what was touched. The
 * daemon validates every path before applying any of them, so a bad value
 * changes nothing rather than leaving the configuration half-updated.
 */
export function settingsScreen(): Screen {
  return {
    id: 'settings',
    title: 'Settings',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const { config, paths, exportTarget } = await api.config(surface.project)
      const pending = new Map<string, unknown>()

      const status = el('span', { class: 'hint' })
      const save = el('button', { class: 'primary', text: 'Save', disabled: true })
      const reset = el('button', { text: 'Discard', disabled: true, onclick: () => surface.reload() })

      const touched = (): void => {
        save.disabled = pending.size === 0
        reset.disabled = pending.size === 0
        status.textContent =
          pending.size === 0 ? '' : `${pending.size} change(s) not saved`
        status.className = pending.size === 0 ? 'hint' : 'hint warn'
      }

      save.addEventListener('click', () => {
        void (async () => {
          try {
            await api.setConfig(surface.project, Object.fromEntries(pending))
            surface.reload()
          } catch (error) {
            surface.fail(error)
          }
        })()
      })

      surface.bar.append(
        el('strong', { text: 'Settings' }),
        el('span', {
          class: 'hint',
          text: 'the same keys `mnemonima config set` takes',
        }),
        el('span', { class: 'grow' }),
        status,
        save,
        reset,
      )

      const claimed = new Set<string>()

      for (const section of SECTIONS) {
        const owned = paths.filter((path) => path.startsWith(`${section.prefix}.`))
        for (const path of owned) claimed.add(path)
        if (owned.length === 0) continue

        const card = sectionCard(section, owned, config, pending, touched)

        // The export setting is a relative path most of the time, so showing
        // where it actually lands is the only way to know what was chosen —
        // and automatic export does nothing at all when it is not there.
        if (section.prefix === 'export') card.append(exportTargetRow(surface, exportTarget))

        surface.body.append(card)
      }

      // Anything the sections above did not claim still gets a control: a new
      // setting must never be invisible just because nobody grouped it.
      const orphans = paths.filter((path) => !claimed.has(path))
      if (orphans.length > 0) {
        surface.body.append(
          sectionCard(
            {
              prefix: '',
              title: 'Other',
              hint: 'Settings with no section of their own yet.',
              effect: 'restart',
            },
            orphans,
            config,
            pending,
            touched,
          ),
        )
      }
    },
  }
}

function exportTargetRow(
  surface: Surface,
  target: { directory: string; exists: boolean },
): HTMLElement {
  return el('div', { class: 'setting' }, [
    el('label', { text: 'writes to' }),
    el('span', { class: 'id', text: target.directory, title: target.directory }),
    target.exists
      ? el('span', { class: 'hint ok', text: 'the directory exists' })
      : el('span', { class: 'hint' }, [
          el('span', {
            class: 'warn',
            text: 'missing, so automatic export does nothing — ',
          }),
          el('button', {
            text: 'Create it',
            onclick: async () => {
              try {
                await api.createExportDirectory(surface.project)
                surface.reload()
              } catch (error) {
                surface.fail(error)
              }
            },
          }),
        ]),
  ])
}

function sectionCard(
  section: Section,
  paths: readonly string[],
  config: Record<string, unknown>,
  pending: Map<string, unknown>,
  touched: () => void,
): HTMLElement {
  return el('div', { class: 'card' }, [
    el('h2', { text: section.title }),
    el('p', { class: 'hint', text: section.hint }),
    el('p', { class: 'hint', text: EFFECTS[section.effect] }),
    ...(section.warning === undefined
      ? []
      : [el('p', { class: 'hint warn', text: section.warning })]),
    ...paths.map((path) => field(path, config, pending, touched)),
  ])
}

function field(
  path: string,
  config: Record<string, unknown>,
  pending: Map<string, unknown>,
  touched: () => void,
): HTMLElement {
  const stored = read(config, path)
  const control = controlFor(path, stored, (value) => {
    // Back at the stored value is not a change: leaving it in would make Save
    // write settings the operator never moved.
    if (value === stored) pending.delete(path)
    else pending.set(path, value)
    touched()
  })

  const note = NOTES[path]

  return el('div', { class: 'setting' }, [
    el('label', { text: labelFor(path), title: path }),
    control,
    el('span', { class: 'hint', text: note ?? '' }),
  ])
}

function controlFor(
  path: string,
  stored: unknown,
  onChange: (value: unknown) => void,
): HTMLElement {
  if (typeof stored === 'boolean') {
    const box = el('input', { type: 'checkbox', ...(stored ? { checked: true } : {}) })
    box.addEventListener('change', () => onChange(box.checked))
    return box
  }

  const choices = CHOICES[path]
  if (choices !== undefined) {
    const menu = el(
      'select',
      {},
      choices.map((choice) =>
        el('option', {
          value: choice,
          text: choice,
          ...(choice === stored ? { selected: true } : {}),
        }),
      ),
    )
    menu.addEventListener('change', () => onChange(menu.value))
    return menu
  }

  if (typeof stored === 'number') {
    const box = el('input', { type: 'number', step: 'any', value: String(stored) })
    box.addEventListener('input', () => {
      const value = Number(box.value)
      // A half-typed number is not a change to record; the daemon would
      // refuse NaN anyway, but refusing it here keeps Save honest.
      if (box.value.trim() !== '' && Number.isFinite(value)) onChange(value)
    })
    return box
  }

  const box = el('input', { type: 'text', value: String(stored ?? '') })
  box.addEventListener('input', () => onChange(box.value))
  return box
}

/** Reads a dotted path, keeping the value's own type unlike `valueAt`. */
function read(config: Record<string, unknown>, path: string): unknown {
  const value = path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      config,
    )

  return typeof value === 'number' ? valueAt(config, path) : value
}
