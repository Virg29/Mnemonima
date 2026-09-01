import { api } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { el, table, when } from '../dom.js'

/**
 * Embedding spaces — DESIGN.md 13.6.
 *
 * A space is addressed by a hash of everything that decides what a vector
 * means: the model, its prefixes, the normalisation, the chunker version and
 * the chunking settings (6.4). So there is no "convert" and no migration —
 * changing any of them builds a new space beside the old one, and switching
 * back is a flag rather than a rebuild, because the old vectors were never
 * deleted.
 *
 * That is why activating is offered without a warning while building with a
 * different model is gated: one is free and reversible, the other spends
 * minutes of CPU and is what `mcp.allowDestructive` exists to hold back.
 *
 * There is no progress bar. The daemon has no event stream yet, so a build
 * reports when it finishes; saying so is better than a bar that is a guess.
 */
export function spacesScreen(): Screen {
  return {
    id: 'spaces',
    title: 'Spaces',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const [{ spaces, active }, models, { config }] = await Promise.all([
        api.spaces(surface.project),
        api.models(),
        api.config(surface.project),
      ])

      const current = String((config['model'] as Record<string, unknown>)['active'] ?? '')
      const status = el('span', { class: 'hint' })

      const picker = el(
        'select',
        {},
        models.models.map((model) =>
          el('option', {
            value: model.id,
            text: `${model.id} · ${model.dim}d · ${model.sizeMb} MB${model.offline ? ' · offline' : ''}`,
            ...(model.id === current ? { selected: true } : {}),
          }),
        ),
      )

      const build = el('button', {
        class: 'primary',
        text: 'Build',
        onclick: async () => {
          status.textContent = 'building — this embeds every note that is not already in the space…'
          status.className = 'hint warn'
          build.disabled = true

          try {
            // Setting the model first means the space is built *and* activated
            // by the run, which is what the indexer does with the active
            // configuration. Passing it as an override would build without
            // switching, and leave the project answering from the old space.
            if (picker.value !== current) {
              await api.setConfig(surface.project, { 'model.active': picker.value })
            }
            await api.index(surface.project)
            surface.reload()
          } catch (error) {
            build.disabled = false
            surface.fail(error)
          }
        },
      })

      surface.bar.append(
        el('span', { class: 'hint', text: 'Model' }),
        picker,
        build,
        el('span', { class: 'grow' }),
        status,
      )

      surface.body.append(
        el('p', {
          class: 'hint',
          text:
            'A space is a hash of the model, its prefixes, the normalisation, the chunker version ' +
            'and the chunking settings. Change any of them and the next index run builds a new one ' +
            'beside this one; nothing is converted and nothing is lost.',
        }),
        table(
          ['space', 'model', 'dim', 'chunker', 'notes', 'chunks', 'vectors', 'built', ''],
          spaces.map((space) => [
            el('span', {
              class: space.id === active ? 'id ok' : 'id',
              text: `${space.id.slice(0, 12)}${space.id === active ? ' ·' : ''}`,
              title: space.id,
            }),
            space.model,
            String(space.dim),
            el('span', { class: 'id', text: space.chunkerVersion }),
            String(space.notes),
            String(space.chunks),
            String(space.embeddings),
            when(space.createdAt),
            space.isActive
              ? el('span', { class: 'hint ok', text: 'answering' })
              : el('button', {
                  text: 'Activate',
                  title: 'Instant: the vectors are still here, so nothing is rebuilt.',
                  onclick: async () => {
                    try {
                      await api.activateSpace(surface.project, space.id)
                      surface.reload()
                    } catch (error) {
                      surface.fail(error)
                    }
                  },
                }),
          ]),
        ),
      )

      if (spaces.length === 0) {
        surface.body.append(
          el('p', { class: 'hint', text: 'No space yet. Pick a model and build one.' }),
        )
      }
    },
  }
}
