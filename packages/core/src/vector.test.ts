import { describe, expect, it } from 'vitest'
import { BadRequestError } from './errors.js'
import { hashObject, hashText, normaliseText, stableStringify } from './hash.js'
import { cosine, decodeVector, dot, encodeVector, l2Norm, l2Normalize } from './vector.js'

describe('vector storage', () => {
  it('round-trips through the packed blob format', () => {
    const original = Float32Array.from([0.5, -0.25, 0, 1])
    const restored = decodeVector(encodeVector(original), 4)

    expect([...restored]).toEqual([...original])
  })

  it('survives an unaligned blob, which SQLite gives no guarantee about', () => {
    const original = Float32Array.from([1, 2, 3, 4])
    const packed = encodeVector(original)

    const padded = Buffer.alloc(packed.byteLength + 1)
    packed.copy(padded, 1)
    const unaligned = padded.subarray(1)

    expect([...decodeVector(unaligned, 4)]).toEqual([1, 2, 3, 4])
  })

  it('rejects a blob whose length disagrees with the space', () => {
    expect(() => decodeVector(encodeVector(Float32Array.from([1, 2])), 4)).toThrow(BadRequestError)
  })
})

describe('vector maths', () => {
  it('normalises to unit length', () => {
    const normalised = l2Normalize(Float32Array.from([3, 4]))
    expect(l2Norm(normalised)).toBeCloseTo(1, 6)
    expect(normalised[0]).toBeCloseTo(0.6, 6)
  })

  it('leaves a zero vector alone', () => {
    expect([...l2Normalize(new Float32Array(3))]).toEqual([0, 0, 0])
  })

  it('equals cosine for normalised inputs, which is why storage normalises', () => {
    const a = l2Normalize(Float32Array.from([1, 2, 3]))
    const b = l2Normalize(Float32Array.from([2, 1, 0]))

    expect(dot(a, b)).toBeCloseTo(cosine(a, b), 6)
  })

  it('rejects mismatched lengths', () => {
    expect(() => dot(Float32Array.from([1]), Float32Array.from([1, 2]))).toThrow(BadRequestError)
  })
})

describe('hashing', () => {
  it('normalises line endings and trailing whitespace', () => {
    expect(normaliseText('a\r\nb  \n')).toBe('a\nb')
    expect(hashText('a\r\nb')).toBe(hashText('a\nb'))
  })

  it('is insensitive to key order, so reordering config invents no new space', () => {
    expect(hashObject({ a: 1, b: { c: 2, d: 3 } })).toBe(hashObject({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('distinguishes different content', () => {
    expect(hashText('fragment shader')).not.toBe(hashText('vertex shader'))
  })

  it('serialises arrays positionally', () => {
    expect(stableStringify([1, 'a', null])).toBe('[1,"a",null]')
    expect(hashObject([1, 2])).not.toBe(hashObject([2, 1]))
  })

  it('ignores undefined members', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})
