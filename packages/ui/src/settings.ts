/**
 * What the settings screen needs to know beyond the value itself.
 *
 * The daemon returns every settable dotted path, so the list of controls is
 * derived rather than restated here — a setting added to `ProjectConfig` shows
 * up in the UI without anyone remembering to add it. What cannot be derived is
 * two things: which strings are a closed set, and when a change actually takes
 * effect.
 *
 * That second one matters more than it looks. Most of `search.*` is read at
 * query time, so moving it changes the next answer. `chunking.*` and
 * `model.active` decide what a vector means, so they do nothing until an index
 * run. `daemon.*` is read when the daemon starts. A screen that let all three
 * look identical would teach the operator that the settings do not work.
 */

export type Effect = 'live' | 'index' | 'restart' | 'next-write'

export const EFFECTS: Record<Effect, string> = {
  live: 'Applies to the next query.',
  index: 'Applies after `mnemonima index` — it decides what a vector means.',
  restart: 'Read when the daemon starts: restart it to apply.',
  'next-write': 'Applies to the next write.',
}

export interface Section {
  readonly prefix: string
  readonly title: string
  readonly hint: string
  readonly effect: Effect
  /** Shown above the fields when the section has a caveat worth stating. */
  readonly warning?: string
}

export const SECTIONS: readonly Section[] = [
  {
    prefix: 'daemon',
    title: 'Daemon',
    hint: 'The background server that keeps a project hot in memory.',
    effect: 'restart',
    warning:
      'These are read from the first registered project, because there is no ' +
      'global configuration file yet. Setting them on a second project has no effect.',
  },
  {
    prefix: 'model',
    title: 'Model',
    hint: 'Which embedding model answers, and how many chunks go through it at once.',
    effect: 'index',
  },
  {
    prefix: 'chunking',
    title: 'Chunking',
    hint: 'How a note is cut before it is embedded. Part of the space identity.',
    effect: 'index',
  },
  {
    prefix: 'language',
    title: 'Language gate',
    hint: 'Everything stored is English. This decides how hard the gate is.',
    effect: 'next-write',
  },
  {
    prefix: 'search',
    title: 'Search',
    hint: 'Every weight the search lab exposes, plus the ones it does not.',
    effect: 'live',
  },
  {
    prefix: 'keywords',
    title: 'Terms',
    hint: 'Automatic extraction and the thresholds that promote a term.',
    effect: 'live',
  },
  {
    prefix: 'export',
    title: 'Export',
    hint: 'The markdown bridge and its git commit. Pushing is never automatic.',
    effect: 'next-write',
  },
  {
    prefix: 'links',
    title: 'Links',
    hint: 'Backlinks are derived; this only decides whether they are written out.',
    effect: 'next-write',
  },
  {
    prefix: 'mcp',
    title: 'Agents',
    hint: 'What an agent over MCP is allowed to do.',
    effect: 'next-write',
  },
]

/** Paths whose value is a closed set, so they get a menu rather than a box. */
export const CHOICES: Record<string, readonly string[]> = {
  'language.gate': ['strict', 'warn', 'off'],
  'search.mode': ['hybrid', 'semantic', 'lexical', 'exact', 'id'],
}

/**
 * Per-path notes, for the settings whose value is not self-explanatory.
 *
 * Only where a number has a meaning a label cannot carry — a zero that means
 * "never", a threshold that currently filters nothing.
 */
export const NOTES: Record<string, string> = {
  'daemon.autoStart': 'When off, a search runs in the CLI process instead of asking the daemon.',
  'daemon.idleTimeoutMin': 'Zero means never: the daemon stays up until it is stopped.',
  'daemon.maxHotProjects': 'How many projects may be in memory at once. Each costs ~600 MB at scale.',
  'daemon.projectIdleMin': 'How long a project may sit unused before it is evicted.',
  'daemon.port': 'Zero means a random free port, which is the sane default.',
  'model.active':
    'Changing this builds a new embedding space on the next index run. The old one stays.',
  'mcp.allowDestructive':
    'Off: an agent can archive but not delete, block a term but not forget it.',
  'export.push': 'Pushing stays manual by design; this is here to be seen, not turned on lightly.',
  'export.path': 'Relative to the project subdirectory. An absolute path wins over it.',
  'search.limits.minSimilarity':
    'A floor on the cosine. With gte-small it filters nothing below about 0.6.',
  'keywords.autoWeight': 'At zero the automatic fields drop out of the metadata search entirely.',
  'links.materializeBacklinks': 'Backlinks are always derived; this writes them into the export too.',
}

/** `search.hybridWeights.text` -> `hybrid weights · text`. */
export function labelFor(path: string): string {
  return path
    .split('.')
    .slice(1)
    .map((part) => part.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
    .join(' · ')
}
