import { BadRequestError, defaultProjectConfig, resolveModel } from '@mnemonima/core'
import { setConfig } from '@mnemonima/store'
import { Command } from 'commander'
import { openContext } from '../context.js'
import { coerce, flatten, readPath, requirePath, writePath } from '../config-path.js'
import { printJson, printLine, printNote, printTable } from '../output.js'

/**
 * Project configuration, edited by dotted path. The path and type validation
 * lives in `../config-path.ts`, where it is unit tested.
 */

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .summary('inspect and change project settings')
    .description(
      'Settings are stored in the project database and merged onto the defaults, so a\n' +
        'key added by a later release appears with its default rather than as undefined.',
    )

  config
    .command('show')
    .summary('print the effective configuration')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .option('--changed', 'only keys that differ from the defaults')
    .action((options: { project?: string; json?: boolean; changed?: boolean }) => {
      const context = openContext(options.project)
      try {
        if (options.json === true) {
          printJson(context.config)
          return
        }

        const defaults = new Map(flatten(defaultProjectConfig()))
        const rows = flatten(context.config)
          .filter(([key, value]) => options.changed !== true || defaults.get(key) !== value)
          .map(([key, value]) => [key, JSON.stringify(value) ?? 'null'] as const)

        if (rows.length === 0) {
          printLine('Everything is at its default value.')
          return
        }

        printTable(['KEY', 'VALUE'], rows)
      } finally {
        context.close()
      }
    })

  config
    .command('get')
    .summary('print one setting')
    .argument('<path>', 'dotted key, for example search.hybridWeights.vector')
    .option('-p, --project <name>', 'project name')
    .action((path: string, options: { project?: string }) => {
      requirePath(path)
      const context = openContext(options.project)
      try {
        printLine(String(JSON.stringify(readPath(context.config, path.split('.')))))
      } finally {
        context.close()
      }
    })

  config
    .command('set')
    .summary('change one setting')
    .description(
      'Change a setting by dotted path. Settings that affect how text is cut or\n' +
        'embedded define a new embedding space, so the next `index` run builds one\n' +
        'beside the current index rather than corrupting it.',
    )
    .argument('<path>', 'dotted key, for example model.active')
    .argument('<value>', 'new value, typed to match the current one')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  mnemonima config set model.active Xenova/gte-base\n' +
        '  mnemonima config set search.limits.resultK 20\n' +
        '  mnemonima config set keywords.autoEnabled false\n' +
        '  mnemonima config set language.gate warn',
    )
    .action((path: string, raw: string, options: { project?: string; json?: boolean }) => {
      const current = requirePath(path)
      const value = coerce(path, raw, current)

      // Catch a bad model id here rather than three minutes into an index run.
      if (path === 'model.active') resolveModel(String(value))
      if (path === 'language.gate' && !['strict', 'warn', 'off'].includes(String(value))) {
        throw new BadRequestError(`language.gate must be strict, warn or off, got "${raw}"`, {
          details: { raw },
          hint: 'strict rejects non-English content, warn only reports it',
        })
      }

      const context = openContext(options.project)
      try {
        const next = structuredClone(context.config) as unknown as Record<string, unknown>
        const previous = readPath(next, path.split('.'))
        writePath(next, path.split('.'), value)
        setConfig(context.project.db, next as never)

        if (options.json === true) {
          printJson({ path, previous, value })
          return
        }

        printLine(`${path}: ${JSON.stringify(previous)} -> ${JSON.stringify(value)}`)

        if (path.startsWith('chunking.') || path === 'model.active') {
          printNote('this defines a new embedding space: run `mnemonima index` to build it')
        }
      } finally {
        context.close()
      }
    })
}
