# mnemonima

Local hybrid search over a graph of markdown notes, built for AI agents.

> **Status: 0.2.0, working, not on npm.** Every package is `private: true` until
> the public API settles, so it is installed from a clone. `DESIGN.md` is the
> authoritative specification; `CHANGELOG.md` records what changed.

## What it is

A search engine over a personal knowledge base held as a graph of markdown
notes, running entirely on your machine. SQLite is the source of truth, Orama is
the in-memory retrieval layer, and embeddings are computed on the CPU with
`gte-small`. Nothing leaves the machine and nothing needs a key.

The primary consumer is an **agent**; the human interface came second.

| Face | Form |
| --- | --- |
| CLI | `mnemonima find -p "Shader Lab" "how a fragment shader runs"` |
| MCP | stdio server, 23 tools: 9 read, 11 write, 3 administer |
| HTTP | local daemon on `127.0.0.1`, token-authenticated |
| Web UI | nine screens: search lab, graph, editor, terms, spaces, eval, settings, health |

**English only.** Notes, queries and keywords are gated at write time; non-English
input is refused with exit code `3` rather than indexed badly.

---

## Setting it up

Everything below has been run from a clean checkout. Node **20 or newer** and
**pnpm 10** are the only prerequisites; the repository pins pnpm through
`packageManager`, so `corepack enable` is enough to get the right one.

```bash
git clone https://github.com/Virg29/Mnemonima.git
cd Mnemonima
pnpm install
pnpm build
```

`pnpm test` runs the suite (493 tests) if you want to confirm the checkout
before going further. It needs no network and downloads no model.

### Running the command

There is no global install, because nothing is published. Two ways to invoke it,
and the first one always works:

```bash
# From anywhere, by absolute path. This is what the MCP configuration uses.
node /absolute/path/to/Mnemonima/packages/cli/dist/index.js --help
```

```bash
# Or put `mnemonima` on PATH. `pnpm setup` is a one-time step that creates a
# global bin directory and adds it to your shell profile.
pnpm setup
cd packages/cli && pnpm link --global
mnemonima --help
```

The rest of this file writes `mnemonima`; substitute the `node …/index.js` form
if you skipped the link.

### The embedding model

The default model is `Supabase/gte-small` — 384 dimensions, ~34 MB, English
only. It downloads on first use and is cached in `~/.mnemonima/models`, shared
by every project. Fetch it ahead of time so the first index run does not stall:

```bash
mnemonima models pull Supabase/gte-small
```

To try the tool with no download at all, a project can use the offline model.
It is a hashing vectoriser, not a neural one — texts sharing words come out
close, which is enough to see the pipeline work:

```bash
mnemonima config set model.active test/deterministic-384
```

---

## First project

```bash
mnemonima project add "Shader Lab" --dir ./shaders   # register it
mnemonima new --file notes/shaders.md                # add a note
mnemonima index                                      # chunk and embed
mnemonima find "how a fragment shader runs"          # search
```

The directory you pass to `--dir` is yours. Everything the tool generates goes
into exactly one entry inside it, `.mnemonima/` — the database, the export, the
eval set. When exactly one project is registered, `-p` can be omitted;
`MNEMONIMA_PROJECT` sets the default; `MNEMONIMA_HOME` moves the global state
directory away from `~/.mnemonima`, which is how you keep an experiment out of
your real registry.

Already have a folder of markdown? `adopt` takes it as it is:

```bash
mnemonima adopt --dir ./vault              # reports; changes nothing
mnemonima adopt --dir ./vault --write
mnemonima index
```

It reports before it writes, keeps every body exactly as written, turns each
original filename into an alias so existing links keep resolving, and names the
links it would overwrite before overwriting them.

---

## Connecting an agent over MCP

The MCP server binds to **one project** — no tool takes a project argument, so a
cross-project write is not something an agent can express. Every write is
attributed and carries one batch id for the session, printed on startup, so a
whole run can be taken back with `mnemonima undo --batch <id>`.

Put this in `.mcp.json` in the repository the agent works in, or in whatever
file your client reads. The absolute path form needs nothing on PATH:

```json
{
  "mcpServers": {
    "mnemonima": {
      "command": "node",
      "args": [
        "/absolute/path/to/Mnemonima/packages/cli/dist/index.js",
        "mcp",
        "-p",
        "Shader Lab",
        "--client",
        "claude-code"
      ]
    }
  }
}
```

If you linked the command onto PATH, `"command": "mnemonima"` with
`"args": ["mcp", "-p", "Shader Lab", "--client", "claude-code"]` is equivalent.

`--client` is how the writer is recorded in the revision log: writes land as
`author: mcp:claude-code`, so it is visible afterwards what the agent wrote and
what you did.

**Destructive tools are refused by default.** Deleting a note outright,
forgetting a term and rebuilding with a different model need
`mcp.allowDestructive` on for that project; the reversible form — archive
instead of delete, block instead of forget — is always available and the tool
descriptions say so. Turn the gate on only if you mean it:

```bash
mnemonima config set mcp.allowDestructive true
```

The daemon starts on its own when the agent first calls a tool. Writes schedule
their own indexing (`index.auto`, thirty seconds after the writing stops), so an
agent does not need to call `mnemonima_index` after every note — only when it
wants to search for something it just wrote.

### What the agent gets

| Group | Tools |
| --- | --- |
| read | `search`, `get_note`, `list_notes`, `graph`, `explain`, `doctor`, `config`, `list_terms`, `history` |
| write | `create_note`, `update_note`, `archive_note`, `delete_note`, `link`, `unlink`, `add_alias`, `add_term`, `block_term`, `remove_term`, `undo` |
| administer | `index`, `export`, `status` |

All prefixed `mnemonima_`. `mnemonima_explain` is the one worth knowing about:
it returns every passage of a note a query matched, and marks which of them
actually produced the score — the rest reach it through a count, and treating
them as evidence is the usual mistake.

---

## The web interface

```bash
mnemonima ui
```

Starts the daemon if it is not running and opens
`http://127.0.0.1:<port>/ui?token=…`. The token is generated per run and lives
in `~/.mnemonima/daemon.json`; the server listens on loopback only and refuses
any request whose `Origin` is not itself.

Nine screens. The search lab has every tuning knob live against a warm index,
with a `why` breakdown on each hit whose parts add up to the score. The graph
draws notes by degree and cluster, drags nodes where you put them and remembers
where that was, and paints a search as a heat map. Opening a hit marks the
passages that matched inside the note, with a bar splitting each one into words
and meaning.

---

## Commands

```
project add|list|remove          register projects
adopt                            pull in a directory of markdown that is not ours
new | edit | get | list          author and read notes
delete | history | diff          archive, inspect the log, see what changed
revert | undo                    put a note back, or take back a whole session
index                            build or refresh the embedding index
find "<query>"                   search: hybrid, semantic, lexical, exact, id, graph
link | unlink | links            create, remove and inspect links
neighbours | alias               graph neighbours, extra names for a note
terms                            the project vocabulary
doctor                           check project integrity
export | import                  the markdown bridge, with git
eval                             measure search quality against a golden set
daemon                           the background server: status, start, stop, unload
ui                               the web interface
mcp                              serve one project to an agent
models list|pull                 inspect and download embedding models
config show|get|set              project settings
```

`mnemonima help <command>` documents each one, with examples.

Reading the log without changing anything:

```bash
mnemonima history SL-0042          # which revisions there are
mnemonima get SL-0042 --rev 7      # the note as it was, printed
mnemonima diff SL-0042             # the last edit
mnemonima diff SL-0042 --from 7 --to 9
```

## How it works

Notes are parsed to a markdown AST, cut twice — paragraph level and section
level — and each chunk is embedded with its heading breadcrumb prepended. The
embedding cache is keyed by the hash of a chunk's text, so editing one paragraph
re-embeds one or two chunks rather than the note. Changing the model or the
chunking settings defines a separate embedding space beside the current one, so
switching back is instant and there is no migration step.

Search runs BM25 and cosine over the chunks, plus BM25 over note metadata, and
fuses everything to note level: a note where several passages match outranks one
where a single passage does, and a match on a title or an alias counts too.
Orama does the retrieval; the fusion is ours, so every hit carries a `why`
breakdown whose parts add up to the score exactly, and a test asserts it.

Modes:

```
hybrid    BM25 over passages, cosine over vectors, plus note metadata
semantic  vectors only — finds paraphrases that share no words
lexical   BM25 only — exact terms, API names, identifiers
exact     grep over note bodies; /pattern/flags is a regular expression
id        direct lookup of one note id
graph     walk the link graph outwards from one note
```

`lexical`, `exact` and `id` never load the model, so they answer in a few
milliseconds. The hybrid balance is tunable per query with
`--weights text=0.3,vector=0.7`, or persistently with
`mnemonima config set search.hybridWeights.text 0.3`.

Notes form a graph. Links are written in the body as `[[SL-0042]]` or
`[[SL-0042|shader basics]]`; backlinks are derived, so linking A to B never
touches B. A link to an id that does not exist is kept exactly as written —
`doctor` reports it rather than removing it, because a dangling link is data and
usually means a note somebody meant to write. Notes whose neighbours also
matched are boosted, and a note several results point at is pulled in with `via`
explaining why. `--expand-links 1` returns the neighbours of every hit, which
gives an agent a connected subgraph in one call instead of three.

Every write records a revision with its author and an optional batch id, which
is what makes an agent session reviewable and undoable. Nothing here destroys:
an undo is itself a revision, and a note a batch created is archived rather than
deleted.

A background daemon keeps one or two projects in memory and answers from there —
309 ms in process against 20 ms warm, measured on 400 notes and 1600 chunks. It
starts on its own when a search would benefit and stops once nothing has been
loaded for a while. If it will not start, the CLI runs the search in process and
says so: a search must not fail because a background service would not.

## Exit codes

Part of the public contract. Diagnostics always go to stderr; with `--json`,
stdout carries JSON and nothing else, and result order is deterministic so two
runs can be diffed.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | not found |
| 2 | bad request (invalid arguments, conflicting state) |
| 3 | language gate: input is not English |
| 4 | daemon unavailable |
| 70 | unexpected internal failure |

Every failure carries a `hint` saying what to do next, usually as a command you
can run.

## Layout

```
packages/
  core/     pure logic: ids, hashing, vectors, the language gate, markdown,
            chunking, terms, diffing, the embedding model registry
  store/    SQLite schema, migrations, repositories, the project registry
  engine/   orchestration: indexing, retrieval and fusion, links, terms,
            the markdown bridge, adopt, eval, undo
  daemon/   the local HTTP server, the hot-project pool, writes, auto-export
  mcp/      the Model Context Protocol adapter
  cli/      the commander front end
  ui/       the Vite SPA the daemon serves
```

Dependencies point one way: `core ← store ← engine ← daemon ← mcp ← cli`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

CI runs all four on Linux and Windows for every push and pull request. Use an
isolated home when trying things out, so your real registry stays clean:

```bash
MNEMONIMA_HOME=/tmp/mn-home node packages/cli/dist/index.js project list
```

## License

MIT
