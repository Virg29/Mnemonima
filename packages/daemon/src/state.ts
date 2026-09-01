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

export function clearDaemonState(): void {
  const file = daemonStatePath()
  if (fs.existsSync(file)) fs.rmSync(file)
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
  if (health === null) {
    clearDaemonState()
    return null
  }

  return health.version === version ? state : null
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

export function stopDaemon(state: DaemonState): boolean {
  try {
    process.kill(state.pid)
    clearDaemonState()
    return true
  } catch {
    clearDaemonState()
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
