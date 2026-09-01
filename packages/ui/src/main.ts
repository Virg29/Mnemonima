import './styles.css'
import { api } from './api.js'
import { App, failure } from './app.js'
import { graphScreen } from './views/graph.js'
import { healthScreen } from './views/health.js'
import { labScreen } from './views/lab.js'
import { noteScreen } from './views/note.js'
import { projectsScreen } from './views/projects.js'
import { settingsScreen } from './views/settings.js'
import { spacesScreen } from './views/spaces.js'
import { termsScreen } from './views/terms.js'

/**
 * Bootstrap.
 *
 * The version comes from the daemon rather than from a build constant: the page
 * is served by whichever daemon is running, and showing the version the assets
 * were built against would be a lie the moment the two diverge.
 */

const root = document.querySelector<HTMLElement>('#app')

if (root !== null) {
  void (async () => {
    const app = new App(root)

    app
      .add(projectsScreen(app))
      .add(labScreen())
      .add(graphScreen())
      .add(noteScreen())
      .add(termsScreen())
      .add(spacesScreen())
      .add(settingsScreen())
      .add(healthScreen())

    try {
      const health = await api.status()
      await app.start(health.version)
    } catch (error) {
      root.append(failure(error))
    }
  })()
}
