import fs from 'node:fs'
import path from 'node:path'
import { BadRequestError } from '@mnemonima/core'
import { DaemonClient, clearDaemonState, readDaemonState, spawnDaemon, stopDaemon } from '@mnemonima/daemon'
import { homeDir } from '@mnemonima/store'
import { Command } from 'commander'
import { cliVersion, currentDaemon, daemonEntry, importable } from '../daemon-link.js'
import { formatDuration, printFields, printJson, printLine, printNote, printTable, truncate } from '../output.js'

function logFile(): string {
  return path.join(homeDir(), 'logs', 'daemon.log')
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command('daemon')
    .summary('manage the background server')
    .description(
      'The daemon keeps one or two projects hot in memory. The CLI rebuilds both search\n' +
        'indexes on every invocation; the daemon builds them once and answers from RAM.\n' +
        '\n' +
        'It binds to 127.0.0.1 only, with a random token per run written to\n' +
        `${path.join(homeDir(), 'daemon.json')}.\n` +
        '\n' +
        'It starts on its own when a search would benefit, unless daemon.autoStart is\n' +
        'off, and stops itself once nothing has been loaded for daemon.idleTimeoutMin.',
    )

  daemon
    .command('status')
    .summary('show what the daemon is holding in memory')
    .description(
      'Which projects are loaded right now, how big their indexes are, and how long\n' +
        'they have been idle. This is what a UI polls to show the state of the engine.',
    )
    .option('--json', 'machine readable output')
    .action(async (options: { json?: boolean }) => {
      const state = await currentDaemon()

      if (state === null) {
        if (options.json === true) {
          printJson({ running: false, version: cliVersion(), loaded: [], registered: [] })
          return
        }

        printLine('The daemon is not running.')
        printNote('it starts on its own with the next search, or run `mnemonima daemon start`')
        return
      }

      const status = await new DaemonClient(state).status()

      if (options.json === true) {
        printJson({ running: true, port: state.port, ...status })
        return
      }

      printLine(`Daemon ${status.version} on port ${state.port}`)
      printFields([
        ['pid', String(status.pid)],
        ['uptime', formatDuration(status.uptimeMs)],
        ['memory', `${status.memory.rssMb} MB resident, ${status.memory.heapMb} MB heap`],
        ['capacity', `${status.loaded.length} of ${status.capacity} project(s) loaded`],
      ])
      printLine()

      if (status.loaded.length === 0) {
        printLine('Nothing loaded yet.')
      } else {
        printTable(
          ['PROJECT', 'NOTES', 'CHUNKS', 'INDEX', 'IDLE', 'USES'],
          status.loaded.map((project) => [
            truncate(project.name, 24),
            project.index === null ? '-' : String(project.index.notes),
            project.index === null ? '-' : String(project.index.chunks),
            project.index === null
              ? 'not built'
              : `${project.index.spaceId.slice(0, 8)}${project.index.fromSnapshot ? ' (restored)' : ''}`,
            formatDuration(project.idleMs),
            String(project.uses),
          ]),
        )
      }

      const cold = status.registered.filter((entry) => !entry.loaded)
      if (cold.length > 0) {
        printLine()
        printNote(`registered but not loaded: ${cold.map((entry) => entry.name).join(', ')}`)
      }
    })

  daemon
    .command('start')
    .summary('start the daemon')
    .option('-f, --foreground', 'run in this terminal instead of in the background')
    .action(async (options: { foreground?: boolean }) => {
      const running = await currentDaemon()
      if (running !== null) {
        printLine(`Already running on port ${running.port} (pid ${running.pid}).`)
        return
      }

      if (options.foreground === true) {
        printNote('starting in the foreground; press Ctrl+C to stop')
        await import(importable(daemonEntry()))
        return
      }

      const started = await spawnDaemon({ version: cliVersion(), entry: daemonEntry() })
      printLine(`Started on port ${started.port} (pid ${started.pid}).`)
      printNote(`logs: ${logFile()}`)
    })

  daemon
    .command('stop')
    .summary('stop the daemon')
    .action(async () => {
      const running = await currentDaemon()
      if (running === null) {
        // A leftover state file from a crash is not an error worth reporting.
        clearDaemonState()
        printLine('The daemon is not running.')
        return
      }

      printLine(stopDaemon(running) ? `Stopped (pid ${running.pid}).` : 'Stopped a stale entry.')
    })

  daemon
    .command('restart')
    .summary('stop and start the daemon')
    .action(async () => {
      const running = await currentDaemon()
      if (running !== null) stopDaemon(running)

      const started = await spawnDaemon({ version: cliVersion(), entry: daemonEntry() })
      printLine(`Restarted on port ${started.port} (pid ${started.pid}).`)
    })

  daemon
    .command('unload')
    .summary('drop one project from memory')
    .description('Frees the memory a hot project holds without stopping the daemon.')
    .argument('<name>', 'project name')
    .action(async (name: string) => {
      const state = await currentDaemon()
      if (state === null) {
        throw new BadRequestError('the daemon is not running', {
          details: { name },
          hint: 'nothing is loaded, so there is nothing to unload',
        })
      }

      const result = await new DaemonClient(state).unload(name)
      printLine(result.unloaded ? `Unloaded "${name}".` : `"${name}" was not loaded.`)
    })

  daemon
    .command('logs')
    .summary('print the daemon log')
    .option('-n, --lines <n>', 'how many lines to show', '40')
    .action((options: { lines?: string }) => {
      const file = logFile()
      if (!fs.existsSync(file)) {
        printLine('No log yet.')
        printNote(`it appears at ${file} once the daemon has run`)
        return
      }

      const lines = fs.readFileSync(file, 'utf8').split('\n')
      const count = Number(options.lines ?? '40')
      for (const line of lines.slice(-(Number.isFinite(count) ? count : 40))) {
        if (line !== '') printLine(line)
      }
    })

  daemon
    .command('state')
    .summary('print the connection details the clients use')
    .option('--json', 'machine readable output')
    .action((options: { json?: boolean }) => {
      const state = readDaemonState()

      if (options.json === true) {
        printJson(state ?? { running: false })
        return
      }

      if (state === null) {
        printLine('No daemon state recorded.')
        return
      }

      printFields([
        ['url', `http://127.0.0.1:${state.port}`],
        ['pid', String(state.pid)],
        ['version', state.version],
        ['token', `${state.token.slice(0, 8)}… (full value in ${path.join(homeDir(), 'daemon.json')})`],
      ])
    })
}
