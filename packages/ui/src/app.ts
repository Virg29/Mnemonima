import { ApiError, api } from './api.js'
import { clear, el } from './dom.js'

/**
 * The shell: which project is selected, which screen is showing, and where an
 * error goes when a screen throws.
 *
 * Screens are functions, not components. Each is handed the surface it renders
 * into and the project it renders, and each renders once from data it just
 * fetched. Re-entering a screen re-fetches, which is the honest behaviour for a
 * page looking at a database another process is writing to.
 *
 * The project lives in the URL hash, so a screen can be linked to and a reload
 * lands back where it was — including the token, which is in the query string.
 */

export interface Screen {
  readonly id: string
  readonly title: string
  /** Screens that read a project are disabled until one is chosen. */
  readonly needsProject: boolean
  render(surface: Surface): void | Promise<void>
}

export interface Surface {
  /** The bar across the top of the screen: filters, actions, a query box. */
  readonly bar: HTMLElement
  /** Everything below it. */
  readonly body: HTMLElement
  /** The selected project, guaranteed present for a screen that needs one. */
  readonly project: string
  /** Re-render this screen from scratch. */
  reload(): void
  /** Switch screens, optionally carrying an argument (a note id, say). */
  go(screen: string, argument?: string): void
  /** The argument `go` was called with, if any. */
  readonly argument: string | null
  /** Show a failure without losing what is already on screen. */
  fail(error: unknown): void
}

export class App {
  readonly #root: HTMLElement
  readonly #screens = new Map<string, Screen>()
  readonly #nav = el('nav')
  readonly #bar = el('div', { class: 'bar' })
  readonly #body = el('div', { class: 'body' })
  readonly #projectPicker = el('select')
  readonly #sidebarExtra = el('div')

  #project = ''
  #current = ''
  #argument: string | null = null

  constructor(root: HTMLElement) {
    this.#root = root
  }

  add(screen: Screen): this {
    this.#screens.set(screen.id, screen)
    return this
  }

  get project(): string {
    return this.#project
  }

  /** Somewhere for a screen to hang a persistent summary, like daemon status. */
  get sidebarExtra(): HTMLElement {
    return this.#sidebarExtra
  }

  async start(version: string): Promise<void> {
    clear(this.#root)

    this.#projectPicker.addEventListener('change', () => {
      this.#project = this.#projectPicker.value
      localStorage.setItem('mnemonima.project', this.#project)
      this.#renderNav()
      this.go(this.#current)
    })

    this.#root.append(
      el('aside', {}, [
        el('h1', {}, ['mnemonima ', el('span', { text: version })]),
        el('div', {}, [el('h2', { text: 'Project' }), this.#projectPicker]),
        this.#nav,
        this.#sidebarExtra,
      ]),
      el('main', {}, [this.#bar, this.#body]),
    )

    await this.#loadProjects()

    window.addEventListener('hashchange', () => this.#fromHash())
    this.#fromHash()
  }

  async #loadProjects(): Promise<void> {
    const { projects } = await api.projects()
    const remembered = localStorage.getItem('mnemonima.project') ?? ''
    const names = projects.map((entry) => entry.name)

    this.#project = names.includes(remembered) ? remembered : (names[0] ?? '')

    clear(this.#projectPicker)
    if (names.length === 0) {
      this.#projectPicker.append(el('option', { value: '', text: 'no projects yet' }))
      this.#projectPicker.disabled = true
    } else {
      this.#projectPicker.disabled = false
      for (const name of names) {
        this.#projectPicker.append(
          el('option', { value: name, text: name, ...(name === this.#project ? { selected: true } : {}) }),
        )
      }
    }

    this.#renderNav()
  }

  /** Called by the projects screen when the registry changed under us. */
  async refreshProjects(): Promise<void> {
    await this.#loadProjects()
  }

  #renderNav(): void {
    clear(this.#nav)

    for (const screen of this.#screens.values()) {
      const disabled = screen.needsProject && this.#project === ''
      this.#nav.append(
        el('button', {
          text: screen.title,
          disabled,
          ...(screen.id === this.#current ? { 'aria-current': 'page' } : {}),
          onclick: () => this.go(screen.id),
        }),
      )
    }
  }

  #fromHash(): void {
    const [id = '', argument = ''] = location.hash.replace(/^#/, '').split('/')
    const first = [...this.#screens.keys()][0] ?? ''

    this.#argument = argument === '' ? null : decodeURIComponent(argument)
    void this.#render(this.#screens.has(id) ? id : first)
  }

  go(screen: string, argument?: string): void {
    const next = argument === undefined ? `#${screen}` : `#${screen}/${encodeURIComponent(argument)}`

    // Setting the hash fires `hashchange`, which renders. When it is already
    // the current hash no event fires, so the render has to happen here — that
    // is what makes a "reload" button work.
    if (location.hash === next) {
      this.#argument = argument ?? null
      void this.#render(screen)
      return
    }

    location.hash = next
  }

  async #render(id: string): Promise<void> {
    const screen = this.#screens.get(id)
    if (screen === undefined) return

    this.#current = id
    this.#renderNav()
    clear(this.#bar)
    clear(this.#body)

    if (screen.needsProject && this.#project === '') {
      this.#body.append(
        el('div', { class: 'empty' }, [
          el('p', { text: 'No project selected.' }),
          el('p', {
            class: 'hint',
            text: 'Add one on the Projects screen, or with `mnemonima project add`.',
          }),
        ]),
      )
      return
    }

    const surface = this.#surface(id)

    try {
      await screen.render(surface)
    } catch (error) {
      surface.fail(error)
    }
  }

  #surface(id: string): Surface {
    const app = this

    return {
      bar: this.#bar,
      body: this.#body,
      project: this.#project,
      argument: this.#argument,
      reload: () => app.go(id, app.#argument ?? undefined),
      go: (screen, argument) => app.go(screen, argument),
      fail: (error) => {
        app.#body.prepend(failure(error))
      },
    }
  }
}

/**
 * A failure with its hint attached.
 *
 * Dropping the hint would throw away the half of the error contract that says
 * what to do next (DESIGN.md 12.1) — usually a command the operator can run.
 */
export function failure(error: unknown): HTMLElement {
  const message = error instanceof Error ? error.message : String(error)
  const hint = error instanceof ApiError ? error.hint : null

  return el('div', { class: 'error' }, [
    el('p', {}, [el('strong', { text: 'error: ' }), message]),
    ...(hint === null ? [] : [el('p', { class: 'hint', text: `hint: ${hint}` })]),
  ])
}
