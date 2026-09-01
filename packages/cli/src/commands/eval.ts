import { getActiveSpace, recordEvalRun } from '@mnemonima/store'
import { NOISY_BELOW, readQuerySet, runEval, tuneWeights } from '@mnemonima/engine'
import type { EvalReport, TuneObjective, TuneReport } from '@mnemonima/engine'
import { Command } from 'commander'
import { BadRequestError } from '@mnemonima/core'
import { openContext, openEmbedder, parsePositiveInt } from '../context.js'
import { Progress, printFields, printJson, printLine, printNote, printTable, truncate } from '../output.js'

/**
 * `mnemonima eval` — DESIGN.md 9.
 *
 * Turns "this feels better" into three numbers that disagree with each other,
 * so a change can be shown to help rather than believed to. Everything the
 * command prints is meant to be read next to a previous run, which is why every
 * run is written to the project database.
 */

const OBJECTIVES: readonly TuneObjective[] = ['ndcg', 'mrr', 'recall']

function printMetrics(report: EvalReport): void {
  printFields([
    ['queries', String(report.metrics.queries)],
    [`recall@${report.recallK}`, report.metrics.recallAtK.toFixed(3)],
    ['MRR', report.metrics.mrr.toFixed(3)],
    [`nDCG@${report.ndcgK}`, report.metrics.ndcgAtK.toFixed(3)],
    ['latency', `p50 ${Math.round(report.metrics.p50Ms)} ms, p95 ${Math.round(report.metrics.p95Ms)} ms`],
  ])
}

/** The queries that scored worst, which is where a set is worth reading. */
function printWorst(report: EvalReport, limit: number): void {
  const scored = report.outcomes
    .filter((outcome) => outcome.reciprocalRank !== null)
    .sort((a, b) => (a.reciprocalRank ?? 0) - (b.reciprocalRank ?? 0))
    .slice(0, limit)

  if (scored.length === 0) return

  printLine()
  printLine('Weakest queries:')
  printTable(
    ['QUERY', 'RR', 'FIRST HIT', 'EXPECTED'],
    scored.map((outcome) => [
      truncate(outcome.query, 44),
      (outcome.reciprocalRank ?? 0).toFixed(2),
      outcome.returned[0] ?? '—',
      outcome.relevant.join(', '),
    ]),
  )
}

export function registerEvalCommand(program: Command): void {
  program
    .command('eval')
    .summary('measure search quality against a golden set')
    .description(
      'Runs every query in the golden set and reports three numbers, because they\n' +
        'fail differently: recall says whether the answer was found at all, MRR says\n' +
        'how near the top it was, nDCG says whether the whole ordering is sensible.\n' +
        '\n' +
        'The set is a file you write. Without one, tuning weights optimises for the\n' +
        'last query you happened to look at.\n' +
        '\n' +
        'With --tune it searches the weights instead, scoring each candidate against\n' +
        'the whole set. Nothing is saved: the winning settings are printed as the\n' +
        '`config set` commands that would apply them.',
    )
    .option('-p, --project <name>', 'project name')
    .option('--tune', 'search for better weights instead of reporting the current ones')
    .option('--trials <n>', 'candidates to try with --tune', '60')
    .option('--objective <name>', 'what --tune maximises: ndcg | mrr | recall', 'ndcg')
    .option('--recall-k <n>', 'window for recall', '5')
    .option('--ndcg-k <n>', 'window for nDCG', '10')
    .option('--note <text>', 'label this run in the history')
    .option('--json', 'machine readable output')
    .addHelpText(
      'after',
      [
        '',
        'The golden set, at <project>/.mnemonima/eval/queries.yaml:',
        '  - q: "how a fragment shader runs"',
        '    relevant: [SL-0042, SL-0007]',
        '  - q: "uniform buffer layout rules"',
        '    relevant: [SL-0031]',
        '    irrelevant: [SL-0002]',
      ].join('\n'),
    )
    .action(
      async (options: {
        project?: string
        tune?: boolean
        trials: string
        objective: string
        recallK: string
        ndcgK: string
        note?: string
        json?: boolean
      }) => {
        const context = openContext(options.project)

        try {
          const set = readQuerySet(context.project.dir)
          const recallK = parsePositiveInt(options.recallK, '--recall-k')
          const ndcgK = parsePositiveInt(options.ndcgK, '--ndcg-k')

          const objective = options.objective as TuneObjective
          if (!OBJECTIVES.includes(objective)) {
            throw new BadRequestError(`unknown objective "${options.objective}"`, {
              details: { objective: options.objective },
              hint: `use one of: ${OBJECTIVES.join(', ')}`,
            })
          }

          const resolved = await openEmbedder(context, {})

          if (options.tune === true) {
            await tune(context, set, resolved, {
              trials: parsePositiveInt(options.trials, '--trials'),
              objective,
              recallK,
              ndcgK,
              json: options.json === true,
            })
            await resolved.embedder.dispose()
            return
          }

          const report = await runEval(
            context.project.db,
            context.config,
            resolved,
            set,
            context.project.name,
            { recallK, ndcgK },
          )

          await resolved.embedder.dispose()

          recordEvalRun(context.project.db, {
            spaceId: getActiveSpace(context.project.db)?.id ?? null,
            queries: report.metrics.queries,
            recallK,
            ndcgK,
            recall: report.metrics.recallAtK,
            mrr: report.metrics.mrr,
            ndcg: report.metrics.ndcgAtK,
            p50Ms: report.metrics.p50Ms,
            p95Ms: report.metrics.p95Ms,
            config: context.config.search,
            metrics: report.metrics,
            note: options.note ?? null,
          })

          if (options.json === true) {
            printJson(report)
            return
          }

          printLine(`Evaluated "${report.project}" against ${report.set}`)
          printMetrics(report)
          printWorst(report, 5)

          if (report.unknownIds.length > 0) {
            printLine()
            printNote(
              `the set expects notes that do not exist: ${report.unknownIds.join(', ')} — ` +
                'a stale id scores zero and looks exactly like a ranking problem',
            )
          }

          if (report.warning !== null) {
            printLine()
            printNote(report.warning)
          }
        } finally {
          context.close()
        }
      },
    )
}

async function tune(
  context: ReturnType<typeof openContext>,
  set: ReturnType<typeof readQuerySet>,
  resolved: Awaited<ReturnType<typeof openEmbedder>>,
  options: {
    trials: number
    objective: TuneObjective
    recallK: number
    ndcgK: number
    json: boolean
  },
): Promise<void> {
  const progress = new Progress(!options.json)

  const report = await tuneWeights(
    context.project.db,
    context.config,
    resolved,
    set,
    context.project.name,
    {
      trials: options.trials,
      objective: options.objective,
      recallK: options.recallK,
      ndcgK: options.ndcgK,
      onTrial: (done, total, best) =>
        progress.update(`trial ${done}/${total}, best ${options.objective} ${best.toFixed(3)}`),
    },
  )

  progress.done()

  if (options.json) {
    printJson(report)
    return
  }

  printTuneReport(report, options.objective)
}

function printTuneReport(report: TuneReport, objective: TuneObjective): void {
  printLine(`Tried ${report.trials} candidates, maximising ${objective}`)
  printTable(
    ['', `RECALL`, 'MRR', 'NDCG'],
    [
      [
        'current',
        report.baseline.metrics.recallAtK.toFixed(3),
        report.baseline.metrics.mrr.toFixed(3),
        report.baseline.metrics.ndcgAtK.toFixed(3),
      ],
      [
        'best',
        report.best.metrics.recallAtK.toFixed(3),
        report.best.metrics.mrr.toFixed(3),
        report.best.metrics.ndcgAtK.toFixed(3),
      ],
    ],
  )

  if (!report.improved) {
    printLine()
    printNote('nothing beat the settings you already have, which is a result too')
    return
  }

  printLine()
  printLine('Apply with:')
  for (const change of report.changes) {
    printLine(`  mnemonima config set ${change.path} ${change.to}`)
  }

  if (report.warning !== null) {
    printLine()
    printNote(report.warning)
  }

  if (report.best.metrics.queries < NOISY_BELOW) {
    printNote('write more queries before trusting this: a small set rewards luck')
  }
}
