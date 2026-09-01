import { createRequire } from 'node:module'
import { EXIT, MnemonimaError } from '@mnemonima/core'
import { registryLocation } from '@mnemonima/store'
import { Command, CommanderError } from 'commander'
import { printFailure } from './output.js'
import { registerBridgeCommands } from './commands/bridge.js'
import { registerConfigCommands } from './commands/config.js'
import { registerDaemonCommands } from './commands/daemon.js'
import { registerFindCommand } from './commands/find.js'
import { registerGraphCommands } from './commands/graph.js'
import { registerIndexCommand } from './commands/indexing.js'
import { registerModelCommands } from './commands/models.js'
import { registerNoteCommands } from './commands/note.js'
import { registerProjectCommands } from './commands/project.js'
import { registerTermCommands } from './commands/terms.js'
import { registerUndoCommands } from './commands/undo.js'
import { registerEvalCommand } from './commands/eval.js'
import { registerUiCommand } from './commands/ui.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

function fail(error: unknown): never {
  if (error instanceof CommanderError) {
    // Commander already decided whether this was a success: printing help or the
    // version carries exit code 0, a usage mistake carries non-zero. Trusting
    // that is more robust than matching its error codes by name, which differ
    // between an explicit `--help` and help shown after an error.
    process.exit(error.exitCode === 0 ? EXIT.OK : EXIT.BAD_REQUEST)
  }

  printFailure(error)
  process.exit(error instanceof MnemonimaError ? error.exitCode : EXIT.INTERNAL)
}

const program = new Command()

program
  .name('mnemonima')
  .description('Local hybrid search over a graph of markdown notes, built for AI agents')
  .version(pkg.version, '-v, --version')
  .showHelpAfterError('(run `mnemonima help <command>` for details)')
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({
    writeErr: (text) => process.stderr.write(text),
    writeOut: (text) => process.stdout.write(text),
  })

registerProjectCommands(program)
registerNoteCommands(program)
registerGraphCommands(program)
registerIndexCommand(program)
registerFindCommand(program)
registerModelCommands(program)
registerTermCommands(program)
registerDaemonCommands(program)
registerEvalCommand(program)
registerUiCommand(program)
registerBridgeCommands(program)
registerUndoCommands(program)
registerConfigCommands(program)

program.addHelpText(
  'after',
  `
Getting started:
  mnemonima project add "Shader Lab" --dir ./shaders   create a project database
  mnemonima new --file notes/shaders.md                add a note
  mnemonima index                                      chunk and embed it
  mnemonima find -q "how a fragment shader runs"       search

Choosing a project:
  Commands take -p <name>. When it is omitted, MNEMONIMA_PROJECT is used, and
  when exactly one project is registered that one is used automatically.

Where things live:
  <project dir>/.mnemonima/    everything for one project: the database, its
                               export and its eval set, and nothing else
  ${registryLocation()}
  ~/.mnemonima/models/         downloaded model weights, shared by all projects

Rules:
  Everything stored is English. Non-English content and queries are rejected
  with exit code 3 rather than indexed badly.

Output:
  With --json, stdout carries JSON and nothing else; notes and warnings go to
  stderr. Result order is deterministic, so repeated runs can be diffed.

Exit codes:
  0 success   1 not found   2 bad request   3 not English
  4 daemon unavailable      70 internal error
`,
)

try {
  await program.parseAsync(process.argv)
} catch (error) {
  fail(error)
}
