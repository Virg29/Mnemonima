import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface Sandbox {
  readonly root: string
  readonly home: string
  readonly projects: string
  cleanup(): void
}

/**
 * Isolated MNEMONIMA_HOME plus a scratch directory for project databases, so a
 * test run never touches the real user directory.
 */
export function createSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemonima-test-'))
  const home = path.join(root, 'home')
  const projects = path.join(root, 'projects')

  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projects, { recursive: true })

  const previous = process.env['MNEMONIMA_HOME']
  process.env['MNEMONIMA_HOME'] = home

  return {
    root,
    home,
    projects,
    cleanup() {
      if (previous === undefined) delete process.env['MNEMONIMA_HOME']
      else process.env['MNEMONIMA_HOME'] = previous

      // Windows keeps handles briefly after close; retry rather than fail.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}
