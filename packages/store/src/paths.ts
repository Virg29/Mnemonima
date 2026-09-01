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

/**
 * Everything mnemonima generates for a project lives under one subdirectory of
 * the directory the operator named.
 *
 * `--dir` can be an existing vault, a repository, or a folder of anything at
 * all, and it stays theirs: we add exactly one entry to it and put the
 * database, the export and the eval set inside. Scattering `mnemonima.db`,
 * `mnemonima.db-wal` and `export/` across the operator's own directory made
 * "which of these is mine" a question with no obvious answer.
 */
export const PROJECT_DATA_DIR = '.mnemonima'

export function projectDataDir(projectDir: string): string {
  return path.join(projectDir, PROJECT_DATA_DIR)
}

/** The single source of truth for a project. */
export function projectDbPath(projectDir: string): string {
  return path.join(projectDataDir(projectDir), 'mnemonima.db')
}

/**
 * Where the database sat before the artefacts moved into `.mnemonima/`.
 *
 * Kept so that opening such a directory says what happened instead of silently
 * creating a second, empty database beside the real one.
 */
export function legacyProjectDbPath(projectDir: string): string {
  return path.join(projectDir, 'mnemonima.db')
}
