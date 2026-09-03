import { createRequire } from 'node:module'
import { getConfig, openDatabase, projectDbPath, listEntries } from '@mnemonima/store'
import { startServer } from './server.js'
import { clearDaemonState, idleTimeoutMs, writeDaemonState } from './state.js'

/**
 * The daemon entry point. Spawned detached by the CLI, or run in the foreground
 * with `mnemonima daemon start --foreground`.
 */

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

/**
 * Pool limits come from the first registered project's configuration.
 *
 * They are per-daemon rather than per-project settings that happen to live in a
 * project file; reading the first one is a pragmatic stand-in until there is a
 * global config, and it is documented as such.
 */
function poolSettings(): { capacity: number; idleMs: number; idleTimeoutMin: number } {
  const first = listEntries()[0]
  if (first === undefined) return { capacity: 2, idleMs: 15 * 60_000, idleTimeoutMin: 30 }

  try {
    const db = openDatabase(projectDbPath(first.dir), { mustExist: true })
    const config = getConfig(db)
    db.close()

    return {
      capacity: config.daemon.maxHotProjects,
      idleMs: config.daemon.projectIdleMin * 60_000,
      idleTimeoutMin: config.daemon.idleTimeoutMin,
    }
  } catch {
    return { capacity: 2, idleMs: 15 * 60_000, idleTimeoutMin: 30 }
  }
}

const settings = poolSettings()

const server = await startServer({
  version: pkg.version,
  capacity: settings.capacity,
  idleMs: settings.idleMs,
  snapshots: true,
  // Hoisted: declared below, and only ever called later from a request handler.
  onShutdown: (reason) => shutdown(reason),
})

writeDaemonState({
  pid: process.pid,
  port: server.port,
  token: server.token,
  version: pkg.version,
  startedAt: Date.now(),
})

process.stderr.write(`mnemonima daemon listening on ${server.url}\n`)

let lastActivity = Date.now()

// Zero means never; there is then no timer at all rather than one that can
// never fire.
const idleMs = idleTimeoutMs(settings.idleTimeoutMin)

// A daemon nobody is talking to should not sit in memory forever. Activity is
// measured by whether anything is still loaded rather than by request count,
// so a long editing pause does not kill a warm index that is about to be used.
const timer =
  idleMs === null
    ? null
    : setInterval(() => {
        if (server.pool.status().length > 0) {
          lastActivity = Date.now()
          return
        }
        if (Date.now() - lastActivity > idleMs) void shutdown('idle')
      }, 30_000)

timer?.unref()

process.stderr.write(
  idleMs === null
    ? 'idle shutdown is off; stop it with `mnemonima daemon stop`\n'
    : `stopping itself after ${settings.idleTimeoutMin} idle minute(s)\n`,
)

async function shutdown(reason: string): Promise<void> {
  if (timer !== null) clearInterval(timer)
  // A debounced export that never ran would silently lose the last edit from
  // the vault, so pending work is flushed before the process goes away.
  server.exporter.flushAll(server.pool.hotProjects())

  // A pending index is not flushed: it would load a model during shutdown and
  // make stopping the daemon take a minute. It is said out loud instead, so
  // notes are never quietly left out of the index.
  const unindexed = server.indexer.pending()
  if (unindexed.length > 0) {
    process.stderr.write(
      `not indexed before stopping: ${unindexed.join(', ')} — run \`mnemonima index\`\n`,
    )
  }
  clearDaemonState(process.pid)
  process.stderr.write(`mnemonima daemon stopping (${reason})\n`)
  await server.close()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}
