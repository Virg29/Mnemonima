import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { createProject, createSandbox, getConfig, setConfig } from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { exportProject } from './bridge.js'
import { isAvailable } from './git.js'
import { writeNewNote } from './notes.js'

/**
 * Committing an export.
 *
 * The export directory is routinely a subdirectory of a repository the operator
 * is also working in — `export.path: docs/notes` inside their own project is
 * the ordinary arrangement — so every question here is about what a commit made
 * for us does to work that is not ours.
 *
 * Skipped where git is not on the PATH, since these drive the real binary
 * rather than a fake: what is being tested is what git does with the arguments
 * we give it.
 */
const withGit = isAvailable() ? describe : describe.skip

withGit('committing an export', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let projectDir: string
  let exportDir: string

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' }).trim()

  beforeEach(() => {
    sandbox = createSandbox()
    projectDir = path.join(sandbox.projects, 'repo')
    exportDir = path.join(projectDir, 'docs', 'notes')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    config.export.path = 'docs/notes'
    setConfig(db, config)

    fs.mkdirSync(exportDir, { recursive: true })

    git('init', '--quiet', '.')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('commit', '--quiet', '--allow-empty', '--message', 'base')
  })

  afterEach(() => {
    db.close()
    sandbox.cleanup()
  })

  const addNote = (title: string): string =>
    writeNewNote(db, config, `# ${title}\n\nBody.\n`, { author: 'test' }).note.id

  const commits = (): number => git('rev-list', '--count', 'HEAD').length > 0
    ? Number(git('rev-list', '--count', 'HEAD'))
    : 0

  it('does not commit when export.commit is off', () => {
    // The setting existed and the export ignored it, because the CLI's
    // `--no-commit` flag is `true` by default in commander and was passed
    // through as an explicit override on every run.
    config.export.commit = false
    setConfig(db, config)
    addNote('Shaders')

    const report = exportProject(db, config, projectDir)

    expect(report.committed).toBe(false)
    expect(commits()).toBe(1)
  })

  it('commits when export.commit is on', () => {
    config.export.commit = true
    setConfig(db, config)
    addNote('Shaders')

    const report = exportProject(db, config, projectDir)

    expect(report.committed).toBe(true)
    expect(commits()).toBe(2)
    expect(git('log', '-1', '--format=%s')).toContain('mnemonima:')
  })

  it('lets an explicit option override the setting, in both directions', () => {
    config.export.commit = false
    setConfig(db, config)
    addNote('Shaders')

    expect(exportProject(db, config, projectDir, { commit: true }).committed).toBe(true)

    config.export.commit = true
    setConfig(db, config)
    addNote('Uniforms')

    expect(exportProject(db, config, projectDir, { commit: false }).committed).toBe(false)
  })

  it('leaves work staged elsewhere in the repository alone', () => {
    // The one that matters. `add` was scoped to the export directory but the
    // commit was not, so a machine commit swept in whatever the operator had
    // staged and reported it under a message naming only notes.
    config.export.commit = true
    setConfig(db, config)

    fs.writeFileSync(path.join(projectDir, 'src.txt'), 'operator work\n')
    git('add', 'src.txt')

    addNote('Shaders')
    exportProject(db, config, projectDir)

    const files = git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean)

    expect(files.some((file) => file.includes('docs/notes'))).toBe(true)
    expect(files).not.toContain('src.txt')
    // And it is still staged, waiting for the operator to commit it themselves.
    expect(git('diff', '--cached', '--name-only')).toContain('src.txt')
  })

  it('reports nothing to commit when the export changed nothing', () => {
    config.export.commit = true
    setConfig(db, config)
    addNote('Shaders')

    exportProject(db, config, projectDir)
    const again = exportProject(db, config, projectDir)

    expect(again.committed).toBe(false)
    expect(commits()).toBe(2)
  })
})
