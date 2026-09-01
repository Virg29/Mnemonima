import { api } from '../api.js'
import type { EvalReport, EvalRunRow, TuneReport } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { clear, el, empty, table, when } from '../dom.js'

/**
 * The eval screen — DESIGN.md 13.7.
 *
 * The one screen that answers "did that change help" rather than "how is it
 * now", which is why the history is as prominent as the run button: a metric
 * without the previous one beside it is a number nobody can act on.
 *
 * Tuning is offered but its result is never applied here. It searches weights
 * against the same queries it is scored on, so a win on a small set is as
 * likely to be luck as improvement; the screen prints the settings and leaves
 * the decision where it belongs.
 */
export function evalScreen(): Screen {
  return {
    id: 'eval',
    title: 'Eval',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      const view = await api.evalHistory(surface.project)
      const results = el('div')
      const historyHost = el('div')

      const run = async (tune: boolean): Promise<void> => {
        clear(results)
        results.append(
          el('p', {
            class: 'hint',
            text: tune
              ? 'searching the weights — every candidate runs the whole set…'
              : 'running the set…',
          }),
        )

        try {
          const report = await api.runEval(surface.project, tune ? { tune: true, trials: 40 } : {})
          clear(results)
          results.append(
            report.tuned ? tuneCard(report as TuneReport) : reportCard(report as EvalReport),
          )

          // The history is refreshed rather than the screen re-rendered: a
          // reload would discard the card that was the point of pressing Run.
          if (!report.tuned) {
            const fresh = await api.evalHistory(surface.project)
            clear(historyHost)
            historyHost.append(history(fresh.history))
          }
        } catch (error) {
          clear(results)
          surface.fail(error)
        }
      }

      surface.bar.append(
        el('strong', { text: 'Eval' }),
        el('span', {
          class: 'hint',
          text: view.exists ? `${view.queries} queries` : 'no golden set yet',
        }),
        el('span', { class: 'grow' }),
        el('button', {
          class: 'primary',
          text: 'Run',
          disabled: !view.exists,
          onclick: () => void run(false),
        }),
        el('button', {
          text: 'Tune weights',
          disabled: !view.exists,
          title: 'Searches for better weights. Nothing is saved.',
          onclick: () => void run(true),
        }),
      )

      if (!view.exists) {
        surface.body.append(
          empty(
            'This project has no golden set.',
            `Write one at ${view.set}: a list of questions with the note ids that answer each.`,
          ),
          el('pre', {}, [
            el('code', {
              text: [
                '- q: "how a fragment shader runs"',
                '  relevant: [SL-0042, SL-0007]',
                '',
                '- q: "uniform buffer layout rules"',
                '  relevant: [SL-0031]',
                '  irrelevant: [SL-0002]',
              ].join('\n'),
            }),
          ]),
        )
        return
      }

      if (view.queries < 20) {
        surface.body.append(
          el('p', {
            class: 'hint warn',
            text:
              `${view.queries} queries is a small set: the numbers move more with the set than ` +
              'with the engine, so treat a difference as a hint rather than a result.',
          }),
        )
      }

      historyHost.append(history(view.history))
      surface.body.append(results, historyHost)
    },
  }
}

function metric(label: string, value: string): HTMLElement {
  return el('div', { class: 'metric' }, [
    el('span', { class: 'metric-value', text: value }),
    el('span', { class: 'hint', text: label }),
  ])
}

function reportCard(report: EvalReport): HTMLElement {
  return el('div', { class: 'card' }, [
    el('h2', { text: 'This run' }),
    el('div', { class: 'metrics' }, [
      metric(`recall@${report.recallK}`, report.metrics.recallAtK.toFixed(3)),
      metric('MRR', report.metrics.mrr.toFixed(3)),
      metric(`nDCG@${report.ndcgK}`, report.metrics.ndcgAtK.toFixed(3)),
      metric('p50', `${Math.round(report.metrics.p50Ms)} ms`),
      metric('p95', `${Math.round(report.metrics.p95Ms)} ms`),
    ]),
    ...(report.unknownIds.length > 0
      ? [
          el('p', {
            class: 'hint warn',
            text:
              `the set expects notes that do not exist: ${report.unknownIds.join(', ')} — ` +
              'a stale id scores zero and looks exactly like a ranking problem',
          }),
        ]
      : []),
    el('h2', { text: 'Weakest queries' }),
    el('p', {
      class: 'hint',
      text: 'Where the set is worth reading: either the engine is wrong, or the answer marked is.',
    }),
    table(
      ['query', 'RR', 'first hit', 'expected'],
      [...report.outcomes]
        .sort((a, b) => (a.reciprocalRank ?? 0) - (b.reciprocalRank ?? 0))
        .slice(0, 8)
        .map((outcome) => [
          outcome.query,
          (outcome.reciprocalRank ?? 0).toFixed(2),
          el('span', { class: 'id', text: outcome.returned[0] ?? '—' }),
          el('span', { class: 'id', text: outcome.relevant.join(', ') }),
        ]),
    ),
  ])
}

function tuneCard(report: TuneReport): HTMLElement {
  const commands = report.changes
    .map((change) => `mnemonima config set ${change.path} ${change.to}`)
    .join('\n')

  const holdout = report.holdout

  return el('div', { class: 'card' }, [
    el('h2', { text: `Tuned over ${report.trials} candidates` }),

    el('h2', { text: `Scored against (${report.baseline.metrics.queries} queries)` }),
    el('p', { class: 'hint', text: 'Flattering by construction: this is what it optimised.' }),
    el('div', { class: 'metrics' }, [
      metric('nDCG before', report.baseline.metrics.ndcgAtK.toFixed(3)),
      metric('after', report.best.metrics.ndcgAtK.toFixed(3)),
      metric('MRR before', report.baseline.metrics.mrr.toFixed(3)),
      metric('after', report.best.metrics.mrr.toFixed(3)),
    ]),

    ...(holdout === null
      ? [
          el('p', {
            class: 'hint warn',
            text: 'No holdout was kept, so the numbers above are not evidence of anything.',
          }),
        ]
      : [
          el('h2', { text: `Held back (${holdout.queries} queries)` }),
          el('p', { class: 'hint', text: 'Never seen by the search. Only this pair is evidence.' }),
          el('div', { class: 'metrics' }, [
            metric('nDCG before', holdout.baseline.ndcgAtK.toFixed(3)),
            metric('after', holdout.best.ndcgAtK.toFixed(3)),
            metric('MRR before', holdout.baseline.mrr.toFixed(3)),
            metric('after', holdout.best.mrr.toFixed(3)),
          ]),
        ]),

    ...(report.improved
      ? [
          el('p', {
            class: 'hint',
            text: 'The win survived the queries held back. Nothing has been saved:',
          }),
          el('pre', {}, [el('code', { text: commands })]),
        ]
      : [
          el('p', {
            class: 'hint ok',
            text:
              holdout === null
                ? 'Nothing beat the settings you already have, which is a result too.'
                : 'The winning weights did not beat the current ones on the queries held back: ' +
                  'the gain above was the search fitting the half it was scored on.',
          }),
        ]),
    ...(report.warning === null ? [] : [el('p', { class: 'hint warn', text: report.warning })]),
  ])
}

function history(runs: readonly EvalRunRow[]): HTMLElement {
  if (runs.length === 0) {
    return el('div', {}, [
      el('h2', { text: 'History' }),
      empty('No runs recorded yet.', 'Every run is stored, so the next one has something to beat.'),
    ])
  }

  // Oldest to newest for the delta, newest first for the table.
  const deltas = new Map<number, number>()
  for (let index = 0; index < runs.length - 1; index += 1) {
    const current = runs[index]
    const previous = runs[index + 1]
    if (current !== undefined && previous !== undefined) {
      deltas.set(current.id, current.ndcg - previous.ndcg)
    }
  }

  return el('div', {}, [
    el('h2', { text: 'History' }),
    el('p', { class: 'hint', text: 'Each run keeps the weights it was measured with.' }),
    table(
      ['when', 'queries', 'recall', 'MRR', 'nDCG', 'Δ nDCG', 'p50', 'note'],
      runs.map((row) => {
        const delta = deltas.get(row.id)

        return [
          when(row.createdAt),
          String(row.queries),
          row.recall.toFixed(3),
          row.mrr.toFixed(3),
          row.ndcg.toFixed(3),
          delta === undefined
            ? '—'
            : el('span', {
                class: delta > 0 ? 'ok' : delta < 0 ? 'bad' : 'hint',
                text: `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`,
              }),
          `${row.p50Ms} ms`,
          row.note ?? '',
        ]
      }),
    ),
  ])
}
