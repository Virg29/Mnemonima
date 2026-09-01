import {
  addRelatedLink,
  fixDoctorFindings,
  loadGraph,
  neighboursOf,
  removeRelatedLink,
  runDoctor,
} from '@mnemonima/engine'
import { incomingLinks, outgoingLinks, requireNote } from '@mnemonima/store'
import { Command } from 'commander'
import { openContext } from '../context.js'
import { printFields, printJson, printLine, printNote, printTable, truncate } from '../output.js'

const AUTHOR = 'cli'

export function registerGraphCommands(program: Command): void {
  program
    .command('link')
    .summary('link one note to another')
    .description(
      'Add a link by appending it to a `## Related` section in the source note. ' +
        'Links are derived from note bodies, so editing the body is the only way to ' +
        'create one that survives the next index run. The backlink on the target ' +
        'appears automatically; the target note is not touched.',
    )
    .argument('<from>', 'note that will carry the link')
    .argument('<to>', 'note it points at')
    .option('-p, --project <name>', 'project name')
    .option('-a, --anchor <text>', 'display text; also a keyword signal for the target')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mnemonima link SL-0042 SL-0007',
        '  mnemonima link SL-0042 SL-0007 --anchor "shader basics"',
      ].join('\n'),
    )
    .action((from: string, to: string, options: { project?: string; anchor?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const change = addRelatedLink(
          context.project.db,
          context.config,
          from,
          to,
          options.anchor ?? null,
          AUTHOR,
        )

        if (options.json === true) {
          printJson(change)
          return
        }

        printLine(`${from} -> ${to}`)
        printNote(`${from} is now at revision ${change.rev}`)
      } finally {
        context.close()
      }
    })

  program
    .command('unlink')
    .summary('remove a link between two notes')
    .description(
      'Remove a link from the `## Related` section of the source note. A link written ' +
        'into the prose is left alone: cutting it out would change the meaning of a ' +
        'sentence, so that edit stays with a human.',
    )
    .argument('<from>', 'note that carries the link')
    .argument('<to>', 'note it points at')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .action((from: string, to: string, options: { project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const change = removeRelatedLink(context.project.db, context.config, from, to, AUTHOR)

        if (options.json === true) {
          printJson(change)
          return
        }

        printLine(`removed ${from} -> ${to}`)
        printNote(`${from} is now at revision ${change.rev}`)
      } finally {
        context.close()
      }
    })

  program
    .command('links')
    .summary('show what a note links to and what links back')
    .description(
      'Backlinks are derived from the bodies of other notes, never stored as editable ' +
        'state, so this is always in step with what the notes actually say.',
    )
    .argument('<id>', 'note id')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .action((id: string, options: { project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const note = requireNote(context.project.db, id)
        const out = outgoingLinks(context.project.db, note.id)
        const back = incomingLinks(context.project.db, note.id)

        if (options.json === true) {
          printJson({ id: note.id, title: note.title, links: out, backlinks: back })
          return
        }

        printLine(`${note.id}  ${note.title}`)
        printLine()

        if (out.length === 0) printLine('  links to: nothing')
        else {
          printLine('  links to:')
          for (const link of out) {
            const label = link.resolved ? link.dst : `${link.dst}  (dangling)`
            printLine(`    ${label}${link.anchor === null ? '' : `  "${link.anchor}"`}`)
          }
        }

        printLine()
        if (back.length === 0) printLine('  linked from: nothing')
        else {
          printLine('  linked from:')
          for (const link of back) {
            printLine(`    ${link.src}${link.anchor === null ? '' : `  "${link.anchor}"`}`)
          }
        }
      } finally {
        context.close()
      }
    })

  program
    .command('neighbours')
    .alias('neighbors')
    .summary('list the direct neighbours of a note')
    .argument('<id>', 'note id')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .action((id: string, options: { project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const note = requireNote(context.project.db, id)
        const graph = loadGraph(context.project.db)
        const neighbours = neighboursOf(context.project.db, graph, note.id)

        if (options.json === true) {
          printJson({ id: note.id, neighbours })
          return
        }

        if (neighbours.length === 0) {
          printLine(`${note.id} has no neighbours.`)
          printNote(`add one with \`mnemonima link ${note.id} <other>\``)
          return
        }

        printTable(
          ['ID', 'RELATION', 'TITLE'],
          neighbours.map((entry) => [entry.id, entry.relation, truncate(entry.title, 60)]),
        )
      } finally {
        context.close()
      }
    })

  program
    .command('doctor')
    .summary('check the integrity of a project')
    .description(
      'Report what has drifted: dangling links, orphan notes, content that failed the ' +
        'language gate, notes that were never indexed, a stale id counter, attachment ' +
        'paths that no longer exist.\n' +
        '\n' +
        'Nothing here is corrected on its own. A dangling link and an orphan note are ' +
        'both legitimate states; deciding otherwise is your call. --fix touches only ' +
        'the two things that are mechanically wrong: links whose target now exists, ' +
        'and an id counter that fell behind.',
    )
    .option('-p, --project <name>', 'project name')
    .option('--fix', 're-resolve links and raise the id counter')
    .option('--json', 'machine readable output')
    .action((options: { project?: string; fix?: boolean; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const fixed = options.fix === true ? fixDoctorFindings(context.project.db) : null
        const report = runDoctor(context.project.db, { dir: context.project.dir })

        if (options.json === true) {
          printJson({ project: context.project.name, ...report, fixed })
          return
        }

        printLine(`Checked "${context.project.name}"`)
        printFields([
          ['notes', String(report.notes)],
          ['links', String(report.links)],
          ['active space', report.activeSpace ?? 'none — run `mnemonima index`'],
        ])
        printLine()

        if (fixed !== null) {
          printLine('Fixed:')
          printFields([
            ['links resolved', String(fixed.linksResolved)],
            ['id counter', fixed.idCounterRaisedTo ?? 'already correct'],
          ])
          printLine()
        }

        const sections: [string, string[]][] = [
          [
            'dangling links (kept as written)',
            report.dangling.map((entry) => `${entry.src} -> ${entry.target}`),
          ],
          ['orphan notes (no links either way)', report.orphans],
          ['not English (stored, never indexed)', report.nonEnglish],
          ['not indexed yet', report.unindexed],
          [
            'missing attachments',
            report.missingAttachments.map((entry) => `${entry.noteId}: ${entry.target}`),
          ],
          [
            'duplicate aliases',
            report.duplicateAliases.map((entry) => `"${entry.alias}" on ${entry.notes.join(', ')}`),
          ],
        ]

        let clean = true
        for (const [label, entries] of sections) {
          if (entries.length === 0) continue
          clean = false
          printLine(`${label}: ${entries.length}`)
          for (const entry of entries.slice(0, 20)) printLine(`  ${entry}`)
          if (entries.length > 20) printLine(`  ... and ${entries.length - 20} more`)
          printLine()
        }

        if (report.chunksWithoutVectors > 0) {
          clean = false
          printLine(`chunks without vectors: ${report.chunksWithoutVectors}`)
          printNote('run `mnemonima index` — an interrupted run heals itself')
          printLine()
        }

        if (report.idCounterBehind !== null) {
          clean = false
          printLine(
            `id counter is at ${report.idCounterBehind.counter} but ` +
              `${report.idCounterBehind.highest} is in use`,
          )
          printNote('run `mnemonima doctor --fix` before creating more notes')
          printLine()
        }

        if (clean) printLine('Nothing to report.')
      } finally {
        context.close()
      }
    })
}
