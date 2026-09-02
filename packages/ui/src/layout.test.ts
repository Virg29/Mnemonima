import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saveLayout = vi.fn()

vi.mock('./api.js', () => ({ api: { saveLayout: (...args: unknown[]) => saveLayout(...args) } }))

const { LayoutStore, mergeLayout } = await import('./layout.js')
type Stored = import('./layout.js').Stored
type Position = import('./layout.js').Position

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

/**
 * The flush, which is where a drag can be lost.
 *
 * `localStorage` is stubbed rather than mocked away: the store's whole job is
 * what survives in it between a move and an acknowledgement, so a fake that did
 * not actually persist would test nothing.
 */
describe('flushing pending moves', () => {
  let sent: Record<string, Position>[]

  beforeEach(() => {
    sent = []

    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })

    vi.stubGlobal('window', {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    })

    saveLayout.mockImplementation(async (_project: string, positions: Record<string, Position>) => {
      sent.push(positions)
      return { saved: Object.keys(positions).length }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    saveLayout.mockReset()
  })

  it('sends what was moved and clears it once acknowledged', async () => {
    const store = new LayoutStore('p')
    store.remember('SL-0001', { x: 1, y: 2 })

    await store.flush()

    expect(sent).toEqual([{ 'SL-0001': { x: 1, y: 2 } }])
    expect(JSON.parse(localStorage.getItem('mnemonima.layout.p')!).pending).toEqual([])
  })

  it('keeps a move made while the flush was in flight', async () => {
    // The race the two-store design exists to survive. Clearing by id marked
    // the second position acknowledged although it never went out, the next
    // flush found an empty list, and the note reverted on the following load.
    const store = new LayoutStore('p')
    store.remember('SL-0001', { x: 1, y: 2 })

    let release: (() => void) | null = null
    saveLayout.mockImplementationOnce(async (_p: string, positions: Record<string, Position>) => {
      sent.push(positions)
      await new Promise<void>((done) => (release = done))
      return { saved: 1 }
    })

    const inFlight = store.flush()
    store.remember('SL-0001', { x: 9, y: 9 })
    release!()
    await inFlight

    const after = JSON.parse(localStorage.getItem('mnemonima.layout.p')!)
    expect(after.pending).toEqual(['SL-0001'])
    expect(after.positions['SL-0001']).toEqual([9, 9])

    await store.flush()
    expect(sent[1]).toEqual({ 'SL-0001': { x: 9, y: 9 } })
  })

  it('leaves everything pending when the daemon refuses', async () => {
    const store = new LayoutStore('p')
    store.remember('SL-0001', { x: 1, y: 2 })

    saveLayout.mockRejectedValueOnce(new Error('daemon is not answering'))
    const seen: unknown[] = []
    store.onError((error) => seen.push(error))

    await store.flush()

    expect(seen).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('mnemonima.layout.p')!).pending).toEqual(['SL-0001'])
  })
})
