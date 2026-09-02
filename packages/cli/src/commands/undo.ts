import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { revertNote, undoBatch } from '@mnemonima/engine'
import { listBatches } from '@mnemonima/store'
import { Command } from 'commander'
import { openContext, parsePositiveInt } from '../context.js'
import { printJson, printLine, printNote, printTable, truncate } from '../output.js'

const AUTHOR = 'cli'

export function registerUndoCommands(program: Command): void {
  program
    .command('revert')
    .summary('put a note back to an earlier revision')
    .description(
      'Restore the title and body a note had at a given revision. This moves the note\n' +
        'forward to an old state rather than rewriting history: the revert is itself a\n' +
        'revision, so it can be reverted in turn.',
    )
    .argument('<id>', 'note id')
    .requiredOption('-r, --rev <n>', 'revision to restore')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .action((id: string, options: { rev: string; project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const result = revertNote(
          context.project.db,
          context.config,
          id,
          parsePositiveInt(options.rev, '--rev'),
          AUTHOR,
        )

        if (options.json === true) {
          printJson(result)
          return
        }

        printLine(`Reverted ${result.noteId} to the content of revision ${result.toRev}`)
        printNote(`it is now at revision ${result.newRev}; run \`mnemonima index\` to refresh`)
      } finally {
        context.close()
      }
    })

  program
    .command('undo')
    .summary('take back everything one session wrote')
    .description(
      'Undo a batch. Every write records the batch it belongs to, and an agent session\n' +
        'over MCP is one batch, so a whole run can be taken back with one command.\n' +
        '\n' +
        'Nothing is destroyed: each note is moved back to the revision it held before the\n' +
        'batch touched it, and a note the batch created is archived rather than deleted.\n' +
        'The undo is itself recorded, so the log keeps the whole story.',
    )
    .requiredOption('-b, --batch <id>', 'batch id, from `mnemonima history --batches`')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      ['', 'Examples:', '  mnemonima history --batches', '  mnemonima undo --batch mcp-20260901T101500-a1b2c3'].join(
        '\n',
      ),
    )
    .action((options: { batch: string; project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const report = undoBatch(context.project.db, context.config, options.batch, AUTHOR)

        if (options.json === true) {
          printJson(report)
          return
        }

        printLine(`Undid batch ${report.batchId}`)
        printTable(
          ['NOTE', 'ACTION', 'BACK TO'],
          report.actions.map((action) => [
            action.noteId,
            action.action,
            action.toRev === undefined ? '-' : `revision ${action.toRev}`,
          ]),
        )
        printNote('run `mnemonima index` to refresh the embeddings and terms')
      } finally {
        context.close()
      }
    })

  program
    .command('mcp')
    .summary('run the MCP server for an agent')
    .description(
      'Speak the Model Context Protocol over stdio, so an agent can search, read, write\n' +
        'and administer this project as tools.\n' +
        '\n' +
        'The session is bound to one project: no tool takes a project argument, so a\n' +
        'cross-project write cannot be expressed. Every write records its author and a\n' +
        'batch id for the whole session, printed on startup, so `mnemonima undo --batch`\n' +
        'takes the entire run back. Destructive tools — deleting a note, forgetting a\n' +
        'term, rebuilding with another model — are refused unless mcp.allowDestructive is\n' +
        'on for the project.\n' +
        '\n' +
        'stdout carries the protocol; diagnostics go to stderr.',
    )
    .option('-p, --project <name>', 'project name')
    .option('--client <name>', 'how to record the writer, e.g. claude-code', 'agent')
    .addHelpText(
      'after',
      [
        '',
        'Register it with an agent that reads .mcp.json. Nothing is published to a',
        'registry, so the reliable form names the built entry point outright:',
        '  {',
        '    "mcpServers": {',
        '      "mnemonima": {',
        '        "command": "node",',
        '        "args": [',
        '          "/absolute/path/to/Mnemonima/packages/cli/dist/index.js",',
        '          "mcp", "-p", "Shader Lab", "--client", "claude-code"',
        '        ]',
        '      }',
        '    }',
        '  }',
        '',
        'With the command on PATH, "command": "mnemonima" and args without the path',
        'is equivalent.',
      ].join('\n'),
    )
    .action(async () => {
      // The server reads its own argv, and takes over the process from here.
      // pathToFileURL because a resolved Windows path is not a URL the ESM
      // loader will accept.
      const require = createRequire(import.meta.url)
      await import(pathToFileURL(require.resolve('@mnemonima/mcp/main')).href)
    })
}

/** Shared with `history --batches`, kept here with the rest of the undo story. */
export function printBatches(
  db: Parameters<typeof listBatches>[0],
  limit: number,
  json: boolean,
): void {
  const batches = listBatches(db, limit)

  if (json) {
    printJson({ batches })
    return
  }

  if (batches.length === 0) {
    printLine('No batched writes recorded.')
    printNote('agent sessions over MCP and imports are what create them')
    return
  }

  printTable(
    ['BATCH', 'AUTHOR', 'NOTES', 'WRITES', 'WHEN'],
    batches.map((batch) => [
      truncate(batch.batchId, 32),
      batch.author,
      String(batch.notes),
      String(batch.revisions),
      new Date(batch.endedAt).toISOString(),
    ]),
  )
  printNote('take one back with `mnemonima undo --batch <id>`')
}
