import { BadRequestError } from '@mnemonima/core'
import { exportDirectory, exportProject, importProject, initRepository, isAvailable } from '@mnemonima/engine'
import type { ConflictPolicy } from '@mnemonima/engine'
import { Command } from 'commander'
import { openContext } from '../context.js'
import { printFields, printJson, printLine, printNote, printTable, truncate } from '../output.js'

const POLICIES: readonly ConflictPolicy[] = ['ask', 'db', 'file', 'both']

function parsePolicy(raw: string): ConflictPolicy {
  if ((POLICIES as readonly string[]).includes(raw)) return raw as ConflictPolicy

  throw new BadRequestError(`unknown conflict policy "${raw}"`, {
    details: { policy: raw, available: POLICIES },
    hint:
      'ask reports them and changes nothing, db keeps the database, ' +
      'file takes the file, both keeps each as its own note',
  })
}

export function registerBridgeCommands(program: Command): void {
  program
    .command('export')
    .summary('write the notes out as markdown')
    .description(
      'Export every note to a directory Obsidian and git can read. The frontmatter has\n' +
        'two halves: the fields above the generated marker come back on import, the ones\n' +
        'below are written for the reader and discarded.\n' +
        '\n' +
        'Only files carrying one of this project\'s ids are ever removed; anything else\n' +
        'in the directory is yours and is left alone. Pushing is never automatic.',
    )
    .option('-p, --project <name>', 'project name')
    .option('-d, --dir <path>', 'where to write; defaults to the configured export path')
    .option('--no-commit', 'write the files without committing them')
    .option('--push', 'push after committing')
    .option('--init-git', 'make the export directory a git repository first')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mnemonima export',
        '  mnemonima export --init-git',
        '  mnemonima export --dir ../vault --no-commit',
      ].join('\n'),
    )
    .action(
      (options: {
        project?: string
        dir?: string
        commit?: boolean
        push?: boolean
        initGit?: boolean
        json?: boolean
      }) => {
        const context = openContext(options.project)
        try {
          const dir = options.dir ?? exportDirectory(context.project.dir, context.config)

          if (options.initGit === true) {
            if (!isAvailable()) {
              throw new BadRequestError('git is not on the PATH', {
                details: { dir },
                hint: 'install git, or export without --init-git',
              })
            }
            const init = initRepository(dir)
            if (!init.ok) {
              throw new BadRequestError(`could not initialise a repository in ${dir}`, {
                details: { dir, output: init.output },
                hint: 'check the directory permissions',
              })
            }
          }

          const report = exportProject(context.project.db, context.config, context.project.dir, {
            dir: options.dir,
            commit: options.commit,
            push: options.push,
          })

          if (options.json === true) {
            printJson({ project: context.project.name, ...report })
            return
          }

          printLine(`Exported "${context.project.name}"`)
          printFields([
            ['directory', report.dir],
            [
              'files',
              `${report.created.length} created, ${report.updated.length} updated, ` +
                `${report.unchanged.length} unchanged` +
                (report.removed.length > 0 ? `, ${report.removed.length} removed` : ''),
            ],
            ['commit', report.commit ?? (report.committed ? 'yes' : 'none')],
          ])

          if (report.pushed) printNote('pushed')
          if (report.note !== null) printNote(report.note)
        } finally {
          context.close()
        }
      },
    )

  program
    .command('import')
    .summary('read markdown back into the database')
    .description(
      'Read an exported directory back. Only the authoritative frontmatter is used:\n' +
        'the title, tags, aliases and manual terms. Everything generated is recomputed,\n' +
        'so editing it in the file changes nothing.\n' +
        '\n' +
        'A file whose revision is behind the database while both bodies differ is a\n' +
        'conflict. By default they are listed and nothing is changed; --on-conflict\n' +
        'says which side wins, and `both` keeps each as its own note so nothing is lost.',
    )
    .option('-p, --project <name>', 'project name')
    .option('-d, --dir <path>', 'where to read from; defaults to the configured export path')
    .option('--on-conflict <policy>', 'ask | db | file | both', 'ask')
    .option('--dry-run', 'report what would change without writing')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mnemonima import --dry-run',
        '  mnemonima import --on-conflict file',
        '  mnemonima import --on-conflict both',
      ].join('\n'),
    )
    .action(
      (options: {
        project?: string
        dir?: string
        onConflict?: string
        dryRun?: boolean
        json?: boolean
      }) => {
        const context = openContext(options.project)
        try {
          const report = importProject(context.project.db, context.config, context.project.dir, {
            dir: options.dir,
            onConflict: parsePolicy(options.onConflict ?? 'ask'),
            dryRun: options.dryRun,
          })

          if (options.json === true) {
            printJson({ project: context.project.name, ...report })
            return
          }

          printLine(report.dryRun ? 'Would import' : `Imported into "${context.project.name}"`)
          printFields([
            ['directory', report.dir],
            [
              'notes',
              `${report.created.length} created, ${report.updated.length} updated, ` +
                `${report.unchanged.length} unchanged`,
            ],
          ])

          if (report.conflicts.length > 0) {
            printLine()
            printLine(`conflicts: ${report.conflicts.length}`)
            printTable(
              ['NOTE', 'FILE REV', 'DB REV', 'RESOLUTION', 'FILE'],
              report.conflicts.map((conflict) => [
                conflict.id,
                String(conflict.fileRev),
                String(conflict.dbRev),
                conflict.resolution + (conflict.copyId === undefined ? '' : ` as ${conflict.copyId}`),
                truncate(conflict.file, 40),
              ]),
            )

            if (report.conflicts.some((conflict) => conflict.resolution === 'reported')) {
              printNote(
                're-run with --on-conflict file, db, or both to decide — ' +
                  '`both` keeps each version as its own note',
              )
            }
          }

          if (report.skipped.length > 0) {
            printLine()
            printLine(`skipped: ${report.skipped.length}`)
            for (const skip of report.skipped.slice(0, 10)) {
              printLine(`  ${truncate(skip.file, 40)}  ${skip.reason}`)
            }
          }

          if (!report.dryRun && report.created.length + report.updated.length > 0) {
            printNote('run `mnemonima index` to refresh the embeddings and terms')
          }
        } finally {
          context.close()
        }
      },
    )
}
