import os from 'node:os'
import path from 'node:path'

/**
 * Global state lives in `~/.mnemonima`. `MNEMONIMA_HOME` overrides it, which is
 * what the test suite uses to stay out of the real user directory.
 */
export function homeDir(): string {
  const override = process.env['MNEMONIMA_HOME']
  return override !== undefined && override !== '' ? override : path.join(os.homedir(), '.mnemonima')
}

export function registryPath(): string {
  return path.join(homeDir(), 'registry.json')
}

export function daemonStatePath(): string {
  return path.join(homeDir(), 'daemon.json')
}

export function modelsDir(): string {
  return path.join(homeDir(), 'models')
}

export function logsDir(): string {
  return path.join(homeDir(), 'logs')
}

/** The single source of truth for a project. */
export function projectDbPath(projectDir: string): string {
  return path.join(projectDir, 'mnemonima.db')
}
