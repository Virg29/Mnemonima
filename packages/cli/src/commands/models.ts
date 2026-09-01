import {
  TransformersEmbedder,
  defaultThreadCount,
  listModels,
  resolveModel,
} from '@mnemonima/core'
import { modelsDir } from '@mnemonima/store'
import { Command } from 'commander'
import { formatDuration, printJson, printLine, printNote, printTable } from '../output.js'

export function registerModelCommands(program: Command): void {
  const models = program
    .command('models')
    .summary('inspect and download embedding models')
    .description(
      `Weights are cached in ${modelsDir()} and shared by every project, so switching\n` +
        'projects never re-downloads anything.',
    )

  models
    .command('list')
    .summary('list known embedding models')
    .option('--json', 'machine readable output')
    .action((options: { json?: boolean }) => {
      const known = listModels()

      if (options.json === true) {
        printJson({ cacheDir: modelsDir(), models: known })
        return
      }

      printTable(
        ['ID', 'DIM', 'CTX', 'SIZE', 'NOTES'],
        known.map((model) => [
          model.id,
          String(model.dim),
          String(model.maxTokens),
          model.offline ? '-' : `${model.sizeMb} MB`,
          model.note,
        ]),
      )
      printLine()
      printNote(`weights cache: ${modelsDir()}`)
      printNote(`default inference threads: ${defaultThreadCount()} (half the available cores)`)
    })

  models
    .command('pull')
    .summary('download a model ahead of time')
    .description(
      'Fetch the weights now so the first `index` run does not stall on a download.\n' +
        'Requires network access.',
    )
    .argument('<id>', 'model id, for example Supabase/gte-small')
    .option('--json', 'machine readable output')
    .action(async (id: string, options: { json?: boolean }) => {
      const model = resolveModel(id)

      if (model.offline) {
        if (options.json === true) {
          printJson({ id: model.id, downloaded: false, reason: 'offline model' })
          return
        }
        printLine(`${model.id} needs no download: ${model.note}`)
        return
      }

      const started = Date.now()
      if (options.json !== true) {
        printNote(`downloading ${model.id} (~${model.sizeMb} MB) into ${modelsDir()}`)
      }

      const embedder = await TransformersEmbedder.create(model, { cacheDir: modelsDir() })
      // A real forward pass proves the weights and the tokenizer both load.
      const probe = await embedder.embedQuery('shaders introducing')
      await embedder.dispose()

      if (options.json === true) {
        printJson({ id: model.id, downloaded: true, dim: probe.length, tookMs: Date.now() - started })
        return
      }

      printLine(`Ready: ${model.id} (${probe.length} dimensions)`)
      printNote(`took ${formatDuration(Date.now() - started)}`)
    })
}
