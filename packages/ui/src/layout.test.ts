import { describe, expect, it } from 'vitest'
import { mergeLayout } from './layout.js'
import type { Stored } from './layout.js'

/**
 * The merge rule, which is where the two stores meet.
 *
 * Every case here was a jumping graph before it was a test: the whole point of
 * remembering a position is that nothing moves on its own, and each of these
 * rules is one class of node that used to move anyway.
 */

const stored = (positions: Record<string, [number, number]>, pending: string[] = []): Stored => ({
  positions,
  pending,
})

describe('merging the stored layout with the server', () => {
  it('takes the server placement', () => {
    const merged = mergeLayout({ 'SL-0001': { x: 1, y: 2 } }, stored({}))

    expect(merged.get('SL-0001')).toEqual({ x: 1, y: 2 })
  })

  it('prefers a local move the server has not acknowledged', () => {
    // The four seconds between letting go and the flush, and the reload that
    // can land inside them.
    const merged = mergeLayout(
      { 'SL-0001': { x: 1, y: 2 } },
      stored({ 'SL-0001': [9, 9] }, ['SL-0001']),
    )

    expect(merged.get('SL-0001')).toEqual({ x: 9, y: 9 })
  })

  it('prefers the server once the local copy is acknowledged', () => {
    // Another window has moved it since. Last write wins, per note.
    const merged = mergeLayout({ 'SL-0001': { x: 1, y: 2 } }, stored({ 'SL-0001': [9, 9] }))

    expect(merged.get('SL-0001')).toEqual({ x: 1, y: 2 })
  })

  it('keeps a local position the server has no answer for', () => {
    // A phantom node stands for a link to an id no note has, so there is no row
    // to hang a position on and the server drops it. With only pending ids
    // overlaid, every phantom came back unplaced and was arranged afresh on
    // each visit — nine of them jumped on every reload of a graph that
    // otherwise stood still.
    const merged = mergeLayout({ 'SL-0001': { x: 1, y: 2 } }, stored({ 'SL-0404': [5, 6] }))

    expect(merged.get('SL-0404')).toEqual({ x: 5, y: 6 })
  })

  it('keeps everything local when the server knows nothing', () => {
    // A daemon that has never been told, or was told while it was down.
    const merged = mergeLayout({}, stored({ 'SL-0001': [1, 1], 'SL-0002': [2, 2] }))

    expect(merged.size).toBe(2)
  })

  it('is empty when neither side has anything', () => {
    // Which is the signal to arrange the graph from scratch.
    expect(mergeLayout({}, stored({})).size).toBe(0)
  })
})
