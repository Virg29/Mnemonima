import { adoptVault } from '@mnemonima/engine'
import type { AdoptReport } from '@mnemonima/engine'
import { Command } from 'commander'
import { openContext } from '../context.js'
import { printJson, printLine, printNote, printTable, truncate } from '../output.js'

/**
 * `mnemonima adopt` — DESIGN.md 14.1.
 *
 * Pulls in a directory of markdown that knows nothing about us. Not `import`,
 * which reads our own frontmatter; this is for somebody else's vault.
 *
 * **A dry run is the default.** Adoption creates a note per file and cannot be
 * undone by deleting one thing, so the report comes first and the writing
 * happens only when asked for by name.
 */
export function registerAdoptCommand(program: Command): void {
  program
    .command('adopt')
    .summary('pull in a directory of markdown that is not ours')
    .description(
      'Reads every markdown file under a directory and makes a note of each. Bodies\n' +
        'are stored exactly as written — embeds, block references and Dataview queries\n' +
        'are markdown, and not supporting that syntax is not a licence to delete it.\n' +
        '\n' +
        'The original filename becomes an alias, which is what makes the links already\n' +
        'in those files resolve: `[text](aspects.md)` finds the note that was\n' +
        '`aspects.md`. Run `mnemonima index` afterwards to rebuild the link graph.\n' +
        '\n' +
        'Running it again over the same directory updates what changed and leaves the\n' +
        'rest alone, matched on the path each note came from.\n' +
        '\n' +
        'It reports and changes nothing unless --write is given.',
    )
    .requiredOption('-d, --dir <path>', 'the directory to adopt')
    .option('-p, --project <name>', 'project name')
    .option('--write', 'actually create the notes; without it this is a dry run')
    .option('--import-anyway', 'bring non-English files in as well, instead of skipping them')
    .option(
      '--only <path...>',
      'take only these paths, relative to --dir; everything else is left behind',
    )
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mnemonima adopt --dir ./vault              # see what would happen',
        '  mnemonima adopt --dir ./vault --write',
        '  mnemonima index                            # resolve the links it brought in',
      ].join('\n'),
    )
    .action(
      (options: {
        dir: string
        project?: string
        write?: boolean
        only?: string[]
        importAnyway?: boolean
        json?: boolean
      }) => {
        const context = openContext(options.project)

        try {
          const report = adoptVault(context.project.db, context.config, context.project.dir, options.dir, {
            dryRun: options.write !== true,
            importAnyway: options.importAnyway,
            only: options.only,
            author: 'adopt',
          })

          if (options.json === true) {
            printJson(report)
            return
          }

          printReport(report)
        } finally {
          context.close()
        }
      },
    )
}

function printReport(report: AdoptReport): void {
  printLine(
    report.dryRun
      ? `Would adopt ${report.root} — nothing has been written`
      : `Adopted ${report.root}`,
  )

  printTable(
    ['', 'FILES'],
    [
      [report.dryRun ? 'to create' : 'created', String(report.created)],
      [report.dryRun ? 'to claim' : 'claimed', String(report.claimed)],
      [report.dryRun ? 'to update' : 'updated', String(report.updated)],
      ['unchanged', String(report.unchanged)],
      ['skipped', String(report.skipped)],
    ],
  )

  const claimed = report.files.filter((file) => file.action === 'claimed')
  if (claimed.length > 0) {
    printLine()
    printLine('Taken over by notes already here:')
    printTable(
      ['FILE', 'NOTE', 'TITLE'],
      claimed.map((file) => [truncate(file.sourcePath, 40), file.noteId ?? '', truncate(file.title, 34)]),
    )
    printNote('matched on the title, so the id and the history of each are kept')
  }

  const skipped = report.files.filter((file) => file.action === 'skipped')
  if (skipped.length > 0) {
    printLine()
    printLine('Skipped:')
    printTable(
      ['FILE', 'WHY'],
      skipped.map((file) => [truncate(file.sourcePath, 44), file.reason ?? '']),
    )
    printNote('use --import-anyway to bring these in rather than leave them behind')
  }

  if (report.collisions.length > 0) {
    printLine()
    printLine('Filenames more than one file claims:')
    for (const collision of report.collisions) {
      printLine(`  ${collision.name}: ${collision.paths.join(', ')}`)
    }
    printNote(
      'a link written as one of these names is ambiguous; the alias goes to whichever ' +
        'note was adopted first, so check those links by hand',
    )
  }

  printLine()
  printNote(
    report.dryRun
      ? 're-run with --write to do it'
      : 'run `mnemonima index` to embed them and rebuild the link graph',
  )
}
