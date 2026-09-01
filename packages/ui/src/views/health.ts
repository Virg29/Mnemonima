import { api } from '../api.js'
import type { Screen, Surface } from '../app.js'
import { el, empty, table, when } from '../dom.js'

/**
 * The `doctor` report and the revision log.
 *
 * Everything `doctor` finds is shown, but the wording keeps the distinction the
 * report itself makes: a dangling link and a missing attachment are information
 * — the operator referenced something for a reason (DESIGN.md 3.4) — while a
 * counter that fell behind is a defect with a repair.
 *
 * The batch list is here rather than under notes because that is what makes an
 * agent session reviewable: one row per session, with the author who wrote it.
 */
export function healthScreen(): Screen {
  return {
    id: 'health',
    title: 'Health',
    needsProject: true,

    async render(surface: Surface): Promise<void> {
      surface.bar.append(
        el('strong', { text: 'Health' }),
        el('span', { class: 'grow' }),
        el('button', { text: 'Refresh', onclick: () => surface.reload() }),
      )

      const [report, batches] = await Promise.all([
        api.doctor(surface.project),
        api.batches(surface.project),
      ])

      const repairable = report.idCounterBehind !== null

      surface.body.append(
        el('div', { class: 'card' }, [
          el('h2', { text: 'Summary' }),
          el('dl', { class: 'fields' }, [
            el('dt', { text: 'notes' }),
            el('dd', { text: String(report.notes) }),
            el('dt', { text: 'links' }),
            el('dd', { text: String(report.links) }),
            el('dt', { text: 'active space' }),
            el('dd', { text: report.activeSpace ?? 'none — run an index' }),
            el('dt', { text: 'chunks without vectors' }),
            el('dd', {
              class: report.chunksWithoutVectors > 0 ? 'warn' : 'ok',
              text: String(report.chunksWithoutVectors),
            }),
          ]),
          ...(repairable
            ? [
                el('p', {}, [
                  el('button', {
                    class: 'primary',
                    text: 'Repair',
                    onclick: async () => {
                      await api.repair(surface.project)
                      surface.reload()
                    },
                  }),
                ]),
              ]
            : []),
        ]),
      )

      section(
        surface,
        'Dangling links',
        'Information, not corruption: a link to an id that does not exist is kept as written.',
        report.dangling.map((link) => `${link.src} → ${link.target}`),
      )

      section(
        surface,
        'Orphans',
        'Active notes with no resolved link in either direction.',
        report.orphans,
      )

      section(
        surface,
        'Not indexed',
        'Stored but absent from the active space. An index run fixes it.',
        report.unindexed,
      )

      section(
        surface,
        'Not English',
        'Kept, but never indexed, because they did not pass the language gate.',
        report.nonEnglish,
      )

      section(
        surface,
        'Missing attachments',
        'Paths in a body that do not exist on disk. We store paths, never files.',
        report.missingAttachments.map((entry) => `${entry.noteId}: ${entry.target}`),
      )

      section(
        surface,
        'Duplicate aliases',
        'One alias answering for more than one note makes resolution arbitrary.',
        report.duplicateAliases.map((entry) => `${entry.alias} → ${entry.notes.join(', ')}`),
      )

      surface.body.append(el('h2', { text: 'Write batches' }))
      surface.body.append(
        batches.batches.length === 0
          ? empty(
              'No batched writes recorded.',
              'Agent sessions over MCP and imports are what create them.',
            )
          : table(
              ['batch', 'author', 'notes', 'writes', 'ended'],
              batches.batches.map((batch) => [
                el('span', { class: 'id', text: batch.batchId }),
                batch.author,
                String(batch.notes),
                String(batch.revisions),
                when(batch.endedAt),
              ]),
            ),
      )
    },
  }
}

function section(surface: Surface, title: string, hint: string, items: string[]): void {
  surface.body.append(el('h2', { text: `${title} (${items.length})` }))

  if (items.length === 0) {
    surface.body.append(el('p', { class: 'hint ok', text: 'None.' }))
    return
  }

  surface.body.append(
    el('p', { class: 'hint', text: hint }),
    el(
      'ul',
      {},
      items.map((item) => el('li', { class: 'id', text: item })),
    ),
  )
}
