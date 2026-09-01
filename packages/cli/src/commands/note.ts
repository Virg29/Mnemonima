import fs from 'node:fs'
import { assertEnglishScript, BadRequestError } from '@mnemonima/core'
import {
  addAlias,
  deleteNote,
  incomingLinks,
  listAliases,
  listNotes,
  listRevisions,
  outgoingLinks,
  removeAlias,
  requireNote,
} from '@mnemonima/store'
import { writeNewNote, writeNoteBody } from '@mnemonima/engine'
import { Command } from 'commander'
import { openContext, parsePositiveInt } from '../context.js'
import { printBatches } from './undo.js'
import { printFields, printJson, printLine, printNote, printTable, printWarning, truncate } from '../output.js'

/** Where an agent or a script is identified in the revision log. */
const AUTHOR = 'cli'

interface BodySource {
  readonly file?: string
  readonly body?: string
}

interface ReadBodyOptions {
  /** Named in the hint, so it points at the command actually being run. */
  readonly command: string
  /** When true, "nothing supplied" is a valid answer rather than an error. */
  readonly optional?: boolean
}

/**
 * Reads note content from `--file`, `--body`, or standard input.
 *
 * Refusing to guess keeps `mnemonima new` from hanging on a terminal waiting for
 * input the operator did not mean to give. `edit` passes `optional`, because
 * changing only the title should not require resupplying the whole body.
 */
function readBody(source: BodySource, options: ReadBodyOptions): string | null {
  if (source.body !== undefined) return source.body

  if (source.file !== undefined) {
    if (!fs.existsSync(source.file)) {
      throw new BadRequestError(`no such file: ${source.file}`, {
        details: { file: source.file },
        hint: 'check the path, or pass the text directly with --body',
      })
    }
    return fs.readFileSync(source.file, 'utf8')
  }

  const hint =
    `use --file <path> or --body "<markdown>", ` +
    `or pipe a file: cat note.md | mnemonima ${options.command}`

  if (process.stdin.isTTY === true) {
    if (options.optional === true) return null
    throw new BadRequestError('no note body given', { details: {}, hint })
  }

  const piped = fs.readFileSync(0, 'utf8')
  if (piped.trim() === '') {
    if (options.optional === true) return null
    throw new BadRequestError('nothing arrived on stdin', { details: {}, hint })
  }

  return piped
}

export function registerNoteCommands(program: Command): void {
  program
    .command('new')
    .summary('create a note')
    .description(
      'Create a note from markdown. The title comes from --title, otherwise from the\n' +
        'first level-one heading. Content must be English (DESIGN.md 11).',
    )
    .option('-p, --project <name>', 'project name')
    .option('-t, --title <title>', 'note title; defaults to the first # heading')
    .option('-f, --file <path>', 'read the body from a file')
    .option('-b, --body <markdown>', 'body given inline')
    .option('--id <id>', 'use this note id instead of allocating the next one')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  mnemonima new -p "Shader Lab" --file notes/shaders.md\n' +
        '  mnemonima new -p "Shader Lab" -t "Uniforms" -b "# Uniforms\\n\\nA uniform is..."\n' +
        '  cat draft.md | mnemonima new -p "Shader Lab"\n' +
        '\nThe note is not searchable until you run `mnemonima index`.',
    )
    .action((options: { project?: string; title?: string; file?: string; body?: string; id?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const body = readBody(options, { command: 'new' })!
        const result = writeNewNote(context.project.db, context.config, body, {
          title: options.title,
          id: options.id,
          author: AUTHOR,
        })

        if (result.warning !== null) printWarning(result.warning.message)

        if (options.json === true) {
          printJson({ id: result.note.id, title: result.note.title, rev: result.note.rev })
          return
        }

        printLine(`Created ${result.note.id}`)
        printFields([
          ['title', result.note.title],
          ['revision', String(result.note.rev)],
        ])
        printNote('run `mnemonima index` to make it searchable')
      } finally {
        context.close()
      }
    })

  program
    .command('edit')
    .summary('replace the body of a note')
    .description(
      'Replace a note body, its title, or both. When no body is supplied the ' +
        'stored one is kept, so --title alone renames a note. A revision is ' +
        'recorded either way, so the change is undoable.',
    )
    .argument('<id>', 'note id, for example SL-0042')
    .option('-p, --project <name>', 'project name')
    .option('-t, --title <title>', 'new title; defaults to the first # heading')
    .option('-f, --file <path>', 'read the body from a file')
    .option('-b, --body <markdown>', 'body given inline')
    .option('--expect-rev <n>', 'fail unless the note is at this revision')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mnemonima edit SL-0042 --file notes/shaders.md',
        '  mnemonima edit SL-0042 --title "Shaders, revisited"',
        '  mnemonima edit SL-0042 --file draft.md --expect-rev 7',
      ].join('\n'),
    )
    .action(
      (
        id: string,
        options: { project?: string; title?: string; file?: string; body?: string; expectRev?: string; json?: boolean },
      ) => {
        const context = openContext(options.project)
        try {
          const supplied = readBody(options, { command: 'edit', optional: true })

          if (supplied === null && options.title === undefined) {
            throw new BadRequestError(`nothing to change on ${id}`, {
              details: { id },
              hint: 'pass --title to rename it, or --file/--body/stdin to replace the body',
            })
          }

          const body = supplied ?? requireNote(context.project.db, id).body
          const result = writeNoteBody(context.project.db, context.config, id, body, {
            title: options.title,
            author: AUTHOR,
            expectedRev:
              options.expectRev === undefined
                ? undefined
                : parsePositiveInt(options.expectRev, '--expect-rev'),
          })

          if (result.warning !== null) printWarning(result.warning.message)

          if (options.json === true) {
            printJson({ id: result.note.id, title: result.note.title, rev: result.note.rev })
            return
          }

          printLine(`Updated ${result.note.id} to revision ${result.note.rev}`)
          printNote('run `mnemonima index` to refresh the embeddings')
        } finally {
          context.close()
        }
      },
    )

  program
    .command('get')
    .summary('print one note')
    .description('Print a note. Without --json the body is written to stdout after the header.')
    .argument('<id>', 'note id, for example SL-0042')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .option('--body-only', 'print just the markdown body')
    .option('-N, --with-neighbours', 'also show links, backlinks and aliases')
    .action(
      (
        id: string,
        options: { project?: string; json?: boolean; bodyOnly?: boolean; withNeighbours?: boolean },
      ) => {
      const context = openContext(options.project)
      try {
        const note = requireNote(context.project.db, id)
        const extras =
          options.withNeighbours === true
            ? {
                links: outgoingLinks(context.project.db, note.id),
                backlinks: incomingLinks(context.project.db, note.id).map((link) => link.src),
                aliases: listAliases(context.project.db, note.id).map((entry) => entry.alias),
              }
            : null

        if (options.json === true) {
          printJson(extras === null ? note : { ...note, ...extras })
          return
        }

        if (options.bodyOnly === true) {
          process.stdout.write(note.body.endsWith('\n') ? note.body : `${note.body}\n`)
          return
        }

        printLine(`${note.id}  ${note.title}`)
        printFields([
          ['status', note.status],
          ['revision', String(note.rev)],
          ['language', note.lang],
          ['updated', new Date(note.updatedAt).toISOString()],
        ])
        if (extras !== null) {
          printFields([
            ['aliases', extras.aliases.length === 0 ? '-' : extras.aliases.join(', ')],
            [
              'links to',
              extras.links.length === 0
                ? '-'
                : extras.links
                    .map((link) => (link.resolved ? link.dst : `${link.dst} (dangling)`))
                    .join(', '),
            ],
            ['linked from', extras.backlinks.length === 0 ? '-' : extras.backlinks.join(', ')],
          ])
        }

        printLine()
        printLine(note.body)
      } finally {
        context.close()
      }
    },
    )

  program
    .command('list')
    .summary('list notes')
    .description('List notes in id order.')
    .option('-p, --project <name>', 'project name')
    .option('-s, --status <status>', 'active | draft | archived | any', 'active')
    .option('-n, --limit <n>', 'maximum notes to print', '50')
    .option('--json', 'machine readable output')
    .action((options: { project?: string; status?: string; limit?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const status = options.status ?? 'active'
        if (!['active', 'draft', 'archived', 'any'].includes(status)) {
          throw new BadRequestError(`unknown status "${status}"`, {
            details: { status },
            hint: 'use one of: active, draft, archived, any',
          })
        }

        const notes = listNotes(context.project.db, {
          status: status as 'active' | 'draft' | 'archived' | 'any',
          limit: parsePositiveInt(options.limit ?? '50', '--limit'),
        })

        if (options.json === true) {
          printJson({
            project: context.project.name,
            notes: notes.map((note) => ({
              id: note.id,
              title: note.title,
              status: note.status,
              rev: note.rev,
              updatedAt: note.updatedAt,
            })),
          })
          return
        }

        if (notes.length === 0) {
          printLine('No notes yet.')
          printLine()
          printLine('Create one with:')
          printLine(`  mnemonima new -p "${context.project.name}" --file <path>`)
          return
        }

        printTable(
          ['ID', 'REV', 'STATUS', 'TITLE'],
          notes.map((note) => [note.id, String(note.rev), note.status, truncate(note.title, 60)]),
        )
      } finally {
        context.close()
      }
    })

  program
    .command('delete')
    .summary('archive or remove a note')
    .description(
      'Archive a note, which keeps its history and takes it out of the index.\n' +
        '--hard removes the row outright and needs --yes.',
    )
    .argument('<id>', 'note id')
    .option('-p, --project <name>', 'project name')
    .option('--hard', 'delete the row instead of archiving it')
    .option('-y, --yes', 'confirm a hard delete')
    .option('--json', 'machine readable output')
    .action((id: string, options: { project?: string; hard?: boolean; yes?: boolean; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        if (options.hard === true && options.yes !== true) {
          throw new BadRequestError(`--hard permanently removes note ${id} and its chunks`, {
            details: { id },
            hint: 're-run with --yes to confirm, or drop --hard to archive it instead',
          })
        }

        const note = deleteNote(context.project.db, id, { hard: options.hard, author: AUTHOR })

        if (options.json === true) {
          printJson({ id: note.id, hard: options.hard === true })
          return
        }

        printLine(options.hard === true ? `Deleted ${note.id}` : `Archived ${note.id}`)
      } finally {
        context.close()
      }
    })

  program
    .command('history')
    .summary('show the revision log of a note')
    .description(
      'Every write records a revision with its author, which is how an agent session\n' +
        'stays reviewable (DESIGN.md 10.3).',
    )
    .argument('[id]', 'note id; omit it with --batches')
    .option('-p, --project <name>', 'project name')
    .option('--batches', 'list write batches instead of the revisions of one note')
    .option('-n, --limit <n>', 'how many batches to list', '20')
    .option('--json', 'machine readable output')
    .action((id: string | undefined, options: { project?: string; batches?: boolean; limit?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        if (options.batches === true) {
          printBatches(
            context.project.db,
            parsePositiveInt(options.limit ?? '20', '--limit'),
            options.json === true,
          )
          return
        }

        if (id === undefined) {
          throw new BadRequestError('which note?', {
            details: {},
            hint: 'pass a note id, or use --batches to list write batches',
          })
        }

        requireNote(context.project.db, id)
        const revisions = listRevisions(context.project.db, id)

        if (options.json === true) {
          printJson({ id, revisions })
          return
        }

        printTable(
          ['REV', 'OP', 'AUTHOR', 'WHEN', 'TITLE'],
          revisions.map((revision) => [
            String(revision.rev),
            revision.op,
            revision.author,
            new Date(revision.createdAt).toISOString(),
            truncate(revision.title, 40),
          ]),
        )
      } finally {
        context.close()
      }
    })

  const alias = program
    .command('alias')
    .summary('manage the extra names a note answers to')
    .description(
      'Aliases are the "additional occurrences" of a note: extra surface forms that ' +
        'search boosts and that link resolution consults before titles. They are how a ' +
        'note stays reachable under a name it no longer carries — ids are immutable, so ' +
        'this is the supported way to rename anything.',
    )

  alias
    .command('add')
    .summary('add an alias to a note')
    .argument('<id>', 'note id')
    .argument('<alias>', 'surface form, in English')
    .option('-p, --project <name>', 'project name')
    .action((id: string, value: string, options: { project?: string }) => {
      const context = openContext(options.project)
      try {
        const note = requireNote(context.project.db, id)
        assertEnglishScript(value, 'alias')
        addAlias(context.project.db, note.id, value)

        printLine(`${note.id} also answers to "${value.trim()}"`)
        printNote('run `mnemonima index` so search picks it up')
      } finally {
        context.close()
      }
    })

  alias
    .command('remove')
    .summary('remove an alias')
    .argument('<id>', 'note id')
    .argument('<alias>', 'surface form to drop')
    .option('-p, --project <name>', 'project name')
    .action((id: string, value: string, options: { project?: string }) => {
      const context = openContext(options.project)
      try {
        const removed = removeAlias(context.project.db, id, value)
        if (removed === 0) {
          throw new BadRequestError(`${id} has no alias "${value}"`, {
            details: { id, alias: value },
            hint: `run \`mnemonima alias list ${id}\` to see what it has`,
          })
        }
        printLine(`removed "${value}" from ${id}`)
      } finally {
        context.close()
      }
    })

  alias
    .command('list')
    .summary('list the aliases of a note')
    .argument('<id>', 'note id')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .action((id: string, options: { project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const note = requireNote(context.project.db, id)
        const aliases = listAliases(context.project.db, note.id)

        if (options.json === true) {
          printJson({ id: note.id, aliases })
          return
        }

        if (aliases.length === 0) {
          printLine(`${note.id} has no aliases.`)
          printNote(`add one with \`mnemonima alias add ${note.id} "<name>"\``)
          return
        }

        for (const entry of aliases) printLine(`${entry.alias}  (${entry.source})`)
      } finally {
        context.close()
      }
    })
}
