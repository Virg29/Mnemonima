import fs from 'node:fs'
import path from 'node:path'
import { BadRequestError, NotFoundError } from '@mnemonima/core'
import { homeDir, registryPath } from './paths.js'

export interface RegistryEntry {
  name: string
  dir: string
  prefix: string
  createdAt: number
}

export interface Registry {
  version: 1
  projects: RegistryEntry[]
}

const EMPTY: Registry = { version: 1, projects: [] }

export function loadRegistry(): Registry {
  const file = registryPath()
  if (!fs.existsSync(file)) return structuredClone(EMPTY)

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Registry>
    return {
      version: 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    }
  } catch (cause) {
    throw new BadRequestError(`project registry at ${file} is not valid JSON`, {
      details: { file, cause: String(cause) },
      hint: `fix or delete ${file}; projects can be re-added with \`mnemonima project add\``,
    })
  }
}

export function saveRegistry(registry: Registry): void {
  const file = registryPath()
  fs.mkdirSync(homeDir(), { recursive: true })

  // Write and rename so an interrupted write cannot leave a truncated registry.
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

export function findEntry(registry: Registry, name: string): RegistryEntry | null {
  const wanted = name.trim()
  const exact = registry.projects.find((entry) => entry.name === wanted)
  if (exact !== undefined) return exact

  const lowered = wanted.toLowerCase()
  return registry.projects.find((entry) => entry.name.toLowerCase() === lowered) ?? null
}

export function requireEntry(name: string): RegistryEntry {
  const entry = findEntry(loadRegistry(), name)
  if (entry === null) throw unknownProject(name)
  return entry
}

/** Shared so every "no such project" path offers the same next step. */
export function unknownProject(name: string): NotFoundError {
  const known = listEntries().map((entry) => entry.name)
  return new NotFoundError(`unknown project "${name}"`, {
    details: { name, known },
    hint:
      known.length === 0
        ? 'no projects are registered yet: `mnemonima project add "My Notes" --dir <path>`'
        : `known projects: ${known.join(', ')} (see \`mnemonima project list\`)`,
  })
}

export function upsertEntry(entry: RegistryEntry): void {
  const registry = loadRegistry()
  const existing = findEntry(registry, entry.name)

  if (existing === null) {
    registry.projects.push(entry)
  } else {
    Object.assign(existing, entry)
  }

  registry.projects.sort((a, b) => a.name.localeCompare(b.name))
  saveRegistry(registry)
}

export function removeEntry(name: string): RegistryEntry {
  const registry = loadRegistry()
  const entry = findEntry(registry, name)
  if (entry === null) throw unknownProject(name)

  registry.projects = registry.projects.filter((candidate) => candidate !== entry)
  saveRegistry(registry)
  return entry
}

export function listEntries(): RegistryEntry[] {
  return loadRegistry().projects
}

export function isRegistered(name: string): boolean {
  return findEntry(loadRegistry(), name) !== null
}

export function registryLocation(): string {
  return path.normalize(registryPath())
}
