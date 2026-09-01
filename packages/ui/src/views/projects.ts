import { api } from '../api.js'
import type { App, Screen, Surface } from '../app.js'
import { duration, el, empty, table } from '../dom.js'

/**
 * The registry and what the daemon is holding right now.
 *
 * The loaded/registered split is the point of the screen: a project is cheap to
 * register and expensive to keep hot, and the operator is the one who decides
 * which of the two a project should be.
 */
export function projectsScreen(app: App): Screen {
  return {
    id: 'projects',
    title: 'Projects',
    needsProject: false,

    async render(surface: Surface): Promise<void> {
      surface.bar.append(
        el('strong', { text: 'Projects' }),
        el('span', { class: 'grow' }),
        el('button', { text: 'Refresh', onclick: () => surface.reload() }),
      )

      const status = await api.status()

      surface.body.append(
        el('div', { class: 'card' }, [
          el('h2', { text: 'Daemon' }),
          el('dl', { class: 'fields' }, [
            el('dt', { text: 'version' }),
            el('dd', { text: status.version }),
            el('dt', { text: 'pid' }),
            el('dd', { text: String(status.pid) }),
            el('dt', { text: 'uptime' }),
            el('dd', { text: duration(status.uptimeMs) }),
            el('dt', { text: 'memory' }),
            el('dd', { text: `${status.memory.rssMb} MB resident, ${status.memory.heapMb} MB heap` }),
            el('dt', { text: 'capacity' }),
            el('dd', { text: `${status.loaded.length} of ${status.capacity} loaded` }),
          ]),
        ]),
      )

      surface.body.append(el('h2', { text: 'Loaded' }))
      surface.body.append(
        status.loaded.length === 0
          ? empty('Nothing is loaded.', 'A project is loaded by the first search that touches it.')
          : table(
              ['project', 'notes', 'chunks', 'index', 'idle', 'uses', ''],
              status.loaded.map((project) => [
                project.name,
                project.index === null ? '—' : String(project.index.notes),
                project.index === null ? '—' : String(project.index.chunks),
                project.index === null
                  ? 'not built'
                  : `${project.index.spaceId.slice(0, 8)}${project.index.fromSnapshot ? ' (restored)' : ''}`,
                duration(project.idleMs),
                String(project.uses),
                el('button', {
                  text: 'Unload',
                  onclick: async () => {
                    await api.unload(project.name)
                    surface.reload()
                  },
                }),
              ]),
            ),
      )

      const cold = status.registered.filter((entry) => !entry.loaded)
      if (cold.length > 0) {
        surface.body.append(
          el('h2', { text: 'Registered but cold' }),
          el('p', { class: 'hint', text: cold.map((entry) => entry.name).join(', ') }),
        )
      }

      surface.body.append(newProjectForm(app, surface))
    },
  }
}

function newProjectForm(app: App, surface: Surface): HTMLElement {
  const name = el('input', { placeholder: 'Shader Lab', class: 'grow' })
  const dir = el('input', { placeholder: 'W:/kb/shaders', class: 'grow' })
  const prefix = el('input', { placeholder: 'SL (optional)', size: 14 })
  const status = el('p', { class: 'hint' })

  const submit = async (): Promise<void> => {
    status.textContent = ''
    try {
      await api.createProject({
        name: name.value.trim(),
        dir: dir.value.trim(),
        ...(prefix.value.trim() === '' ? {} : { prefix: prefix.value.trim() }),
      })

      await app.refreshProjects()
      surface.reload()
    } catch (error) {
      surface.fail(error)
    }
  }

  return el('div', { class: 'card' }, [
    el('h2', { text: 'Add a project' }),
    el('p', {
      class: 'hint',
      text:
        'The directory is a path on the machine running the daemon. An existing ' +
        'mnemonima.db there is adopted rather than overwritten.',
    }),
    el('div', { class: 'bar', style: 'padding: 8px 0; border: 0' }, [
      name,
      dir,
      prefix,
      el('button', { class: 'primary', text: 'Create', onclick: () => void submit() }),
    ]),
    status,
  ])
}
