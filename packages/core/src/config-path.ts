import { BadRequestError } from './errors.js'
import { defaultProjectConfig } from './config.js'

/**
 * Dotted-path access into the project configuration.
 *
 * Extracted from the `config` command so the validation has tests of its own:
 * a path that names a whole section, or a value of the wrong type, must be
 * refused rather than written. Silently replacing `search.limits` with a string
 * leaves every setting under it undefined, and `getConfig`'s merge preserves the
 * damage on every subsequent read.
 *
 * It lives in `core` rather than beside the command because three callers need
 * the same rules: `mnemonima config set`, the daemon's config endpoint, and the
 * search lab, which sends the same dotted paths as a per-query override so a
 * weight can be tried without being saved. One mechanism, one validator — a
 * second one would drift.
 */

export function flatten(value: unknown, prefix = ''): [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [[prefix, value]]
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    flatten(item, prefix === '' ? key : `${prefix}.${key}`),
  )
}

export function readPath(root: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node !== null && typeof node === 'object'
        ? (node as Record<string, unknown>)[key]
        : undefined,
    root,
  )
}

export function writePath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  const last = path[path.length - 1]!
  let node = root

  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string, unknown>
  }
  node[last] = value
}

export function knownPaths(): string[] {
  return flatten(defaultProjectConfig()).map(([key]) => key)
}

function suggest(path: string): string[] {
  const known = knownPaths()
  const head = path.split('.')[0] ?? ''
  const near = known.filter((key) => key.startsWith(head) || key.includes(path))
  return (near.length > 0 ? near : known).slice(0, 8)
}

function isSection(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Returns the default value at `path`, or throws explaining what is wrong. */
export function requirePath(path: string): unknown {
  const current = readPath(defaultProjectConfig(), path.split('.'))

  if (current === undefined) {
    throw new BadRequestError(`unknown configuration key "${path}"`, {
      details: { path },
      hint: `try one of: ${suggest(path).join(', ')} — \`mnemonima config show\` lists them all`,
    })
  }

  if (isSection(current)) {
    const children = Object.keys(current).map((key) => `${path}.${key}`)
    throw new BadRequestError(`"${path}" is a group of settings, not a single value`, {
      details: { path, children },
      hint: `set one of its keys instead: ${children.join(', ')}`,
    })
  }

  return current
}

/**
 * A set of settings to change, keyed by dotted path.
 *
 * The shape an HTTP caller sends, and the shape the search lab sends for a
 * query it does not want to save.
 */
export type ConfigPatch = Readonly<Record<string, unknown>>

function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  return value === null ? 'null' : typeof value
}

/**
 * Checks one already-parsed JSON value against the setting it is meant for.
 *
 * `coerce` is the sibling for a shell, where everything arrives as text. Here
 * the types are real, so the job is to refuse a mismatch rather than to guess.
 */
export function assertValue(path: string, value: unknown): unknown {
  const current = requirePath(path)
  const expected = describeType(current)

  if (describeType(value) !== expected) {
    throw new BadRequestError(`${path} is a ${expected}, got ${describeType(value)}`, {
      details: { path, value, expected },
      hint: `the default is ${JSON.stringify(current)}`,
    })
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new BadRequestError(`${path} must be a finite number`, {
      details: { path, value },
      hint: `the default is ${JSON.stringify(current)}`,
    })
  }

  return value
}

/**
 * Applies a patch to a copy, leaving the original untouched.
 *
 * The copy matters: the search lab overrides weights for one query, and a
 * request that mutated the project's configuration on its way through would
 * make "try this without saving" quietly false.
 */
export function applyPatch<T extends object>(config: T, patch: ConfigPatch): T {
  const next = structuredClone(config) as Record<string, unknown>

  for (const [path, value] of Object.entries(patch)) {
    assertValue(path, value)
    writePath(next, path.split('.'), value)
  }

  return next as T
}

/** Coerces the text a shell gives us into the type the existing value has. */
export function coerce(path: string, raw: string, current: unknown): unknown {
  if (typeof current === 'boolean') {
    if (raw === 'true' || raw === 'false') return raw === 'true'
    throw new BadRequestError(`${path} is a boolean, got "${raw}"`, {
      details: { path, raw },
      hint: 'use true or false',
    })
  }

  if (typeof current === 'number') {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      throw new BadRequestError(`${path} is a number, got "${raw}"`, {
        details: { path, raw },
        hint: `the current value is ${JSON.stringify(current)}`,
      })
    }
    return parsed
  }

  return raw
}
