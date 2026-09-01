# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Breaking changes to the public contract (CLI flags, `find` JSON schema, MCP tool
signatures, exported frontmatter schema) are recorded here even before the first
public release.

## [Unreleased]

### Added

- Workspace skeleton: pnpm monorepo, TypeScript, tsup, vitest.
- `@mnemonima/core`: shared types, note id derivation, project configuration
  defaults, error taxonomy with CLI exit codes, English script gate (layer 1).
- `@mnemonima/store`: SQLite schema (notes, aliases, tags, links, terms,
  note_terms, spaces, chunks, embeddings, note_revisions, orama_snapshots),
  forward-only migration runner, project registry.
- `mnemonima` CLI: `project`, `new`, `edit`, `get`, `list`, `delete`, `history`,
  `index`, `find`, `models`, `config`.
- `@mnemonima/core`: markdown parsing to blocks and outline, dual-strategy
  chunking, content hashing, Float32 vector storage, the three-layer English
  gate, the embedding model registry, embedding spaces and the `Embedder`
  interface with a transformers.js implementation and a deterministic offline
  one.
- `@mnemonima/store`: repositories for notes with revisions, embedding spaces,
  chunks and the embedding cache.
- `@mnemonima/engine`: the indexing pipeline and semantic search with note-level
  fusion and a `why` breakdown.

### Fixed

- Archiving a note now retires it: the indexer sweeps chunks of notes that left
  the active set, and search skips any note that is not active. Previously an
  archived note stayed in the index and kept appearing in results forever.
- `config set` refuses a path that names a group of settings. Previously
  `config set search.limits 5` replaced the whole section with a string, leaving
  `minSimilarity` undefined and making every search return nothing.
- `--id` is validated: the format must be `PREFIX-NNNN`, the prefix must be the
  project's own, and the id counter is moved past it so a later automatic
  allocation cannot collide.
- `project add --force` refuses a directory another project already owns, which
  previously produced two registry names sharing one database.
- `edit` no longer requires a body, so `--title` alone renames a note; the stdin
  hint names the command being run rather than always `new`.
- Archiving records its revision as `delete` instead of `update`, so the audit
  trail distinguishes a rewrite from a retirement.
- A model that cannot be loaded (typically no network on first use) reports exit
  code 2 rather than 70, which is documented as an internal bug.
- `project add` reports the real next note id when adopting an existing
  database, instead of always claiming `PREFIX-0001`.

### Added in stage 2 — hybrid search

- `@mnemonima/engine`: Orama chunk and note indexes built from SQLite, with BM25,
  cosine and metadata retrieval passes.
- Search modes `hybrid` (default), `semantic`, `lexical`, `exact` and `id`.
  `exact` greps note bodies and treats `/pattern/flags` as a regular expression;
  it needs no index and works before the first `index` run.
- Note-level fusion with per-strategy weights and a decomposable `why`:
  `text + vector + meta + multiChunk` equals the score exactly.
- A note can be found on metadata alone — title, aliases, terms, tags, outline —
  with the per-field boosts from `search.boost`.
- `find --weights text=0.3,vector=0.7` overrides the hybrid balance per query.
- `lexical`, `exact` and `id` skip loading the embedding model entirely.
- `@mnemonima/store`: `aliasesByNote`, `tagsByNote` and `termsByNote` load
  per-note metadata for the whole project in one query each.

### Added in stage 3 — the graph

- `@mnemonima/core`: link extraction for `[[id]]`, `[[id title]]`, `[[id|anchor]]`,
  `[[id#heading]]` and plain markdown links. Wikilinks are read from the mdast
  tree, so an example inside a code block is not a link.
- `@mnemonima/engine`: link resolution by leading id, then alias, then title;
  a target that resolves to nothing is kept exactly as written.
- Links are rewritten on every note write and rebuilt from the bodies on every
  `index` run, so a forward reference starts resolving the moment its target
  exists.
- Backlinks are derived from one query and never stored as editable state.
- Graph boost and expansion in search, filling `why.graph`; expanded notes carry
  `via`.
- `find --mode graph --from <id> --depth <n>` walks the graph outwards.
- `find --expand-links 1` attaches direct neighbours to every hit.
- `link` and `unlink`, which edit a `## Related` section in the note body rather
  than the links table. `unlink` refuses to cut a link out of prose.
- `links`, `neighbours`, `alias add|remove|list`, `get --with-neighbours`.
- `doctor` and `doctor --fix`: dangling links, orphans, non-English notes,
  unindexed notes, chunks without vectors, a stale id counter, missing
  attachments, duplicate aliases.

### Added in stage 4 — terms

- `@mnemonima/core`: candidate generation by part-of-speech pattern, a YAKE
  implementation, reciprocal-rank fusion of YAKE with corpus IDF and candidate
  embeddings, structural boosts, nested-term collapsing and MMR diversification.
- `parseMarkdown` now returns `plain`: the document with its markup removed, so
  extraction never proposes "## Fragment stage" as a term.
- `@mnemonima/store`: the term repository, including promotion of an automatic
  term to manual in place, the block list and promotion candidates.
- `@mnemonima/engine`: corpus statistics, the manual gazetteer, and the per-note
  extraction pass, run after embedding so the candidate cosine has note vectors
  to measure against.
- `terms list|candidates|add|pin|block|unblock|remove|of`.
- Extracted terms feed the note index, so a query matching a term finds its note
  through the metadata half of the hybrid score.

### Added in stage 5 — the daemon

- `@mnemonima/daemon`: a local HTTP server on `127.0.0.1` with a random per-run
  token, an origin check, and an LRU pool of hot projects.
- `GET /status` reports what is loaded right now — notes, chunks, embedding
  space, idle time, memory — alongside every registered project and whether it
  is hot. This is what a UI polls.
- `searchNotes` accepts a prebuilt `index`, which is what lets the daemon serve
  from memory instead of rebuilding per request.
- Orama snapshots stored in `orama_snapshots`, keyed by the embedding space and
  validated against a fingerprint of the rows, so a stale one cannot be served.
- `daemon status|start|stop|restart|unload|logs|state`, and `find --no-daemon`.
- `find` starts a daemon when one would help and falls back to running in
  process when it cannot.
- `daemon.autoStart` in the project configuration.

### Added — a first web UI

- `mnemonima ui` opens a single-page interface served by the daemon at `/ui`:
  the projects it holds in memory, a search panel with the hybrid balance and a
  `why` bar on every hit, and the note graph with a click-through to the note.
- Self-contained by design: no bundler, no CDN, no external asset. It becomes
  its own package when it outgrows one file.

### Fixed

- Stop words are stripped from BM25 queries. Because Orama treats a document
  matching any single term as a hit and scores are normalised per result set, a
  query like "growing vegetables in a warm bed" gave the full text score to
  notes that matched only "in" and "a" — shader notes outranked the gardening
  ones. Both queries now rank correctly.

### Added in stage 6 — the markdown bridge

- `mnemonima export` writes every note as `SL-0042 Title.md` with frontmatter
  split into an authoritative half, read back on import, and a generated half
  that is written for the reader and discarded.
- `mnemonima import` reads it back: new notes are created, edits applied, and a
  file whose revision is behind the database while both bodies differ is a
  conflict. `--on-conflict ask|db|file|both`, with `both` keeping each version as
  its own note so nothing is lost. `--dry-run` reports without writing.
- Git: `project add --git` and `export --init-git` initialise the export
  directory, `export` commits what changed, and `--push` is the only way to push.
- `@mnemonima/store`: `listTags`, `setNoteTags` and `addNoteTerm`, which attaches
  one term without replacing the rest.
- `createNote` and `writeNoteBody` accept the revision operation to record, so an
  import is visible as such in `history`.

### Added in stage 7 — MCP and the daemon write path

- `@mnemonima/mcp`: an MCP server over stdio with nineteen tools — search, read,
  list, graph, terms; create, update, archive, delete, link, unlink, alias, four
  term operations, undo; index, export, status.
- The daemon now owns writes: create, update, delete, link, unlink, alias,
  terms, index, undo, revert and export endpoints, each recording an author and
  a batch id.
- Debounced automatic export after a write, committed to git. It requires
  `export.enabled` and an export directory that already exists, and is flushed
  on shutdown.
- `mnemonima revert <id> --rev <n>` and `mnemonima undo --batch <id>`, with
  `mnemonima history --batches` to find one. Neither destroys anything: an undo
  is itself a revision, and a note a batch created is archived, not deleted.
- Destructive operations are refused unless `mcp.allowDestructive` is on for the
  project.
- `@mnemonima/store`: `getRevision`, `listBatches` and `batchTouchedNotes`.

### Fixed

- `mnemonima mcp` and `daemon start --foreground` dynamically import a resolved
  path, which on Windows is `W:\...` — a scheme the ESM loader refuses. Both now
  convert it with `pathToFileURL` first.

### Contract

- Exit codes: `0` success, `1` not found, `2` bad request, `3` language gate,
  `4` daemon unavailable, `70` unexpected internal failure. Code `70` extends the
  set described in `DESIGN.md` 12.1 so that a bug is not reported as a user error.
- With `--json`, stdout carries JSON only; every diagnostic goes to stderr.
- `MNEMONIMA_HOME` overrides the global state directory (`~/.mnemonima`).
