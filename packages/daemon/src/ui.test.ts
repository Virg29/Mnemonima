import { describe, expect, it } from 'vitest'
import { createServer } from './server.js'
import { uiFile, uiRoot } from './ui.js'

/**
 * Serving the built UI.
 *
 * Two things here are worth a test rather than a reading. The path check, because
 * a loopback server that will read any file the daemon can reach is a file
 * server for the whole disk. And the auth exemption, because it is a hole cut
 * on purpose and the point is that it is exactly the size of the bundle.
 */

describe('the UI bundle', () => {
  const built = uiRoot() !== null

  it.runIf(built)('serves the page it was built with', () => {
    const page = uiFile('/index.html')

    expect(page).not.toBeNull()
    expect(new TextDecoder().decode(page?.body)).toContain('<div id="app">')
    expect(page?.type).toContain('text/html')
  })

  it('refuses a path that climbs out of the bundle', () => {
    expect(uiFile('/../package.json')).toBeNull()
    expect(uiFile('/../../../../etc/passwd')).toBeNull()
    expect(uiFile('/assets/../../package.json')).toBeNull()
  })

  it('returns null for a file that is not there', () => {
    expect(uiFile('/nothing-like-this.js')).toBeNull()
  })
})

describe('serving the UI over HTTP', () => {
  const server = createServer({ version: 'test', snapshots: false })

  const get = async (route: string, token?: string): Promise<Response> =>
    server.app.fetch(
      new Request(`http://127.0.0.1${route}`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
    )

  it('answers /ui, built or not', async () => {
    const response = await get('/ui', server.token)

    // 200 with the bundle, or 503 with the command that builds it — never a
    // blank page that reads as a broken daemon.
    expect([200, 503]).toContain(response.status)
    expect(await response.text()).toContain('mnemonima')
  })

  it('lets the bundle through without a token, and nothing else', async () => {
    // A `<script src>` cannot carry a header, so the assets are exempt.
    const asset = await get('/ui/assets/nothing.js')
    expect(asset.status).toBe(404)

    // Everything that reads a project still needs one.
    const status = await get('/status')
    expect(status.status).toBe(401)
  })
})
