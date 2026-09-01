import { describe, expect, it } from 'vitest'
import { LanguageGateError } from './errors.js'
import {
  assertEnglish,
  assertEnglishScript,
  findBlockedScript,
  gateText,
  isEnglishScript,
  positionOf,
} from './language.js'

describe('script gate', () => {
  it('accepts plain English', () => {
    expect(isEnglishScript('A fragment shader runs once per rasterized pixel.')).toBe(true)
  })

  it('accepts typography, diacritics, maths and emoji', () => {
    expect(isEnglishScript('Gouraud shading — the "cheap" one, ~0.5 ms, 90° cone ≈ 1/2 λ')).toBe(
      true,
    )
    expect(isEnglishScript('Bjoerk vs Björk, 100% ✅')).toBe(true)
  })

  it('rejects Cyrillic', () => {
    const violation = findBlockedScript('shaders and шейдеры')
    expect(violation?.script).toBe('Cyrillic')
    expect(violation?.char).toBe('ш')
  })

  it('rejects CJK and other blocked scripts', () => {
    expect(isEnglishScript('着色器')).toBe(false)
    expect(isEnglishScript('シェーダー')).toBe(false)
    expect(isEnglishScript('셰이더')).toBe(false)
    expect(isEnglishScript('تظليل')).toBe(false)
  })

  it('reports the earliest violation when several scripts are present', () => {
    const violation = findBlockedScript('abc 着色器 def шейдер')
    expect(violation?.script).toBe('Han')
  })

  it('reports a one-based line and column', () => {
    expect(positionOf('abc\ndef', 0)).toEqual({ line: 1, column: 1 })
    expect(positionOf('abc\ndef', 4)).toEqual({ line: 2, column: 1 })

    const violation = findBlockedScript('first line\nsecond шейдер')
    expect(violation?.position).toEqual({ line: 2, column: 8 })
  })

  it('throws with exit code 3 and names the subject', () => {
    try {
      assertEnglishScript('шейдеры', 'query')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LanguageGateError)
      const gate = error as LanguageGateError
      expect(gate.exitCode).toBe(3)
      expect(gate.message).toContain('query must be in English')
      expect(gate.details?.['script']).toBe('Cyrillic')
    }
  })

  it('does not throw for valid text', () => {
    expect(() => assertEnglishScript('shaders introducing', 'query')).not.toThrow()
  })
})

describe('what the gate deliberately does not judge', () => {
  it('accepts an English query that a trigram detector called Dutch', () => {
    // The regression that removed the statistical layer. franc-min ranked this
    // nld=1.000 and did not rank English at all; the gate read that absence as
    // proof and refused a correct question from the one consumer that matters.
    const query = 'why does a particle break rendering when it opens its own buffer'

    expect(gateText(query, 'query').ok).toBe(true)
    expect(() => assertEnglish(query, 'query')).not.toThrow()
  })

  it('accepts Latin-script prose that is not English', () => {
    // The cost of the trade, stated so it is a decision rather than a gap: the
    // model handles this poorly, but it does not choke, and catching it was
    // worth less than rejecting correct English cost.
    const german =
      'Der Fragment-Shader wird fuer jeden gerasterten Bildpunkt einmal ausgefuehrt ' +
      'und schreibt einen einzigen Farbwert in den Bildspeicher.'

    expect(gateText(german, 'note body').ok).toBe(true)
  })

  it('still refuses a non-Latin script, which is the whole point', () => {
    expect(gateText('шейдеры и растеризация пикселей', 'note body').ok).toBe(false)
  })
})

describe('gateText', () => {
  const english = 'A fragment shader runs once per rasterized pixel and writes one colour.'

  it('passes clean English', () => {
    expect(gateText(english, 'note body').ok).toBe(true)
  })

  it('exempts code blocks by default', () => {
    const body = `${english}

\`\`\`js
const message = "шейдеры"
\`\`\`
`

    expect(gateText(body, 'note body').ok).toBe(true)
    expect(gateText(body, 'note body', { gateCodeBlocks: true }).ok).toBe(false)
  })

  it('reports but allows in warn mode', () => {
    const result = gateText('шейдеры', 'note body', { mode: 'warn' })

    expect(result.ok).toBe(true)
    expect(result.warning).toBe(true)
    expect(result.finding?.reason).toBe('script')
  })

  it('passes everything in off mode', () => {
    expect(gateText('шейдеры', 'note body', { mode: 'off' }).ok).toBe(true)
  })
})

describe('assertEnglish', () => {
  it('throws in strict mode and carries a hint', () => {
    try {
      assertEnglish('шейдеры', 'note body')
      expect.unreachable('should have thrown')
    } catch (error) {
      const gate = error as { exitCode: number; hint?: string }
      expect(gate.exitCode).toBe(3)
      expect(gate.hint).toBeDefined()
    }
  })

  it('returns the finding instead of throwing in warn mode', () => {
    const finding = assertEnglish('шейдеры', 'note body', { mode: 'warn' })
    expect(finding?.reason).toBe('script')
  })

  it('returns null for clean text', () => {
    expect(assertEnglish('shaders introducing', 'query')).toBeNull()
  })
})
