/**
 * Process exit codes. Part of the public CLI contract — see DESIGN.md 12.1.
 * Changing a value here is a breaking change.
 */
export const EXIT = {
  OK: 0,
  NOT_FOUND: 1,
  BAD_REQUEST: 2,
  LANGUAGE_GATE: 3,
  DAEMON_UNAVAILABLE: 4,
  /** Unexpected internal failure: a bug, not a user error. */
  INTERNAL: 70,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export interface ErrorContext {
  /** Structured data for machine-readable output and logs. */
  readonly details?: Record<string, unknown>
  /**
   * A concrete next step for the operator, printed by the CLI as a separate
   * `hint:` line. Write the command they should run, not a restatement of the
   * problem.
   */
  readonly hint?: string
}

export class MnemonimaError extends Error {
  readonly exitCode: ExitCode
  readonly details: Record<string, unknown> | undefined
  readonly hint: string | undefined

  constructor(message: string, exitCode: ExitCode, context: ErrorContext = {}) {
    super(message)
    this.name = new.target.name
    this.exitCode = exitCode
    this.details = context.details
    this.hint = context.hint
  }
}

export class NotFoundError extends MnemonimaError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, EXIT.NOT_FOUND, context)
  }
}

export class BadRequestError extends MnemonimaError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, EXIT.BAD_REQUEST, context)
  }
}

export class LanguageGateError extends MnemonimaError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, EXIT.LANGUAGE_GATE, context)
  }
}

export class DaemonUnavailableError extends MnemonimaError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, EXIT.DAEMON_UNAVAILABLE, context)
  }
}

export class InternalError extends MnemonimaError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, EXIT.INTERNAL, context)
  }
}
