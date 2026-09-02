import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { DaemonClient } from '@mnemonima/daemon'

/**
 * The MCP adapter — DESIGN.md 10.3.
 *
 * A thin mapping from tools onto the daemon's HTTP API. It holds no state of its
 * own beyond the batch id, because the daemon is where a project is loaded and
 * kept warm; two processes caching the same index would be one too many.
 *
 * Three properties are not negotiable, and all three are consequences of giving
 * an agent full write access:
 *
 *  - **Every write carries `author` and `batchId`.** The author says who wrote
 *    it; the batch groups one session so `mnemonima undo --batch <id>` can take
 *    the whole thing back in one command.
 *  - **The session is bound to one project.** No tool takes a project argument,
 *    so a cross-project write is not something that can be expressed.
 *  - **Destructive tools are refused unless the project allows them.** The
 *    daemon enforces it; the descriptions say so, so an agent learns the rule by
 *    reading rather than by failing.
 *
 * The descriptions are the documentation an agent gets, so they carry the rules
 * it would otherwise learn by being wrong: that a write indexes itself and
 * calling `mnemonima_index` after every note is wasted work, that most passages
 * of a long note "match" and only the scoring ones are evidence, that a dangling
 * link is data. When behaviour changes, the description is part of the change.
 *
 * Deliberately absent: the graph layout, which is where a human dragged a node
 * and says nothing about the knowledge; and the eval harness, which measures
 * retrieval for an operator tuning it rather than for an agent using it. Both
 * have routes on the daemon and neither has a tool.
 */

export interface McpOptions {
  readonly client: DaemonClient
  /** The one project this session may touch. */
  readonly project: string
  readonly batchId: string
  readonly version: string
  /** Identifies the writer in the revision log, e.g. `mcp:claude-code`. */
  readonly author: string
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/**
 * Errors reach the agent as text rather than as a transport failure, and the
 * hint comes with them — it is the part that says what to do instead.
 */
function failed(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  const hint = (error as { hint?: string }).hint

  return {
    content: [{ type: 'text', text: hint === undefined ? message : `${message}\nhint: ${hint}` }],
    isError: true,
  }
}

export function createMcpServer(options: McpOptions): McpServer {
  const { client, project, batchId, author } = options
  const base = `/projects/${encodeURIComponent(project)}`

  const server = new McpServer({ name: 'mnemonima', version: options.version })

  const tool = (
    name: string,
    config: { title: string; description: string; inputSchema?: z.ZodRawShape },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema ?? {},
      },
      (async (args: Record<string, unknown>) => {
        try {
          return ok(await handler(args ?? {}))
        } catch (error) {
          return failed(error)
        }
      }) as never,
    )
  }

  const write = (body: Record<string, unknown>): Record<string, unknown> => ({
    ...body,
    author,
    batchId,
  })

  // ---- reading -----------------------------------------------------------

  tool(
    'mnemonima_search',
    {
      title: 'Search the knowledge base',
      description:
        `Search "${project}". Modes: hybrid (default: BM25 over passages, vector ` +
        'similarity, and note metadata), semantic (vectors only, finds paraphrases that ' +
        'share no words), lexical (BM25 only, for exact terms and identifiers), exact ' +
        '(grep; /pattern/flags is a regular expression), id (direct lookup), graph (walk ' +
        'the link graph from a note). Queries must be in English. Every hit carries a ' +
        '"why" breakdown whose parts add up to the score, and two snippets of the passages ' +
        'that matched. Set expandLinks to 1 to get each hit together with its direct ' +
        'neighbours, which is cheaper than a second call. To see every passage a note ' +
        'matched, and which half of the score each came from, use mnemonima_explain.',
      inputSchema: {
        query: z.string().describe('what to search for, in English'),
        mode: z.enum(['hybrid', 'semantic', 'lexical', 'exact', 'id', 'graph']).optional(),
        limit: z.number().int().positive().optional(),
        minSimilarity: z.number().min(0).max(1).optional(),
        snippets: z.number().int().positive().optional(),
        expandLinks: z.number().int().min(0).max(1).optional(),
        from: z.string().optional().describe('origin note id for graph mode'),
        depth: z.number().int().positive().optional().describe('hops for graph mode'),
      },
    },
    (args) => client.call('POST', `${base}/search`, args),
  )

  tool(
    'mnemonima_get_note',
    {
      title: 'Read one note',
      description:
        'Return a note with its body, outgoing links, backlinks, direct neighbours and ' +
        'extracted terms.',
      inputSchema: { id: z.string().describe('note id, for example SL-0042') },
    },
    (args) => client.call('GET', `${base}/notes/${encodeURIComponent(String(args['id']))}`),
  )

  tool(
    'mnemonima_list_notes',
    {
      title: 'List notes',
      description: 'List notes in id order. Use search when you know what you are looking for.',
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    (args) => client.call('GET', `${base}/notes?limit=${String(args['limit'] ?? 50)}`),
  )

  tool(
    'mnemonima_graph',
    {
      title: 'Read the whole link graph',
      description:
        'Every note as a node with its degree, and every link as an edge. Links that point ' +
        'at an id no note has come back too, as phantom nodes on edges marked unresolved: a ' +
        'dangling link is data, not corruption, and hiding it would hide the case worth ' +
        'seeing. The "layout" field is where notes have been placed by hand on the graph ' +
        'screen; it is presentation, not knowledge, and nothing here writes to it.',
    },
    () => client.call('GET', `${base}/graph`),
  )

  tool(
    'mnemonima_explain',
    {
      title: 'Why a note came back for a query',
      description:
        'Every passage of one note that a query matched, each with the two halves of its ' +
        'score, plus the words the lexical pass looked for and which of the note’s own ' +
        'title, aliases and terms they hit. Search returns two snippets per hit; this ' +
        'returns all of them.\n' +
        '\n' +
        'Read "scoring: true" carefully — those are the passages that actually produced the ' +
        'score. Fusion reads the best chunk of each strategy and nothing else; every other ' +
        'match reaches the score through a count. Most passages of a long note come back as ' +
        'matches because a cosine sits near 0.7 even for unrelated text, so treating them ' +
        'all as evidence is the mistake this field exists to prevent.\n' +
        '\n' +
        'The vector half cannot be attributed to a word: a note can rank first sharing no ' +
        'word with the query. "words" is what BM25 looked for, not why the note won.',
      inputSchema: {
        id: z.string().describe('note id, for example SL-0042'),
        query: z.string().describe('the query to explain it against, in English'),
      },
    },
    (args) =>
      client.call(
        'GET',
        `${base}/notes/${encodeURIComponent(String(args['id']))}/explain` +
          `?q=${encodeURIComponent(String(args['query']))}`,
      ),
  )

  tool(
    'mnemonima_doctor',
    {
      title: 'Check the knowledge base for damage',
      description:
        'What is wrong with this project: links pointing at ids that do not exist, notes ' +
        'nothing links to, notes that are not in the index, notes that failed the English ' +
        'gate, duplicate aliases, and chunks with no vector. Read this after a session of ' +
        'writing to see what you left behind — a dangling link usually means a note you ' +
        'meant to create and did not.\n' +
        '\n' +
        'Reporting only. The two mechanical repairs are `mnemonima doctor --fix` on the ' +
        'command line, because deciding to change data is the operator’s.',
    },
    () => client.call('GET', `${base}/doctor`),
  )

  tool(
    'mnemonima_config',
    {
      title: 'Read the project settings',
      description:
        'Every setting this project runs with, the dotted paths they can be set by, and ' +
        'where an export would actually land. Worth reading before you assume: ' +
        'mcp.allowDestructive says whether the gated tools will work at all, index.auto and ' +
        'index.debounceSec say how long after a write a note becomes searchable, and ' +
        'export.enabled with export.path say whether files are being written and where.\n' +
        '\n' +
        'Reading only. Changing a setting is the operator’s: `mnemonima config set`.',
    },
    () => client.call('GET', `${base}/config`),
  )

  tool(
    'mnemonima_list_terms',
    {
      title: 'Read the project vocabulary',
      description:
        'The terms this project knows. Manual terms were entered by the operator and always ' +
        'win; automatic ones were extracted and can change on the next index run. Pass a ' +
        'note id to get the terms of that note instead.',
      inputSchema: {
        note: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    (args) =>
      client.call(
        'GET',
        args['note'] === undefined
          ? `${base}/terms?limit=${String(args['limit'] ?? 100)}`
          : `${base}/terms?note=${encodeURIComponent(String(args['note']))}`,
      ),
  )

  tool(
    'mnemonima_history',
    {
      title: 'Read the revision log',
      description:
        'What changed, when, and who changed it. With a note id: that note\'s revisions, ' +
        'newest first. Without one: the write batches, so a session can be found before it ' +
        'is undone. Pass a revision to read the body as it was then, or two to see what ' +
        'changed between them — reading never restores, mnemonima_undo is what puts a note ' +
        'back. Revision 0 means the note as it stands, so from alone compares that revision ' +
        'with the note now, and neither from nor to shows the last edit.',
      inputSchema: {
        id: z.string().optional(),
        rev: z.number().int().nonnegative().optional(),
        from: z.number().int().nonnegative().optional(),
        to: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    (args) => {
      const id = args['id'] as string | undefined
      const from = args['from'] as number | undefined
      const to = args['to'] as number | undefined
      const rev = args['rev'] as number | undefined

      if (id === undefined) {
        return client.call('GET', `${base}/batches?limit=${args['limit'] ?? 20}`)
      }

      if (from !== undefined || to !== undefined) {
        const query = new URLSearchParams()
        if (from !== undefined) query.set('from', String(from))
        if (to !== undefined) query.set('to', String(to))

        return client.call('GET', `${base}/notes/${encodeURIComponent(id)}/diff?${query}`)
      }

      if (rev !== undefined) {
        return client.call('GET', `${base}/notes/${encodeURIComponent(id)}/revisions/${rev}`)
      }

      return client.call('GET', `${base}/notes/${encodeURIComponent(id)}/revisions`)
    },
  )

  // ---- writing -----------------------------------------------------------

  tool(
    'mnemonima_create_note',
    {
      title: 'Create a note',
      description:
        'Write a new note. The body is markdown and must be in English; a non-English body ' +
        'is refused rather than indexed badly. The title comes from the first level-one ' +
        'heading unless you pass one. Link to other notes with [[SL-0042]] in the body. ' +
        `Recorded under batch ${batchId}, so everything this session writes can be taken ` +
        'back with one command. Indexing and export follow on their own once the writing ' +
        'stops; call mnemonima_index only when you need it searchable immediately.',
      inputSchema: {
        body: z.string().describe('markdown body, in English'),
        title: z.string().optional(),
        id: z.string().optional().describe('use a specific id instead of the next one'),
      },
    },
    (args) => client.call('POST', `${base}/notes`, write(args)),
  )

  tool(
    'mnemonima_update_note',
    {
      title: 'Update a note',
      description:
        'Replace the body, the title, or the tags of a note. Omit the body to change only ' +
        'the title. Pass expectedRev to fail rather than overwrite if the note moved since ' +
        'you read it.',
      inputSchema: {
        id: z.string(),
        body: z.string().optional(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        expectedRev: z.number().int().positive().optional(),
      },
    },
    (args) =>
      client.call('PUT', `${base}/notes/${encodeURIComponent(String(args['id']))}`, write(args)),
  )

  tool(
    'mnemonima_archive_note',
    {
      title: 'Archive a note',
      description:
        'Take a note out of the index and out of search while keeping it and its history. ' +
        'This is the reversible way to remove something; prefer it.',
      inputSchema: { id: z.string() },
    },
    (args) =>
      client.call(
        'DELETE',
        `${base}/notes/${encodeURIComponent(String(args['id']))}`,
        write({ hard: false }),
      ),
  )

  tool(
    'mnemonima_delete_note',
    {
      title: 'Delete a note outright',
      description:
        'Remove a note permanently. Destructive: refused unless mcp.allowDestructive is on ' +
        'for this project. Archiving is almost always what you want instead.',
      inputSchema: { id: z.string() },
    },
    (args) =>
      client.call(
        'DELETE',
        `${base}/notes/${encodeURIComponent(String(args['id']))}`,
        write({ hard: true }),
      ),
  )

  tool(
    'mnemonima_link',
    {
      title: 'Link one note to another',
      description:
        'Add a link by appending it to a "## Related" section in the source note. The ' +
        'backlink on the target appears on its own; the target is not modified. The anchor ' +
        'is display text and is also a strong keyword signal for the target.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        anchor: z.string().optional(),
      },
    },
    (args) => client.call('POST', `${base}/links`, write(args)),
  )

  tool(
    'mnemonima_unlink',
    {
      title: 'Remove a link',
      description:
        'Remove a link from the "## Related" section of the source note. A link written into ' +
        'the prose is left alone, because cutting it out would change the meaning of a ' +
        'sentence; edit the body yourself for that.',
      inputSchema: { from: z.string(), to: z.string() },
    },
    (args) => client.call('POST', `${base}/unlink`, write(args)),
  )

  tool(
    'mnemonima_add_alias',
    {
      title: 'Give a note another name',
      description:
        'Aliases are extra surface forms a note answers to. They are searched with their own ' +
        'boost and consulted when resolving links, which is how a note stays reachable under ' +
        'a name it no longer carries — note ids are immutable, so this is the supported way ' +
        'to rename anything.',
      inputSchema: { id: z.string(), alias: z.string(), remove: z.boolean().optional() },
    },
    (args) => client.call('POST', `${base}/aliases`, write(args)),
  )

  tool(
    'mnemonima_add_term',
    {
      title: 'Add a term to the vocabulary',
      description:
        'A manual term is matched literally in every note on the next index run, whatever ' +
        'the extractor thinks of it, and carries the higher search boost.',
      inputSchema: { term: z.string() },
    },
    (args) => client.call('POST', `${base}/terms`, write({ ...args, action: 'add' })),
  )

  tool(
    'mnemonima_block_term',
    {
      title: 'Keep a term out of the vocabulary',
      description:
        'Block a term so no future extraction proposes it. This is the reversible way to get ' +
        'rid of a term; use it rather than removing one.',
      inputSchema: { term: z.string(), unblock: z.boolean().optional() },
    },
    (args) =>
      client.call(
        'POST',
        `${base}/terms`,
        write({ term: args['term'], action: args['unblock'] === true ? 'unblock' : 'block' }),
      ),
  )

  tool(
    'mnemonima_remove_term',
    {
      title: 'Forget a term entirely',
      description:
        'Delete a term and its links to notes. Destructive: refused unless ' +
        'mcp.allowDestructive is on. An automatic term comes straight back on the next index ' +
        'run, so block it instead unless you mean it.',
      inputSchema: { term: z.string() },
    },
    (args) => client.call('POST', `${base}/terms`, write({ ...args, action: 'remove' })),
  )

  tool(
    'mnemonima_undo',
    {
      title: 'Undo writes',
      description:
        'Take back everything a session wrote. With no arguments this undoes the current ' +
        `session, batch ${batchId}; find another one with mnemonima_history. Pass a note id ` +
        'together with a revision to put just that ' +
        'note back instead. Nothing is destroyed: an undo is itself a revision, and a note ' +
        'the batch created is archived rather than deleted.',
      inputSchema: {
        batchId: z.string().optional(),
        id: z.string().optional(),
        rev: z.number().int().positive().optional(),
      },
    },
    (args) =>
      client.call(
        'POST',
        `${base}/undo`,
        write({ batchId: args['batchId'] ?? batchId, id: args['id'], rev: args['rev'] }),
      ),
  )

  // ---- administration ----------------------------------------------------

  tool(
    'mnemonima_index',
    {
      title: 'Rebuild the search index',
      description:
        'Chunk and embed everything that changed. **You usually do not need this.** Every ' +
        'write through these tools schedules an index of its own, which runs once the ' +
        'writing stops (index.auto, thirty seconds by default), so a note becomes searchable ' +
        'without being told to. Call this when you want that now rather than in half a ' +
        'minute — searching for something you just wrote is the case. Cheap to repeat: only ' +
        'chunks whose text changed are re-embedded. Rebuilding with a different model is ' +
        'destructive and is gated.',
      inputSchema: {
        full: z.boolean().optional(),
        model: z.string().optional(),
      },
    },
    (args) => client.call('POST', `${base}/index`, args),
  )

  tool(
    'mnemonima_export',
    {
      title: 'Export the notes as markdown',
      description:
        'Write every note out as a markdown file and commit it, if the export directory is a ' +
        'git repository. Also automatic after a write, so this is for doing it now. The ' +
        'directory has to exist already — we keep a vault up to date, we do not conjure one ' +
        'because a note was written — and the export does nothing at all when it is missing. ' +
        'Read export.path with mnemonima_config to see where that is. Pushing is never ' +
        'automatic and is not offered here.',
    },
    () => client.call('POST', `${base}/export`, {}),
  )

  tool(
    'mnemonima_status',
    {
      title: 'Engine status',
      description:
        'What the daemon is holding in memory, and the batch id of this session — which is ' +
        'what an operator needs in order to undo it.',
    },
    async () => {
      const status = await client.call<Record<string, unknown>>('GET', '/status')
      return { project, batchId, author, ...status }
    },
  )

  return server
}
