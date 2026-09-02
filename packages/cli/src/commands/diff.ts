import { formatDiff } from '@mnemonima/core'
import type { Diff } from '@mnemonima/core'
import { diffRevisions } from '@mnemonima/engine'
import type { RevisionBody } from '@mnemonima/engine'
import { Command } from 'commander'
import { openContext, parsePositiveInt } from '../context.js'
import { printJson, printLine, printNote } from '../output.js'

/**
 * `mnemonima diff` — what changed between two revisions of a note.
 *
 * The log said when a note changed and who changed it, and nothing about what:
 * the only route to an old body was `revert`, so looking meant editing. Every
 * revision already carries the whole body, so this reads rather than restores.
 */
export function registerDiffCommand(program: Command): void {
  program
    .command('diff')
    .summary('show what changed between two revisions of a note')
    .description(
      'Compare two revisions of a note, or a revision with the note as it stands.\n' +
        '\n' +
        'With no revisions given it shows the last edit: the note now against the\n' +
        'revision before it. `--from` alone compares that revision with the note now.\n' +
        '\n' +
        'Nothing is changed. `mnemonima revert` is what puts a note back.',
    )
    .argument('<id>', 'note id, for example SL-0042')
    .option('-p, --project <name>', 'project name')
    .option('-r, --from <n>', 'the older revision')
    .option('-t, --to <n>', 'the newer revision; defaults to the note as it stands')
    .option('-C, --context <n>', 'unchanged lines to keep either side of a change', '3')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mnemonima diff SL-0042                 # the last edit',
        '  mnemonima diff SL-0042 --from 7        # revision 7 against the note now',
        '  mnemonima diff SL-0042 --from 7 --to 9',
        '  mnemonima history SL-0042              # which revisions there are',
      ].join('\n'),
    )
    .action(
      (
        id: string,
        options: { project?: string; from?: string; to?: string; context?: string; json?: boolean },
      ) => {
        const context = openContext(options.project)

        try {
          const result = diffRevisions(context.project.db, id, {
            from: options.from === undefined ? undefined : parsePositiveInt(options.from, '--from'),
            to: options.to === undefined ? undefined : parsePositiveInt(options.to, '--to'),
            context:
              options.context === undefined
                ? undefined
                : parsePositiveInt(options.context, '--context', { allowZero: true }),
          })

          if (options.json === true) {
            printJson(result)
            return
          }

          printLine(`${result.noteId}  ${describe(result.from)} -> ${describe(result.to)}`)
          printLine()

          if (result.diff.identical) {
            printNote('the two are the same text')
            return
          }

          if (result.diff.truncated) {
            printNote(
              `too large to compare line by line — ${result.diff.removed} line(s) against ` +
                `${result.diff.added}. Read either side with \`mnemonima get ${id} --rev <n>\`.`,
            )
            return
          }

          printSummary(result.diff)
          printLine()
          printLine(formatDiff(result.diff))
        } finally {
          context.close()
        }
      },
    )
}

/** "revision 7 (cli)" or "as it stands", so neither end can be mistaken for the other. */
function describe(side: RevisionBody): string {
  if (side.rev === null) return 'as it stands'
  return `revision ${side.rev}${side.author === null ? '' : ` (${side.author})`}`
}

function printSummary(diff: Diff): void {
  printNote(`+${diff.added} -${diff.removed}`)
}
