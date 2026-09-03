import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DaemonUnavailableError } from '@mnemonima/core'
import { daemonStatePath, homeDir } from '@mnemonima/store'

/**
 * Where the daemon writes down how to reach it, and how a client decides
 * whether one is worth talking to.
 *
 * The state file is a hint, never a promise: a crashed daemon leaves it behind
 * and a stale port may belong to something else entirely. Every client therefore
 * probes `/health` and checks the version before trusting it, and treats any
 * disagreement as "no daemon".
 */

export interface DaemonState {
  readonly pid: number
  readonly port: number
  readonly token: string
  readonly version: string
  readonly startedAt: number
}

/** How long to wait on a second probe when the process is known to be alive. */
const BUSY_PROBE_MS = 10_000

export function readDaemonState(): DaemonState | null {
  const file = daemonStatePath()
  if (!fs.existsSync(file)) return null

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DaemonState>
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return null

    return {
      pid: parsed.pid ?? 0,
      port: parsed.port,
      token: parsed.token,
      version: parsed.version ?? '',
      startedAt: parsed.startedAt ?? 0,
    }
  } catch {
    return null
  }
}

export function writeDaemonState(state: DaemonState): void {
  fs.mkdirSync(homeDir(), { recursive: true })

  const file = daemonStatePath()
  const temp = `${file}.tmp`

  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temp, file)
}

/**
 * Forgets the daemon we know about.
 *
 * @param expectedPid when given, the file is left alone unless it still names
 *   this process. The state file is the *only* way to reach a running daemon —
 *   deleting one that belongs to somebody else strands it, alive and holding
 *   its databases open, where no command can find it again.
 */
export function clearDaemonState(expectedPid?: number): void {
  const file = daemonStatePath()
  if (!fs.existsSync(file)) return

  if (expectedPid !== undefined) {
    const state = readDaemonState()
    if (state !== null && state.pid !== expectedPid) return
  }

  fs.rmSync(file)
}

/** Whether a process id belongs to something still running. */
export function isAlive(pid: number): boolean {
  if (pid <= 0) return false

  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface HealthReport {
  readonly ok: boolean
  readonly version: string
  readonly pid: number
  readonly uptimeMs: number
  readonly loaded: number
}

export async function probe(port: number, timeoutMs = 1500): Promise<HealthReport | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return (await response.json()) as HealthReport
  } catch {
    return null
  }
}

/**
 * Returns a live daemon of the right version, or null.
 *
 * A version mismatch counts as "not running": an older daemon holding an index
 * built by different code is worse than no daemon at all.
 */
export async function findRunning(version: string): Promise<DaemonState | null> {
  const state = readDaemonState()
  if (state === null) return null

  const health = await probe(state.port)
  if (health !== null) return health.version === version ? state : null

  // A silent daemon is not a dead one.
  //
  // `/health` is a trivial handler, but node is single-threaded and this
  // process is not: a synchronous SQLite call, an index run or a cold hybrid
  // search blocks the event loop for longer than the probe waits. Treating that
  // timeout as proof of death — and deleting the state file on the strength of
  // it — stranded a live daemon where nothing could reach it again, holding its
  // databases open, while the next command started a second one. Three of them
  // accumulated that way in a single afternoon.
  //
  // So the process itself is asked. While it is alive the state stays, whatever
  // the probe said: `daemon stop` can then still find it, which is the whole
  // point of writing the file down.
  if (isAlive(state.pid)) {
    const second = await probe(state.port, BUSY_PROBE_MS)
    if (second !== null) return second.version === version ? state : null

    return null
  }

  clearDaemonState(state.pid)
  return null
}

export interface SpawnOptions {
  readonly version: string
  /** Path to the daemon entry script. */
  readonly entry: string
  readonly timeoutMs?: number
}

/**
 * Starts a daemon in the background and waits for it to answer.
 *
 * Detached and with its handles released, so the CLI process that started it
 * can exit without taking it down.
 */
export async function spawnDaemon(options: SpawnOptions): Promise<DaemonState> {
  const existing = await findRunning(options.version)
  if (existing !== null) return existing

  if (!fs.existsSync(options.entry)) {
    throw new DaemonUnavailableError(`daemon entry point is missing: ${options.entry}`, {
      details: { entry: options.entry },
      hint: 'run `pnpm build`, or reinstall the package',
    })
  }

  const logs = path.join(homeDir(), 'logs')
  fs.mkdirSync(logs, { recursive: true })

  const out = fs.openSync(path.join(logs, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [options.entry], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 15_000)

  while (Date.now() < deadline) {
    const state = readDaemonState()
    if (state !== null && state.pid !== 0) {
      const health = await probe(state.port, 500)
      if (health !== null && health.version === options.version) return state
    }
    await sleep(120)
  }

  throw new DaemonUnavailableError('the daemon did not come up in time', {
    details: { entry: options.entry },
    hint: `check ${path.join(logs, 'daemon.log')}, or run \`mnemonima daemon start\` in the foreground`,
  })
}

/**
 * Stops the daemon and waits until it is actually gone.
 *
 * Returning the moment the signal is sent was a lie with consequences: the
 * caller reported "Stopped", `restart` started a replacement immediately, and
 * on Windows the old process still held the database file the new one wanted.
 * A stop that has not finished stopping is not a stop.
 *
 * It asks over HTTP first and kills only what will not answer. On Windows there
 * is no signal to catch — node's `process.kill` terminates the process outright
 * — so killing means the daemon's own shutdown never runs and a debounced export
 * dies with it. Asking gives an orderly stop on every platform.
 */
export async function stopDaemon(state: DaemonState, timeoutMs = 8000): Promise<boolean> {
  if (!isAlive(state.pid)) {
    clearDaemonState(state.pid)
    return false
  }

  // Asked before it is killed. On Windows a signal cannot be caught — node
  // terminates the process — so the daemon's own shutdown never runs there and
  // a debounced export is lost with it. Over HTTP it flushes and closes in
  // order on every platform. Killing stays as the answer for a daemon that will
  // not answer.
  await askToStop(state)

  if (!isAlive(state.pid)) {
    clearDaemonState(state.pid)
    return true
  }

  try {
    process.kill(state.pid)
  } catch {
    clearDaemonState(state.pid)
    return false
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(state.pid)) {
      clearDaemonState(state.pid)
      return true
    }
    await sleep(100)
  }

  // Still there after being asked. Say so rather than clearing the state and
  // losing the only handle on it.
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * How long the daemon may sit with nothing loaded before it stops itself.
 *
 * Zero or less means never. Clamping that to a minute — which an earlier
 * version did — is the opposite of what the operator set, and the UI offers it
 * as "stays up until it is stopped", so the two have to agree.
 */
export function idleTimeoutMs(minutes: number): number | null {
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null
}

/**
 * Asks the daemon to stop itself, and waits a moment for it to do so.
 *
 * Best effort by design: a daemon too busy to answer, or one from a version
 * that has no such route, simply does not stop here and is killed instead.
 */
async function askToStop(state: DaemonState, graceMs = 3000): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${state.port}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    return
  }

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && isAlive(state.pid)) await sleep(100)
}
