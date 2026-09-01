import { createRequire } from 'node:module'
import { getConfig, openDatabase, projectDbPath, listEntries } from '@mnemonima/store'
import { startServer } from './server.js'
import { clearDaemonState, writeDaemonState } from './state.js'

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
const idleTimeoutMs = Math.max(1, settings.idleTimeoutMin) * 60_000

// A daemon nobody is talking to should not sit in memory forever. Activity is
// measured by whether anything is still loaded rather than by request count,
// so a long editing pause does not kill a warm index that is about to be used.
const timer = setInterval(() => {
  if (server.pool.status().length > 0) {
    lastActivity = Date.now()
    return
  }
  if (Date.now() - lastActivity > idleTimeoutMs) void shutdown('idle')
}, 30_000)
timer.unref()

async function shutdown(reason: string): Promise<void> {
  clearInterval(timer)
  // A debounced export that never ran would silently lose the last edit from
  // the vault, so pending work is flushed before the process goes away.
  server.exporter.flushAll(server.pool.hotProjects())
  clearDaemonState()
  process.stderr.write(`mnemonima daemon stopping (${reason})\n`)
  await server.close()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}
