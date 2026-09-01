import { afterEach, describe, expect, it, vi } from 'vitest'
import { Progress } from './output.js'

/**
 * Progress through a pipe.
 *
 * A first index of a real project takes minutes, and an agent runs it as
 * `mnemonima index 2>&1 | tail`. Printing nothing at all made a long run
 * indistinguishable from a hung one, which is the whole reason this has a
 * second shape.
 *
 * `process.stderr.isTTY` is false under vitest, so these exercise the piped
 * branch, which is the one that was missing.
 */

describe('Progress through a pipe', () => {
  const written: string[] = []
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })

  afterEach(() => {
    written.length = 0
    vi.useRealTimers()
  })

  it('prints the first update and then holds off', () => {
    const progress = new Progress(true)

    progress.update('chunking 1/400')
    progress.update('chunking 2/400')
    progress.update('chunking 3/400')

    // One line, not a flood: the report that follows has to stay readable.
    expect(written).toEqual(['chunking 1/400\n'])
  })

  it('prints again once enough time has passed', () => {
    vi.useFakeTimers()
    const progress = new Progress(true)

    progress.update('embedding 10/1721')
    vi.advanceTimersByTime(20_000)
    progress.update('embedding 900/1721')

    expect(written).toEqual(['embedding 10/1721\n', 'embedding 900/1721\n'])
  })

  it('says nothing at all when it is disabled', () => {
    const progress = new Progress(false)

    progress.update('chunking 1/400')
    progress.done('finished')

    expect(written).toEqual([])
  })

  it('still prints a closing message, which is not progress', () => {
    const progress = new Progress(true)
    progress.done('indexed 400 notes')

    expect(written).toEqual(['indexed 400 notes\n'])
  })

  it('restores the real stderr', () => {
    spy.mockRestore()
    expect(vi.isMockFunction(process.stderr.write)).toBe(false)
  })
})
