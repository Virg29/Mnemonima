import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Git, driven through the binary rather than a library.
 *
 * The whole interaction is four commands, and shelling out to the git the
 * operator already has avoids a dependency that would have to keep up with it.
 * Everything here is best effort: a project without git still exports, and a
 * commit that fails never loses the files it was about to record.
 *
 * **Pushing is never automatic.** Exporting is a local act; sending a knowledge
 * base somewhere is a decision, and it stays an explicit one.
 */

export interface GitResult {
  readonly ok: boolean
  readonly output: string
}

function run(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })

  if (result.error !== undefined) return { ok: false, output: result.error.message }

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

export function isAvailable(): boolean {
  return run(process.cwd(), ['--version']).ok
}

export function isRepository(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  return run(dir, ['rev-parse', '--is-inside-work-tree']).ok
}

export interface InitResult extends GitResult {
  readonly created: boolean
}

/**
 * Initialises a repository for the exported vault, with an ignore file that
 * keeps the database out of it: `mnemonima.db` is the source of truth and is
 * rebuilt from nothing but itself, so versioning it beside its own export would
 * store the same content twice and produce enormous binary diffs.
 */
export function initRepository(dir: string): InitResult {
  fs.mkdirSync(dir, { recursive: true })

  if (isRepository(dir)) return { ok: true, created: false, output: 'already a repository' }

  const init = run(dir, ['init', '--quiet'])
  if (!init.ok) return { ...init, created: false }

  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(
      ignore,
      [
        '# The database is the source of truth; this directory is its export.',
        'mnemonima.db',
        'mnemonima.db-wal',
        'mnemonima.db-shm',
        '',
      ].join('\n'),
      'utf8',
    )
  }

  return { ok: true, created: true, output: init.output }
}

export interface CommitResult extends GitResult {
  /** False when the tree was already clean, which is not a failure. */
  readonly committed: boolean
}

export function commitAll(dir: string, message: string): CommitResult {
  if (!isRepository(dir)) {
    return { ok: false, committed: false, output: `${dir} is not a git repository` }
  }

  // Every one of these is scoped to `.` — the export directory — because it is
  // routinely a subdirectory of a repository the operator is also working in.
  // `add` was already scoped; `status` and `commit` were not, so a commit made
  // for an export swept in whatever else happened to be staged and reported it
  // under a message that named only notes. Measured: a machine commit reading
  // "mnemonima: create NS-0001" carried away an unrelated `src.txt`.
  const staged = run(dir, ['add', '--all', '.'])
  if (!staged.ok) return { ...staged, committed: false }

  const status = run(dir, ['status', '--porcelain', '--', '.'])
  if (status.output === '') return { ok: true, committed: false, output: 'nothing to commit' }

  const commit = run(dir, ['commit', '--quiet', '--message', message, '--', '.'])
  return { ...commit, committed: commit.ok }
}

export function push(dir: string): GitResult {
  if (!isRepository(dir)) return { ok: false, output: `${dir} is not a git repository` }
  return run(dir, ['push'])
}

/**
 * A commit message that says what changed, in the same English as everything
 * else. Long lists are summarised rather than dumped.
 */
export function commitMessage(changes: {
  created: readonly string[]
  updated: readonly string[]
  removed: readonly string[]
}): string {
  const parts: string[] = []
  const describe = (verb: string, ids: readonly string[]): void => {
    if (ids.length === 0) return
    parts.push(
      ids.length <= 4 ? `${verb} ${ids.join(', ')}` : `${verb} ${ids.length} notes`,
    )
  }

  describe('create', changes.created)
  describe('update', changes.updated)
  describe('remove', changes.removed)

  return `mnemonima: ${parts.length === 0 ? 'export' : parts.join('; ')}`
}
