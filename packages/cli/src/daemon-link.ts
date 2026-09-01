import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DaemonClient, findRunning, spawnDaemon } from '@mnemonima/daemon'
import type { DaemonState } from '@mnemonima/daemon'
import { printNote } from './output.js'

/**
 * How a command decides whether to go through the daemon.
 *
 * The rule is: use one if it is already there, start one if the project says
 * to, and fall back to running in process if anything about that fails. A
 * search must never fail because a background service would not start — the
 * daemon is a latency optimisation, not a dependency.
 */

const require = createRequire(import.meta.url)

export function cliVersion(): string {
  return (require('../package.json') as { version: string }).version
}

/** Absolute path of the daemon entry script, whatever the install layout. */
export function daemonEntry(): string {
  return require.resolve('@mnemonima/daemon/main')
}

/**
 * The same path as a URL, for `import()`.
 *
 * On Windows a resolved path looks like `W:\...`, and the ESM loader refuses
 * it: only file:, data: and node: URLs are accepted, and `W:` reads as an
 * unknown protocol. Every dynamic import of a resolved path has to go through
 * this.
 */
export function importable(entry: string): string {
  return pathToFileURL(entry).href
}

export interface ConnectOptions {
  /** Start one if none is running. */
  readonly autoStart: boolean
  /** Explain on stderr what is happening. */
  readonly quiet?: boolean
}

export async function connectDaemon(options: ConnectOptions): Promise<DaemonClient | null> {
  const version = cliVersion()

  const running = await findRunning(version)
  if (running !== null) return new DaemonClient(running)

  if (!options.autoStart) return null

  try {
    const started = await spawnDaemon({ version, entry: daemonEntry() })
    if (options.quiet !== true) printNote(`started the daemon on port ${started.port}`)
    return new DaemonClient(started)
  } catch (error) {
    // Explicitly not fatal: the caller runs in process instead.
    if (options.quiet !== true) {
      printNote(
        `could not start the daemon (${error instanceof Error ? error.message : String(error)}); ` +
          'running in this process instead',
      )
    }
    return null
  }
}

export async function currentDaemon(): Promise<DaemonState | null> {
  return findRunning(cliVersion())
}
