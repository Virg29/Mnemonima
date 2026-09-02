import type { Migration } from '../migrate.js'
import { migration001 } from './001-init.js'
import { migration002 } from './002-eval.js'
import { migration003 } from './003-adopt.js'
import { migration004 } from './004-layout.js'

/** Forward-only, ordered by version. Never edit a migration that has shipped. */
export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
]
