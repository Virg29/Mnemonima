import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * Serving the web UI — DESIGN.md 13.
 *
 * The UI is a Vite bundle in `@mnemonima/ui`, and the daemon hands it out as
 * static files. There is no dev server in production and no CDN: the page is
 * whatever was built into that package, served by whichever daemon is running.
 *
 * Files are read and served here rather than through a static-file middleware
 * because the root has to be resolved from the package, not from the process
 * working directory — the daemon is spawned detached and its cwd is whatever
 * the CLI happened to have.
 */

const require = createRequire(import.meta.url)

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
  ['.json', 'application/json; charset=utf-8'],
])

/** The built bundle's directory, or null when the UI has not been built. */
export function uiRoot(): string | null {
  try {
    const manifest = require.resolve('@mnemonima/ui/package.json')
    const dist = path.join(path.dirname(manifest), 'dist')
    return fs.existsSync(path.join(dist, 'index.html')) ? dist : null
  } catch {
    return null
  }
}

export interface UiFile {
  /** An ArrayBuffer rather than a Buffer: it is what the response body takes. */
  readonly body: ArrayBuffer
  readonly type: string
}

/**
 * One file from the bundle, or null.
 *
 * `asset` arrives from the URL, so it is resolved and then checked to be inside
 * the bundle: a path that climbs out with `..` must not be able to read the
 * operator's disk through a loopback server.
 */
export function uiFile(asset: string): UiFile | null {
  const root = uiRoot()
  if (root === null) return null

  const target = path.resolve(root, `.${asset.startsWith('/') ? asset : `/${asset}`}`)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null

  const data = fs.readFileSync(target)

  return {
    body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    type: TYPES.get(path.extname(target)) ?? 'application/octet-stream',
  }
}

/**
 * What to show when the package is present but never built.
 *
 * A blank page would read as a broken daemon. This says which command fixes it,
 * which is the same contract every error in this project follows.
 */
export function uiMissingPage(): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>mnemonima</title>',
    '<style>body{font:14px/1.6 system-ui,sans-serif;margin:48px auto;max-width:40em;padding:0 16px}',
    'code{font-family:ui-monospace,Consolas,monospace;background:#8881;padding:1px 5px;border-radius:4px}',
    '</style></head><body>',
    '<h1>The web UI is not built</h1>',
    '<p>The daemon is running and its API is working; only the page is missing.</p>',
    '<p>Build it with <code>pnpm --filter @mnemonima/ui build</code>, then reload.</p>',
    '</body></html>',
  ].join('\n')
}
