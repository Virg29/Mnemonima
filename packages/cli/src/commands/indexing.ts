import { lowerProcessPriority } from '@mnemonima/core'
import { indexProject } from '@mnemonima/engine'
import { Command } from 'commander'
import { openContext, openEmbedder } from '../context.js'
import { Progress, formatDuration, printFields, printJson, printLine, printNote } from '../output.js'

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .summary('build or refresh the embedding index')
    .description(
      'Chunk every note twice — paragraph level and section level — and embed what is\n' +
        'not cached yet. Re-running is cheap: only chunks whose text changed are\n' +
        're-embedded, so editing one paragraph costs one or two vectors.\n' +
        '\n' +
        'Model weights are downloaded on first use into ~/.mnemonima/models.',
    )
    .option('-p, --project <name>', 'project name')
    .option('--full', 'ignore the caches and rebuild everything')
    .option('-m, --model <id>', 'embed with this model instead of the configured one')
    .option('--threads <n>', 'inference threads; defaults to half the available cores')
    .option('--no-activate', 'build the space without making it the one search uses')
    .option('--json', 'machine readable output')
    .option('-q, --quiet', 'suppress progress output')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  mnemonima index -p "Shader Lab"\n' +
        '  mnemonima index -p "Shader Lab" --full\n' +
        '  mnemonima index -p "Shader Lab" --model Xenova/gte-base --no-activate\n' +
        '\nChanging the model or the chunking settings builds a separate embedding space\n' +
        'rather than overwriting the current one, so switching back is instant.',
    )
    .action(
      async (options: {
        project?: string
        full?: boolean
        model?: string
        threads?: string
        activate?: boolean
        json?: boolean
        quiet?: boolean
      }) => {
        const context = openContext(options.project)
        const quiet = options.quiet === true || options.json === true
        const progress = new Progress(!quiet)

        try {
          // Indexing is a long CPU-bound job; the operator asked that it never
          // make the machine feel stuck.
          lowerProcessPriority()

          const resolved = await openEmbedder(context, {
            model: options.model,
            threads: options.threads,
          })

          if (!quiet) {
            printNote(
              `embedding with ${resolved.model.id} (${resolved.model.dim}d) on ${resolved.threads} thread(s)`,
            )
          }

          const report = await indexProject(context.project.db, context.config, resolved, {
            full: options.full,
            activate: options.activate,
            onEvent: (event) => {
              if (event.type === 'note') {
                progress.update(`chunking ${event.index + 1}/${event.total}  ${event.id}`)
              } else if (event.type === 'embedding' && event.total > 0) {
                progress.update(`embedding ${event.done}/${event.total} chunks`)
              }
            },
          })

          progress.done()
          await resolved.embedder.dispose()

          if (options.json === true) {
            printJson(report)
            return
          }

          printLine(`Indexed "${context.project.name}"`)
          printFields([
            ['space', `${report.spaceId}${report.active ? ' (active)' : ' (inactive)'}`],
            ['model', `${report.model} (${report.dim}d)`],
            [
              'notes',
              `${report.notesTotal} total, ${report.notesChunked} re-chunked, ` +
                `${report.notesUnchanged} unchanged` +
                (report.notesSkipped > 0 ? `, ${report.notesSkipped} skipped` : '') +
                (report.notesDropped > 0 ? `, ${report.notesDropped} retired` : ''),
            ],
            ['chunks', `${report.chunks} (${report.uniqueTexts} unique texts)`],
            ['terms', `${report.notesTermed} note(s) re-extracted`],
            [
              'links',
              `${report.links}` +
                (report.danglingLinks > 0 ? `, ${report.danglingLinks} dangling` : ''),
            ],
            ['vectors', `${report.embedded} embedded, ${report.reused} reused from cache`],
            ['took', formatDuration(report.tookMs)],
          ])

          if (report.notesTotal === 0) {
            printNote('no notes to index yet: create one with `mnemonima new`')
          }
        } finally {
          progress.done()
          context.close()
        }
      },
    )
}
