import { BadRequestError } from '@mnemonima/core'
import { formatNoteId } from '@mnemonima/core'
import { exportDirectory, initRepository, isAvailable } from '@mnemonima/engine'
import {
  META,
  createProject,
  databaseExists,
  getMetaNumber,
  listEntries,
  openDatabase,
  projectConfig,
  projectDbPath,
  projectStats,
  registryLocation,
  removeProject,
} from '@mnemonima/store'
import { DaemonClient } from '@mnemonima/daemon'
import { Command } from 'commander'
import { currentDaemon } from '../daemon-link.js'
import { printFields, printJson, printLine, printNote, printTable } from '../output.js'

interface AddOptions {
  dir: string
  prefix?: string
  force?: boolean
  git?: boolean
  json?: boolean
}

interface ListOptions {
  json?: boolean
}

interface RemoveOptions {
  deleteData?: boolean
  yes?: boolean
  json?: boolean
}

function describeProject(entry: {
  name: string
  dir: string
  prefix: string
  createdAt: number
}): Record<string, unknown> {
  const dbPath = projectDbPath(entry.dir)
  const exists = databaseExists(dbPath)

  const base = {
    name: entry.name,
    dir: entry.dir,
    prefix: entry.prefix,
    db: dbPath,
    exists,
    createdAt: entry.createdAt,
  }

  if (!exists) {
    return { ...base, notes: null, chunks: null, terms: null, activeSpace: null }
  }

  const db = openDatabase(dbPath, { mustExist: true })
  try {
    return { ...base, ...projectStats(db) }
  } finally {
    db.close()
  }
}

/**
 * Asks a running daemon to drop the project before its files are deleted.
 *
 * Failure here is not fatal: no daemon, or one that will not answer, just means
 * the delete goes ahead and reports for itself if the file is still held.
 */
async function releaseFromDaemon(name: string, quiet: boolean): Promise<void> {
  try {
    const running = await currentDaemon()
    if (running === null) return

    const { unloaded } = await new DaemonClient(running).unload(name)
    if (unloaded && !quiet) printNote(`unloaded "${name}" from the daemon first`)
  } catch {
    // Nothing to do: removeProject says what is wrong if the file is locked.
  }
}

export function registerProjectCommands(program: Command): void {
  const project = program
    .command('project')
    .description('manage projects: each project is one SQLite database')

  project
    .command('add')
    .argument('<name>', 'project name, English only')
    .requiredOption('-d, --dir <path>', 'directory that will hold the project database')
    .option('-p, --prefix <prefix>', 'note id prefix, 2-4 characters (derived from the name)')
    .option('-f, --force', 're-point an existing registry entry to this directory')
    .option('--git', 'make the export directory a git repository')
    .option('--json', 'machine readable output')
    .description('create a project database and register it')
    .action((name: string, options: AddOptions) => {
      const result = createProject({
        name,
        dir: options.dir,
        prefix: options.prefix,
        force: options.force,
      })

      // Read before closing: adopting an existing database means the next id is
      // not 0001, and saying otherwise sends the operator looking for a note
      // that does not exist.
      const nextId = formatNoteId(result.prefix, getMetaNumber(result.db, META.ID_COUNTER, 0) + 1)

      let repository: string | null = null
      if (options.git === true && isAvailable()) {
        const exportPath = exportDirectory(result.dir, projectConfig(result.db))
        if (initRepository(exportPath).ok) repository = exportPath
      }

      const payload = {
        name: result.name,
        dir: result.dir,
        prefix: result.prefix,
        db: result.dbPath,
        created: result.created,
        nextId,
        repository,
        schemaVersion: result.migrations.to,
        migrationsApplied: result.migrations.applied,
      }

      result.db.close()

      if (options.json === true) {
        printJson(payload)
        return
      }

      printLine(
        result.created
          ? `Created project "${result.name}"`
          : `Adopted existing database for project "${result.name}"`,
      )
      printFields([
        ['prefix', result.prefix],
        ['directory', result.dir],
        ['database', result.dbPath],
        [
          'schema',
          result.migrations.applied.length > 0
            ? `${result.migrations.to} (applied ${result.migrations.applied.join(', ')})`
            : String(result.migrations.to),
        ],
      ])
      printLine()
      printLine(`Next note will be ${nextId}.`)
      if (repository !== null) printNote(`git repository ready at ${repository}`)
      else if (options.git === true) printNote('git is not on the PATH; skipped --git')
    })

  project
    .command('list')
    .option('--json', 'machine readable output')
    .description('list registered projects')
    .action((options: ListOptions) => {
      const projects = listEntries().map(describeProject)

      if (options.json === true) {
        printJson({ registry: registryLocation(), projects })
        return
      }

      if (projects.length === 0) {
        printLine('No projects registered.')
        printLine()
        printLine('Add one with:')
        printLine('  mnemonima project add "Shader Lab" --dir <path>')
        return
      }

      printTable(
        ['NAME', 'PREFIX', 'NOTES', 'CHUNKS', 'DIRECTORY'],
        projects.map((entry) => [
          String(entry['name']),
          String(entry['prefix']),
          entry['exists'] === true ? String(entry['notes']) : '-',
          entry['exists'] === true ? String(entry['chunks']) : '-',
          entry['exists'] === true ? String(entry['dir']) : `${String(entry['dir'])} (db missing)`,
        ]),
      )
      printLine()
      printNote(`registry: ${registryLocation()}`)
    })

  project
    .command('remove')
    .argument('<name>', 'project name')
    .option('--delete-data', 'also delete the project database file')
    .option('-y, --yes', 'confirm deletion of data')
    .option('--json', 'machine readable output')
    .description('unregister a project; the database is kept unless --delete-data is given')
    .action(async (name: string, options: RemoveOptions) => {
      if (options.deleteData === true && options.yes !== true) {
        throw new BadRequestError(
          '--delete-data permanently removes the project database',
          {
            details: { name },
            hint: `re-run with --yes to confirm, or omit --delete-data to keep the file`,
          },
        )
      }

      // The daemon holds the database open, and on Windows an open file cannot
      // be unlinked. Asking it to let go first is what the operator would be
      // told to do anyway, so the command does it rather than failing and
      // saying so.
      if (options.deleteData === true) await releaseFromDaemon(name, options.json === true)

      const result = removeProject(name, { deleteData: options.deleteData })

      if (options.json === true) {
        printJson({
          name: result.entry.name,
          dir: result.entry.dir,
          deletedFiles: result.deletedFiles,
        })
        return
      }

      printLine(`Unregistered project "${result.entry.name}".`)
      if (result.deletedFiles.length > 0) {
        printLine(`Deleted ${result.deletedFiles.length} file(s) under ${result.entry.dir}.`)
      } else {
        printLine(`Database kept at ${projectDbPath(result.entry.dir)}.`)
      }
    })
}
