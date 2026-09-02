import type { NoteExplanation } from './api.js'
import type { RenderOptions } from './markdown.js'

/**
 * How a search explanation is shown — in one place, because two screens show it.
 *
 * The note screen marks a body opened from the lab; the graph marks the same
 * body in the panel beside the picture. Both answer the same question and both
 * have to answer it the same way, or the two screens would disagree about what
 * the search found.
 */

/**
 * What the renderer needs to mark a body.
 *
 * **Only the passages that scored.** Fusion reads the best chunk of each
 * strategy and nothing else (DESIGN.md 8.4); every other matching chunk reaches
 * the score through the multi-chunk term, which counts them without reading
 * them. Marking all of them marks the whole note: a cosine against `gte-small`
 * sits near 0.7 for unrelated text, so almost every passage of a long note
 * "matches" and the scores come back nearly flat.
 */
export function markedBy(explanation: NoteExplanation | null): RenderOptions {
  if (explanation === null) return {}

  return {
    matched: explanation.passages.filter((passage) => passage.scoring),
    words: explanation.words,
  }
}

/**
 * How many passages made the score, and how many merely matched.
 *
 * The distinction is the fusion rule. Saying "43 passages" when two of them
 * were read would be true and misleading.
 */
export function describeMatch(explanation: NoteExplanation): string {
  const scoring = explanation.passages.filter((passage) => passage.scoring).length
  const rest = explanation.passages.length - scoring

  if (scoring === 0) {
    return 'no passage scored — this note came back on its title, aliases or terms'
  }

  return rest === 0
    ? `${scoring} passage(s) scored`
    : `${scoring} passage(s) scored · ${rest} more matched, and only counted`
}

/** The note's own names and terms the query words hit, as one line. */
export function describeFields(explanation: NoteExplanation): string | null {
  if (explanation.fields.length === 0) return null

  return explanation.fields.map((field) => `${field.field}: ${field.value}`).join(', ')
}
