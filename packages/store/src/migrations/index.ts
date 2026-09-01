import type { Migration } from '../migrate.js'
import { migration001 } from './001-init.js'

/** Forward-only, ordered by version. Never edit a migration that has shipped. */
export const MIGRATIONS: readonly Migration[] = [migration001]
