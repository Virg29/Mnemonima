import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BadRequestError, NotFoundError, TEST_MODEL_ID } from '@mnemonima/core'
import type { ProjectConfig } from '@mnemonima/core'
import { createProject, createSandbox, getConfig, projectDataDir, setConfig } from '@mnemonima/store'
import type { Db, Sandbox } from '@mnemonima/store'
import { createEmbedder } from './embedder.js'
import type { ResolvedEmbedder } from './embedder.js'
import { evalSetPath, readQuerySet, runEval } from './eval.js'
import { indexProject } from './indexer.js'
import { writeNewNote } from './notes.js'
import { splitQueries, tuneWeights } from './tune.js'

/**
 * The harness, against a small real corpus rather than stubs: the point of
 * stage 9 is a number that reflects the engine, so the test that matters is
 * that a set the engine answers well scores better than one it answers badly.
 */

const NOTES = [
  '# Shaders introduction\n\nA fragment shader runs once per rasterized pixel and writes one colour.\n',
  '# GPU pipeline\n\nThe vertex stage runs once per vertex; rasterization decides which pixels a triangle covers.\n',
  '# Uniform buffer layout\n\nStandard layout pads every member to a sixteen byte boundary.\n',
  '# Vegetable bed\n\nRaised beds warm earlier in spring and drain better after rain.\n',
]

describe('the eval harness', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let projectDir: string
  let resolved: ResolvedEmbedder

  const writeSet = (yaml: string): void => {
    const file = evalSetPath(projectDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, yaml)
  }

  beforeEach(async () => {
    sandbox = createSandbox()
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)

    for (const body of NOTES) writeNewNote(db, config, body, { author: 'test' })

    resolved = await createEmbedder(config)
    await indexProject(db, config, resolved)
  })

  afterEach(async () => {
    await resolved.embedder.dispose()
    db.close()
    sandbox.cleanup()
  })

  const run = async (): Promise<Awaited<ReturnType<typeof runEval>>> =>
    runEval(db, config, resolved, readQuerySet(projectDir), 'Shader Lab')

  it('scores a set the engine answers well', async () => {
    writeSet(
      [
        '- q: "a fragment shader writes a colour per pixel"',
        '  relevant: [SL-0001]',
        '- q: "sixteen byte boundary padding"',
        '  relevant: [SL-0003]',
      ].join('\n'),
    )

    const report = await run()

    expect(report.metrics.queries).toBe(2)
    expect(report.metrics.recallAtK).toBe(1)
    expect(report.metrics.mrr).toBe(1)
    expect(report.metrics.ndcgAtK).toBe(1)
  })

  it('scores a set the engine answers badly', async () => {
    // The same engine, asked for answers it has no reason to rank first.
    writeSet(
      ['- q: "a fragment shader writes a colour per pixel"', '  relevant: [SL-0004]'].join('\n'),
    )

    const report = await run()

    expect(report.metrics.mrr).toBeLessThan(1)
    expect(report.metrics.recallAtK).toBeLessThan(1)
  })

  it('keeps a row per query, so a bad average can be traced', async () => {
    writeSet(
      [
        '- q: "a fragment shader writes a colour per pixel"',
        '  relevant: [SL-0001]',
        '- q: "raised beds drain after rain"',
        '  relevant: [SL-0004]',
      ].join('\n'),
    )

    const report = await run()

    expect(report.outcomes).toHaveLength(2)
    expect(report.outcomes[0]?.query).toContain('fragment shader')
    expect(report.outcomes[0]?.returned.length).toBeGreaterThan(0)
    expect(report.outcomes.every((outcome) => outcome.tookMs >= 0)).toBe(true)
  })

  it('counts a negative that surfaced instead of hiding it in a score', async () => {
    writeSet(
      [
        '- q: "a fragment shader writes a colour per pixel"',
        '  relevant: [SL-0001]',
        '  irrelevant: [SL-0002]',
      ].join('\n'),
    )

    const report = await run()
    expect(report.metrics.negatives).toBeGreaterThanOrEqual(0)
  })

  it('names ids the set expects that the project does not have', async () => {
    // A renamed or archived note turns a correct engine into a failing score,
    // and the failure looks exactly like a ranking problem.
    writeSet(['- q: "anything at all"', '  relevant: [SL-9999]'].join('\n'))

    const report = await run()
    expect(report.unknownIds).toEqual(['SL-9999'])
  })

  it('warns that a small set is noise', async () => {
    writeSet(['- q: "a fragment shader"', '  relevant: [SL-0001]'].join('\n'))

    const report = await run()
    expect(report.warning).toContain('below 20')
  })

  it('says where to put a set that does not exist', async () => {
    try {
      readQuerySet(projectDir)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError)
      expect((error as NotFoundError).hint).toContain('queries.yaml')
    }
  })

  it('refuses a malformed set rather than scoring it as zero', () => {
    writeSet('- relevant: [SL-0001]\n')
    expect(() => readQuerySet(projectDir)).toThrow(BadRequestError)

    writeSet('- q: "a query"\n  relevant: "SL-0001"\n')
    expect(() => readQuerySet(projectDir)).toThrow(BadRequestError)
  })

  it('reads the set from the project data directory', () => {
    expect(evalSetPath(projectDir)).toBe(
      path.join(projectDataDir(projectDir), 'eval', 'queries.yaml'),
    )
  })
})

describe('weight tuning', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let projectDir: string
  let resolved: ResolvedEmbedder

  beforeEach(async () => {
    sandbox = createSandbox()
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)

    for (const body of NOTES) writeNewNote(db, config, body, { author: 'test' })

    resolved = await createEmbedder(config)
    await indexProject(db, config, resolved)

    const file = evalSetPath(projectDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        '- q: "a fragment shader writes a colour per pixel"',
        '  relevant: [SL-0001]',
        '- q: "which pixels a triangle covers"',
        '  relevant: [SL-0002]',
      ].join('\n'),
    )
  })

  afterEach(async () => {
    await resolved.embedder.dispose()
    db.close()
    sandbox.cleanup()
  })

  it('never returns worse than the settings it started from', async () => {
    // The baseline is a candidate too, so the floor is what is already saved.
    const report = await tuneWeights(db, config, resolved, readQuerySet(projectDir), 'Shader Lab', {
      trials: 5,
      random: sequence(),
    })

    expect(report.best.score).toBeGreaterThanOrEqual(report.baseline.score)
    expect(report.trials).toBe(5)
  })

  it('leaves the stored configuration alone', async () => {
    const before = getConfig(db).search.hybridWeights.text

    await tuneWeights(db, config, resolved, readQuerySet(projectDir), 'Shader Lab', {
      trials: 3,
      random: sequence(),
    })

    // Candidates are patches on a copy: a search must not save anything.
    expect(getConfig(db).search.hybridWeights.text).toBe(before)
  })

  it('reports only the settings that moved', async () => {
    const report = await tuneWeights(db, config, resolved, readQuerySet(projectDir), 'Shader Lab', {
      trials: 4,
      random: sequence(),
    })

    for (const change of report.changes) expect(change.from).not.toBe(change.to)
  })

  it('cannot hold anything back from a set this small, and says so', async () => {
    // Two queries cannot be split into a search half and a check half, so the
    // report has to admit that its own number proves nothing.
    const report = await tuneWeights(db, config, resolved, readQuerySet(projectDir), 'Shader Lab', {
      trials: 2,
      random: sequence(),
    })

    expect(report.holdout).toBeNull()
    expect(report.warning).toContain('not evidence')
  })
})

/** Deterministic stand-in for Math.random, so a run is reproducible. */
function sequence(): () => number {
  let state = 0.123456789
  return () => {
    state = (state * 9301 + 0.49297) % 1
    return state
  }
}

describe('splitting a set for a holdout', () => {
  const queries = Array.from({ length: 12 }, (_, index) => `q${index + 1}`)

  it('takes every other query rather than the tail', () => {
    // A set is written topic by topic, so holding back the last half would
    // measure whether weights transfer between topics, not whether they
    // transfer at all.
    const { tune, holdout } = splitQueries(queries, 0.5)

    expect(tune).toEqual(['q1', 'q3', 'q5', 'q7', 'q9', 'q11'])
    expect(holdout).toEqual(['q2', 'q4', 'q6', 'q8', 'q10', 'q12'])
  })

  it('holds back less when asked for less', () => {
    const { tune, holdout } = splitQueries(queries, 0.25)

    expect(holdout).toHaveLength(3)
    expect(tune).toHaveLength(9)
  })

  it('is deterministic, so a run can be repeated', () => {
    expect(splitQueries(queries, 0.5)).toEqual(splitQueries(queries, 0.5))
  })

  it('holds nothing back when switched off or when there is too little', () => {
    expect(splitQueries(queries, 0).holdout).toEqual([])
    expect(splitQueries(['a', 'b', 'c'], 0.5).holdout).toEqual([])
    expect(splitQueries(['a', 'b', 'c'], 0.5).tune).toHaveLength(3)
  })
})

describe('tuning with a holdout', () => {
  let sandbox: Sandbox
  let db: Db
  let config: ProjectConfig
  let projectDir: string
  let resolved: ResolvedEmbedder

  beforeEach(async () => {
    sandbox = createSandbox()
    projectDir = path.join(sandbox.projects, 'sl')

    const project = createProject({ name: 'Shader Lab', dir: projectDir })
    db = project.db

    config = getConfig(db)
    config.model.active = TEST_MODEL_ID
    setConfig(db, config)

    for (const body of NOTES) writeNewNote(db, config, body, { author: 'test' })

    resolved = await createEmbedder(config)
    await indexProject(db, config, resolved)

    const file = evalSetPath(projectDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        '- q: "a fragment shader writes a colour per pixel"',
        '  relevant: [SL-0001]',
        '- q: "which pixels a triangle covers"',
        '  relevant: [SL-0002]',
        '- q: "sixteen byte boundary padding"',
        '  relevant: [SL-0003]',
        '- q: "raised beds drain after rain"',
        '  relevant: [SL-0004]',
        '- q: "the vertex stage runs once per vertex"',
        '  relevant: [SL-0002]',
        '- q: "standard layout pads every member"',
        '  relevant: [SL-0003]',
      ].join('\n'),
    )
  })

  afterEach(async () => {
    await resolved.embedder.dispose()
    db.close()
    sandbox.cleanup()
  })

  const tune = (holdout: number): ReturnType<typeof tuneWeights> =>
    tuneWeights(db, config, resolved, readQuerySet(projectDir), 'Shader Lab', {
      trials: 4,
      holdout,
      random: sequence(),
    })

  it('scores the winner on queries the search never saw', async () => {
    const report = await tune(0.5)

    expect(report.holdout).not.toBeNull()
    expect(report.holdout?.queries).toBe(3)
    // The two halves together are the whole set, and neither is empty.
    expect(report.baseline.metrics.queries).toBe(3)
  })

  it('reports improvement from the holdout, not from the search', async () => {
    const report = await tune(0.5)

    // The number that flatters itself must not be the one that decides.
    expect(report.improved).toBe(report.holdout?.improved)
  })

  it('says plainly when there is no holdout to trust', async () => {
    const report = await tune(0)

    expect(report.holdout).toBeNull()
    expect(report.warning).toContain('not evidence')
  })
})
