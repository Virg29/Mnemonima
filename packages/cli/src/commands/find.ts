import { BadRequestError } from '@mnemonima/core'
import { IMPLEMENTED_MODES, searchNotes } from '@mnemonima/engine'
import type { SearchMode, SearchResult, SearchWeights } from '@mnemonima/engine'
import { Command } from 'commander'
import { openContext, openEmbedder, parsePositiveInt, parseUnitInterval } from '../context.js'
import { connectDaemon } from '../daemon-link.js'
import { printJson, printLine, printNote, printWarning, truncate } from '../output.js'

const ALL_MODES: readonly SearchMode[] = ['hybrid', 'semantic', 'lexical', 'exact', 'id', 'graph']

/** Parses `text=0.3,vector=0.7`. */
function parseWeights(raw: string): Partial<SearchWeights> {
  const out: Record<string, number> = {}

  for (const pair of raw.split(',')) {
    const [key, value] = pair.split('=')
    const name = (key ?? '').trim()

    if (name !== 'text' && name !== 'vector') {
      throw new BadRequestError(`unknown weight "${name}" in --weights`, {
        details: { raw, name },
        hint: 'the only weights are text and vector, for example --weights text=0.3,vector=0.7',
      })
    }

    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestError(`--weights ${name} must be a non-negative number, got "${value}"`, {
        details: { raw, name, value },
        hint: 'weights are relative, so text=1,vector=3 and text=0.25,vector=0.75 behave alike',
      })
    }

    out[name] = parsed
  }

  return out
}

function parseMode(raw: string): SearchMode {
  if ((ALL_MODES as readonly string[]).includes(raw)) return raw as SearchMode

  throw new BadRequestError(`unknown search mode "${raw}"`, {
    details: { mode: raw, available: IMPLEMENTED_MODES },
    hint: `available modes: ${IMPLEMENTED_MODES.join(', ')}`,
  })
}

interface FindOptions {
  query: string
  project?: string
  mode?: string
  from?: string
  depth?: string
  expandLinks?: string
  model?: string
  weights?: string
  limit?: string
  minSimilarity?: string
  snippets?: string
  json?: boolean
  why?: boolean
  daemon?: boolean
}

export function registerFindCommand(program: Command): void {
  program
    .command('find')
    .summary('search the notes of a project')
    .description(
      'Search the active index. Results are fused to note level: a note where several\n' +
        'passages match outranks one where a single passage does, both chunking\n' +
        'strategies contribute, a match on the title or an alias counts, and a note\n' +
        'whose neighbours also matched is boosted.\n' +
        '\n' +
        'Queries must be English. Every hit carries a `why` breakdown, so a ranking you\n' +
        'disagree with can be explained rather than guessed at.\n' +
        '\n' +
        'Modes:\n' +
        '  hybrid    BM25 over passages, cosine over vectors, plus note metadata\n' +
        '  semantic  vectors only — finds paraphrases that share no words\n' +
        '  lexical   BM25 only — exact terms, API names, identifiers\n' +
        '  exact     grep over note bodies; /pattern/flags is a regular expression\n' +
        '  id        direct lookup of one note id\n' +
        '  graph     walk the link graph outwards from one note',
    )
    // Accepted either way: `find "shaders"` is what everyone reaches for first,
    // and an agent that guessed the positional form should not be corrected by
    // an error when the meaning was never ambiguous.
    .argument('[query]', 'what to search for, in English; the same as --query')
    .option('-q, --query <text>', 'what to search for, in English')
    .option('-p, --project <name>', 'project name')
    .option('--mode <mode>', 'hybrid | semantic | lexical | exact | id | graph')
    .option('--from <id>', 'origin note for --mode graph; defaults to the query')
    .option('--depth <n>', 'hops to walk in --mode graph', '1')
    .option('-x, --expand-links <n>', 'attach direct neighbours to every hit')
    .option('-m, --model <id>', 'query with this model instead of the configured one')
    .option('-w, --weights <pairs>', 'override the hybrid balance, e.g. text=0.3,vector=0.7')
    .option('-n, --limit <n>', 'number of notes to return')
    .option('--min-similarity <value>', 'discard chunks scoring below this (0..1)')
    .option('--snippets <n>', 'passages to show per note', '2')
    .option('--json', 'machine readable output')
    .option('--why', 'show the score breakdown in text output')
    .option('--no-daemon', 'answer in this process instead of asking the daemon')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  mnemonima find -q "how a fragment shader runs"',
        '  mnemonima find -q "uniform buffers" --mode lexical --why',
        '  mnemonima find -q "growing vegetables" --mode semantic',
        '  mnemonima find -q "/gl_Frag\\w+/" --mode exact',
        '  mnemonima find -q "shaders" --expand-links 1 --json',
        '  mnemonima find -q SL-0042 --mode graph --depth 2',
        '',
        'Exit codes: 1 nothing found, 2 bad request, 3 the query is not English.',
      ].join('\n'),
    )
    .action(async (positional: string | undefined, options: FindOptions) => {
      const query = options.query ?? positional

      if (query === undefined || query.trim() === '') {
        throw new BadRequestError('nothing to search for', {
          details: { mode: options.mode ?? null },
          hint: 'pass the query: `mnemonima find "how a fragment shader runs"`',
        })
      }

      const mode = options.mode === undefined ? undefined : parseMode(options.mode)
      const weights = options.weights === undefined ? undefined : parseWeights(options.weights)

      const context = openContext(options.project)

      try {
        const request = {
          query,
          mode,
          weights,
          limit:
            options.limit === undefined ? undefined : parsePositiveInt(options.limit, '--limit'),
          minSimilarity:
            options.minSimilarity === undefined
              ? undefined
              : parseUnitInterval(options.minSimilarity, '--min-similarity'),
          snippets: parsePositiveInt(options.snippets ?? '2', '--snippets'),
          from: options.from,
          depth: parsePositiveInt(options.depth ?? '1', '--depth'),
          expandLinks:
            options.expandLinks === undefined
              ? undefined
              : parsePositiveInt(options.expandLinks, '--expand-links'),
        }

        // The daemon already holds the index; this process would rebuild it.
        // Falling back is always allowed: a search must not fail because a
        // background service would not start.
        const client =
          options.daemon === false || !context.config.daemon.autoStart
            ? null
            : await connectDaemon({ autoStart: true, quiet: options.json === true })

        if (client !== null) {
          render((await client.search(context.project.name, request)) as SearchResult, options)
          return
        }

        // Only the two vector modes pay for loading onnxruntime.
        const needsEmbedder = mode === undefined || mode === 'hybrid' || mode === 'semantic'
        const resolved = needsEmbedder ? await openEmbedder(context, { model: options.model }) : null

        const result = await searchNotes(
          context.project.db,
          context.config,
          resolved,
          query,
          {
            mode: request.mode,
            weights: request.weights,
            limit: request.limit,
            minSimilarity: request.minSimilarity,
            snippetsPerNote: request.snippets,
            from: request.from,
            depth: request.depth,
            expandLinks: request.expandLinks,
          },
        )

        await resolved?.embedder.dispose()
        render(result, options)
      } finally {
        context.close()
      }
    })
}

/** One renderer, so a result reads identically whichever path produced it. */
function render(result: SearchResult, options: FindOptions): void {
  if (result.warning !== null) printWarning(result.warning.message)

  if (options.json === true) {
    printJson(result)
    return
  }

  if (result.hits.length === 0) {
    printLine(`No matches for "${result.query}".`)
    printNote(
      'try a longer phrase, another --mode, a lower --min-similarity, ' +
        'or check that `mnemonima index` has run',
    )
    process.exitCode = 1
    return
  }

  for (const hit of result.hits) {
    printLine(`${hit.id}  ${hit.title}  (${hit.score.toFixed(3)})`)

    if (hit.via !== null && hit.via.length > 0) printLine(`  via ${hit.via.join(', ')}`)

    if (options.why === true) {
      printLine(
        `  why: text ${hit.why.text.toFixed(3)}, vector ${hit.why.vector.toFixed(3)}, ` +
          `meta ${hit.why.meta.toFixed(3)}, graph ${hit.why.graph.toFixed(3)}, ` +
          `multi-chunk ${hit.why.multiChunk.toFixed(3)}` +
          (hit.why.matchedChunks > 0
            ? ` — ${hit.why.matchedChunks} chunk(s), best cut "${hit.why.bestStrategy}"`
            : ' — no passage matched'),
      )
    }

    if (hit.neighbours !== null && hit.neighbours.length > 0) {
      printLine(
        `  neighbours: ${hit.neighbours.map((entry) => `${entry.id} (${entry.relation})`).join(', ')}`,
      )
    }

    for (const snippet of hit.snippets) {
      const where = snippet.headingPath ?? '(top level)'
      printLine(`  ${where} [${snippet.strategy} ${snippet.score.toFixed(3)}]`)
      printLine(`    ${truncate(snippet.text, 160)}`)
    }

    printLine()
  }

  const balance =
    result.mode === 'hybrid'
      ? `, weights text=${result.weights.text} vector=${result.weights.vector}`
      : ''

  printNote(
    `${result.hits.length} note(s) from ${result.candidates} candidate(s) ` +
      `in ${result.tookMs} ms, mode ${result.mode}${balance}`,
  )
}
