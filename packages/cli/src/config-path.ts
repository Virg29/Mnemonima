import { BadRequestError, defaultProjectConfig } from '@mnemonima/core'

/**
 * Dotted-path access into the project configuration.
 *
 * Extracted from the `config` command so the validation has tests of its own:
 * a path that names a whole section, or a value of the wrong type, must be
 * refused rather than written. Silently replacing `search.limits` with a string
 * leaves every setting under it undefined, and `getConfig`'s merge preserves the
 * damage on every subsequent read.
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
