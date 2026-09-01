import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DaemonClient, findRunning, spawnDaemon } from '@mnemonima/daemon'
import { listEntries } from '@mnemonima/store'
import { newBatchId } from '@mnemonima/engine'
import { createMcpServer } from './server.js'

/**
 * The MCP entry point, spoken over stdio.
 *
 * **stdout carries the protocol and nothing else.** Every diagnostic goes to
 * stderr; a stray `console.log` here corrupts the session, which is why nothing
 * in this file prints to stdout.
 *
 * Usage: `mnemonima mcp -p "Project Name"`. Without `-p` the project is resolved
 * the way the CLI resolves it — `MNEMONIMA_PROJECT`, or the only registered one
 * — and either way the session is then bound to it for good.
 */

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

function argument(name: string, short?: string): string | undefined {
  const argv = process.argv.slice(2)

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === `--${name}` || (short !== undefined && token === `-${short}`)) return argv[i + 1]
    if (token?.startsWith(`--${name}=`) === true) return token.slice(name.length + 3)
  }

  return undefined
}

function resolveProject(): string {
  const explicit = argument('project', 'p')
  if (explicit !== undefined && explicit !== '') return explicit

  const fromEnv = process.env['MNEMONIMA_PROJECT']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  const entries = listEntries()
  if (entries.length === 1) return entries[0]!.name

  throw new Error(
    entries.length === 0
      ? 'no projects are registered: run `mnemonima project add "My Notes" --dir <path>` first'
      : `pass -p <name> to choose a project — registered: ${entries
          .map((entry) => entry.name)
          .join(', ')}`,
  )
}

const project = resolveProject()
const client = new DaemonClient(
  (await findRunning(pkg.version)) ??
    (await spawnDaemon({
      version: pkg.version,
      entry: require.resolve('@mnemonima/daemon/main'),
    })),
)

// One batch for the whole session, so `undo --batch` has a single handle on
// everything this agent does.
const clientName = argument('client') ?? 'agent'
const author = `mcp:${clientName}`
const batchId = newBatchId('mcp', Date.now(), randomBytes(3).toString('hex'))

const server = createMcpServer({
  client,
  project,
  batchId,
  author,
  version: pkg.version,
})

await server.connect(new StdioServerTransport())

log(`mnemonima mcp ${pkg.version} ready`)
log(`  project  ${project}`)
log(`  author   ${author}`)
log(`  batch    ${batchId}  (undo everything with: mnemonima undo --batch ${batchId})`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => {
      process.exit(0)
    })
  })
}
