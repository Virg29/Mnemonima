# mnemonima

Local hybrid search over a graph of markdown notes, built for AI agents.

> **Status: early development.** Not published to npm yet. The design document
> (`DESIGN.md`) is the authoritative specification.

## What it is

A local search engine over a personal knowledge base stored as a graph of
markdown notes. SQLite is the source of truth; Orama is the in-memory search
layer; embeddings are computed locally on CPU with `gte-small`.

Four faces of one core:

| Face | Audience | Form |
| --- | --- | --- |
| CLI | humans, scripts | `mnemonima find -p "project" -q "shaders introducing"` |
| MCP | AI agents | stdio server: read, write, administration |
| HTTP API | UI, integrations | local daemon on `127.0.0.1` |
| Web UI | humans | graph, editor, search lab |

**All content is English only.** Notes, queries, keywords and logs are gated at
write time; non-English input is rejected rather than silently indexed.

## Requirements

- Node.js >= 20
- pnpm >= 10

## Development

```
pnpm install
pnpm build
pnpm test
```

Link the CLI locally:

```
pnpm --filter mnemonima link --global
```

## Quick start

```bash
mnemonima project add "Shader Lab" --dir ./shaders   # create the project database
mnemonima new --file notes/shaders.md                # add a note
mnemonima index                                      # chunk and embed it
mnemonima find -q "how a fragment shader runs"       # search
```

Weights for the default model (`Supabase/gte-small`, ~34 MB) are downloaded on
first use. `mnemonima models pull Supabase/gte-small` fetches them ahead of time.

## Current commands

```
project add|list|remove          register projects
new | edit | get | list          author and read notes
delete | history                 archive notes, inspect the revision log
index                            build or refresh the embedding index
find -q "<query>"                search: hybrid, semantic, lexical, exact, id, graph
link | unlink | links            create, remove and inspect links
neighbours | alias               graph neighbours, extra names for a note
terms                            the project vocabulary
export | import                  the markdown bridge, with git
doctor                           check project integrity
daemon status|start|stop         the background server and what it holds
revert | undo                    put a note back, or take back a whole session
mcp                              serve this project to an agent over MCP
models list|pull                 inspect and download embedding models
config show|get|set              project settings
```

`mnemonima help <command>` documents each one. When exactly one project is
registered, `-p` can be omitted; `MNEMONIMA_PROJECT` sets the default.

## How it works

Notes are parsed to markdown AST, cut twice — paragraph level and section level —
and each chunk is embedded with the heading breadcrumb prepended. The embedding
cache is keyed by the hash of a chunk's text, so editing one paragraph re-embeds
one or two chunks rather than the note. Changing the model or the chunking
settings defines a separate embedding space beside the current one, so switching
back is instant.

Search runs BM25 and cosine over the chunks, plus BM25 over note metadata, and
fuses everything to note level: a note where several passages match outranks one
where a single passage does, and a match on the title or an alias counts too.
Orama does the retrieval; the fusion is ours, so every hit carries a `why`
breakdown whose parts add up to the score exactly.

Modes:

```
hybrid    BM25 over passages, cosine over vectors, plus note metadata
semantic  vectors only - finds paraphrases that share no words
lexical   BM25 only - exact terms, API names, identifiers
exact     grep over note bodies; /pattern/flags is a regular expression
id        direct lookup of one note id
graph     walk the link graph outwards from one note
```

Notes form a graph. Links are written in the body as `[[SL-0042]]` or
`[[SL-0042|shader basics]]`; backlinks are derived, so linking A to B never
touches B. A link to an id that does not exist is kept as written - `doctor`
reports it rather than removing it. Notes whose neighbours also matched are
boosted, and a note several results point at is pulled in with `via` explaining
why. `--expand-links 1` returns the neighbours of every hit, which gives an agent
a connected subgraph in one call.

A background daemon keeps one or two projects in memory and answers searches
from there: 309 ms in process against 20 ms warm, measured on 400 notes. It
starts on its own when a search would benefit and stops when it has been idle.
`mnemonima daemon status` shows what it is holding.

`lexical`, `exact` and `id` never load the model, so they answer in a few
milliseconds. The hybrid balance is tunable per query with
`--weights text=0.3,vector=0.7`, or persistently with
`mnemonima config set search.hybridWeights.text 0.3`.

## Exit codes

Part of the public contract. Diagnostics always go to stderr; with `--json`,
stdout carries JSON and nothing else.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | not found |
| 2 | bad request (invalid arguments, conflicting state) |
| 3 | language gate: input is not English |
| 4 | daemon unavailable |
| 70 | unexpected internal failure |

## Layout

```
packages/
  core/     pure logic: ids, hashing, vectors, language gate, markdown, chunking,
            configuration, the embedding model registry
  store/    SQLite schema, migrations, repositories, project registry
  engine/   orchestration: indexing, the Orama indexes, search
  cli/      command line client
```

`daemon/`, `mcp/` and `ui/` arrive in their respective milestones — see
`DESIGN.md` section 15.

## License

MIT
