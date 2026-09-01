import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { spawnDaemon } from '@mnemonima/daemon'
import { cliVersion, currentDaemon, daemonEntry } from '../daemon-link.js'
import { printLine, printNote } from '../output.js'

/**
 * Opens the browser at the daemon's UI.
 *
 * The token travels in the URL because the page has to authenticate its very
 * first call and has nowhere else to read one from. That is acceptable for a
 * loopback-only server whose token is regenerated on every run.
 */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // Printing the URL is the fallback, and it is printed either way.
  }
}

export function registerUiCommand(program: Command): void {
  program
    .command('ui')
    .summary('open the web interface')
    .description(
      'Starts the daemon if it is not running and opens its UI: the projects it holds\n' +
        'in memory, a search panel with the hybrid balance and a `why` breakdown on\n' +
        'every hit, and the note graph.',
    )
    .option('--no-open', 'print the URL instead of opening a browser')
    .action(async (options: { open?: boolean }) => {
      const running = (await currentDaemon()) ?? (await spawnDaemon({ version: cliVersion(), entry: daemonEntry() }))
      const url = `http://127.0.0.1:${running.port}/ui?token=${running.token}`

      printLine(url)

      if (options.open === false) {
        printNote('open it yourself; the token in the query string is what authenticates the page')
        return
      }

      openBrowser(url)
      printNote('opening in your browser')
    })
}
