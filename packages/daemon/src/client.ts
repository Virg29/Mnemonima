import { DaemonUnavailableError, MnemonimaError, EXIT } from '@mnemonima/core'
import type { DaemonState } from './state.js'
import type { DaemonStatus } from './server.js'

/**
 * Thin HTTP client.
 *
 * Errors from the daemon arrive as `{ error, hint, details }` and are turned
 * back into the same `MnemonimaError` shape the in-process path throws, so a
 * command reads identically whether it went over the socket or not — including
 * its exit code.
 */
export class DaemonClient {
  #base: string
  #token: string
  readonly #reconnect: (() => Promise<DaemonState>) | null

  /**
   * @param reconnect how to find a daemon again after this one stops answering.
   *   A long-lived client — an MCP session lasts as long as the agent does —
   *   otherwise held one port and one token for good: the moment the daemon
   *   restarted, went idle or was stopped, every later call failed with "cannot
   *   reach the daemon" and the session was finished. Given a way to look one
   *   up, a connection failure becomes a reconnect and a retry.
   */
  constructor(state: DaemonState, reconnect?: () => Promise<DaemonState>) {
    this.#base = `http://127.0.0.1:${state.port}`
    this.#token = state.token
    this.#reconnect = reconnect ?? null
  }

  async status(): Promise<DaemonStatus> {
    return this.#request<DaemonStatus>('GET', '/status')
  }

  async search(project: string, body: Record<string, unknown>): Promise<unknown> {
    return this.#request('POST', `/projects/${encodeURIComponent(project)}/search`, body)
  }

  async unload(project: string): Promise<{ name: string; unloaded: boolean }> {
    return this.#request('POST', `/projects/${encodeURIComponent(project)}/unload`)
  }

  /**
   * Any endpoint, for callers with their own vocabulary — the MCP adapter maps
   * its tools onto these paths rather than growing a method per tool here.
   */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.#request<T>(method, path, body)
  }

  async #request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    let response: Response

    try {
      response = await fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (cause) {
      // Once, and only for a connection that failed outright — never for an
      // error the daemon itself returned, which is an answer and not a
      // disconnection.
      if (retry && this.#reconnect !== null) {
        try {
          const state = await this.#reconnect()
          this.#base = `http://127.0.0.1:${state.port}`
          this.#token = state.token

          return await this.#request<T>(method, path, body, false)
        } catch {
          // Fall through to the original failure: the reconnect not working is
          // less informative than the request not working.
        }
      }

      throw new DaemonUnavailableError(
        `cannot reach the daemon: ${cause instanceof Error ? cause.message : String(cause)}`,
        { details: { path }, hint: 'run `mnemonima daemon status`, or `daemon restart`' },
      )
    }

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
      hint?: string | null
      details?: Record<string, unknown> | null
    }

    if (response.ok) return payload as T

    throw new MnemonimaError(payload.error ?? `daemon returned ${response.status}`,
      exitCodeFor(response.status), {
        details: payload.details ?? {},
        ...(payload.hint === null || payload.hint === undefined ? {} : { hint: payload.hint }),
      })
  }
}

function exitCodeFor(status: number): (typeof EXIT)[keyof typeof EXIT] {
  if (status === 404) return EXIT.NOT_FOUND
  if (status === 400) return EXIT.BAD_REQUEST
  if (status === 401 || status === 403) return EXIT.DAEMON_UNAVAILABLE
  return EXIT.INTERNAL
}
