import { assertEnglishScript, lemmaKey } from '@mnemonima/core'
import {
  deleteTerm,
  listTerms,
  noteTerms,
  promotionCandidates,
  requireNote,
  requireTerm,
  setTermFlags,
  upsertTerm,
} from '@mnemonima/store'
import { Command } from 'commander'
import { openContext, parsePositiveInt } from '../context.js'
import { printJson, printLine, printNote, printTable, truncate } from '../output.js'

export function registerTermCommands(program: Command): void {
  const terms = program
    .command('terms')
    .summary('manage the vocabulary of a project')
    .description(
      'Terms come from two places. Extraction proposes them from every note, using ' +
        'YAKE inside the note, inverse document frequency across the project, and the ' +
        'distance between a candidate and the note in embedding space. You enter the ' +
        'rest by hand.\n' +
        '\n' +
        'Manual terms always win: they are matched literally in every note, they are ' +
        'never pruned by the automatic cut-offs, and they carry the higher search ' +
        'boost. Blocking a term keeps it out of every future extraction.',
    )

  terms
    .command('list')
    .summary('list the project vocabulary')
    .option('-p, --project <name>', 'project name')
    .option('-s, --source <source>', 'manual | auto | any', 'any')
    .option('--blocked', 'include terms you have ruled out')
    .option('-n, --limit <n>', 'maximum terms to print', '50')
    .option('--json', 'machine readable output')
    .action(
      (options: {
        project?: string
        source?: string
        blocked?: boolean
        limit?: string
        json?: boolean
      }) => {
        const context = openContext(options.project)
        try {
          const source = options.source ?? 'any'
          const found = listTerms(context.project.db, {
            source: source === 'manual' || source === 'auto' ? source : 'any',
            includeBlocked: options.blocked === true,
            limit: parsePositiveInt(options.limit ?? '50', '--limit'),
          })

          if (options.json === true) {
            printJson({ project: context.project.name, terms: found })
            return
          }

          if (found.length === 0) {
            printLine('No terms yet.')
            printNote('run `mnemonima index` to extract them, or add one with `terms add`')
            return
          }

          printTable(
            ['TERM', 'SOURCE', 'NOTES', 'FLAGS'],
            found.map((term) => [
              truncate(term.term, 48),
              term.source,
              String(term.df),
              [term.pinned ? 'pinned' : '', term.blocked ? 'blocked' : '']
                .filter((flag) => flag !== '')
                .join(' '),
            ]),
          )
        } finally {
          context.close()
        }
      },
    )

  terms
    .command('candidates')
    .summary('automatic terms worth promoting by hand')
    .description(
      'Terms an extractor proposed often enough across the project, and confidently ' +
        'enough on at least one note, to be worth a decision. Pin the good ones, block ' +
        'the noise. The thresholds are keywords.promoteMinDf and promoteMinScore.',
    )
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .action((options: { project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const settings = context.config.keywords
        const found = promotionCandidates(
          context.project.db,
          settings.promoteMinDf,
          settings.promoteMinScore,
        )

        if (options.json === true) {
          printJson({
            project: context.project.name,
            thresholds: { minDf: settings.promoteMinDf, minScore: settings.promoteMinScore },
            candidates: found,
          })
          return
        }

        if (found.length === 0) {
          printLine('Nothing to promote.')
          printNote(
            `thresholds: at least ${settings.promoteMinDf} notes and a score of ` +
              `${settings.promoteMinScore} — lower them with \`mnemonima config set\``,
          )
          return
        }

        printTable(
          ['TERM', 'NOTES', 'BEST'],
          found.map((entry) => [
            truncate(entry.term, 48),
            String(entry.df),
            entry.bestScore.toFixed(3),
          ]),
        )
        printLine()
        printNote('promote with `mnemonima terms pin "<term>"`, reject with `terms block`')
      } finally {
        context.close()
      }
    })

  terms
    .command('add')
    .summary('add a term by hand')
    .description(
      'A manual term joins the gazetteer: it is matched literally in every note on the ' +
        'next index run, whatever any extractor thinks of it.',
    )
    .argument('<term>', 'word or phrase, in English')
    .option('-p, --project <name>', 'project name')
    .action((term: string, options: { project?: string }) => {
      assertEnglishScript(term, 'term')
      const context = openContext(options.project)
      try {
        upsertTerm(context.project.db, {
          term: term.trim(),
          lemma: lemmaKey(term),
          source: 'manual',
        })

        printLine(`Added "${term.trim()}"`)
        printNote('run `mnemonima index` to attach it to the notes that mention it')
      } finally {
        context.close()
      }
    })

  terms
    .command('pin')
    .summary('promote a term to the manual vocabulary')
    .argument('<term>', 'term as it appears in `terms list`')
    .option('-p, --project <name>', 'project name')
    .action((term: string, options: { project?: string }) => {
      const context = openContext(options.project)
      try {
        const current = requireTerm(context.project.db, term)
        upsertTerm(context.project.db, {
          term: current.term,
          lemma: current.lemma,
          source: 'manual',
          pinned: true,
        })

        printLine(`Pinned "${current.term}"`)
        printNote('it now carries the manual boost and survives every extraction')
      } finally {
        context.close()
      }
    })

  terms
    .command('block')
    .summary('keep a term out of future extractions')
    .argument('<term>', 'term to rule out')
    .option('-p, --project <name>', 'project name')
    .action((term: string, options: { project?: string }) => {
      const context = openContext(options.project)
      try {
        const blocked = setTermFlags(context.project.db, term, { blocked: true, pinned: false })
        printLine(`Blocked "${blocked.term}"`)
        printNote('run `mnemonima index` to drop it from the notes that carry it')
      } finally {
        context.close()
      }
    })

  terms
    .command('unblock')
    .summary('allow a blocked term again')
    .argument('<term>', 'term to allow')
    .option('-p, --project <name>', 'project name')
    .action((term: string, options: { project?: string }) => {
      const context = openContext(options.project)
      try {
        const allowed = setTermFlags(context.project.db, term, { blocked: false })
        printLine(`Unblocked "${allowed.term}"`)
      } finally {
        context.close()
      }
    })

  terms
    .command('remove')
    .summary('forget a term entirely')
    .description(
      'Removes the term and its links to notes. An automatic term comes straight back ' +
        'on the next index run; block it instead if that is not what you want.',
    )
    .argument('<term>', 'term to remove')
    .option('-p, --project <name>', 'project name')
    .action((term: string, options: { project?: string }) => {
      const context = openContext(options.project)
      try {
        requireTerm(context.project.db, term)
        deleteTerm(context.project.db, term)
        printLine(`Removed "${term.trim()}"`)
      } finally {
        context.close()
      }
    })

  terms
    .command('of')
    .summary('show the terms of one note')
    .argument('<id>', 'note id')
    .option('-p, --project <name>', 'project name')
    .option('--json', 'machine readable output')
    .action((id: string, options: { project?: string; json?: boolean }) => {
      const context = openContext(options.project)
      try {
        const note = requireNote(context.project.db, id)
        const found = noteTerms(context.project.db, note.id)

        if (options.json === true) {
          printJson({ id: note.id, terms: found })
          return
        }

        if (found.length === 0) {
          printLine(`${note.id} has no terms yet.`)
          printNote('run `mnemonima index` to extract them')
          return
        }

        printTable(
          ['TERM', 'KIND', 'SOURCE', 'SCORE'],
          found.map((term) => [
            truncate(term.term, 48),
            term.kind,
            term.source,
            term.score.toFixed(3),
          ]),
        )
      } finally {
        context.close()
      }
    })
}
