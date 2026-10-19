import { describe, expect, it } from 'vitest'
import {
  CREEP_CEIL,
  CREEP_MS,
  DEFAULT_SPEC_CHARS,
  STREAM_CEIL,
  nextSpecChars,
  renderProgress
} from './progress'

const wait = (elapsed: number, chars = 0, specChars = 0) =>
  renderProgress({ elapsed, chars, specChars })

describe('renderProgress waiting phase', () => {
  it('starts at 0 and creeps to the ceiling by CREEP_MS', () => {
    expect(wait(0)).toBe(0)
    expect(wait(CREEP_MS / 2)).toBeCloseTo(CREEP_CEIL / 2, 5)
    expect(wait(CREEP_MS)).toBeCloseTo(CREEP_CEIL, 5)
  })

  it('parks at the ceiling however long the wait runs', () => {
    expect(wait(CREEP_MS * 10)).toBe(CREEP_CEIL)
  })

  it('never goes negative on a clock that jumped backwards', () => {
    expect(wait(-500)).toBe(0)
  })
})

describe('renderProgress streaming phase', () => {
  it('uses the default spec size when nothing has finished yet', () => {
    const half = wait(0, DEFAULT_SPEC_CHARS / 2)
    expect(half).toBeCloseTo(CREEP_CEIL + 83 / 2, 5)
  })

  it('scales against the remembered spec size', () => {
    expect(wait(0, 500, 1000)).toBeCloseTo(CREEP_CEIL + 83 / 2, 5)
    expect(wait(0, 1000, 1000)).toBeCloseTo(CREEP_CEIL + 83, 5)
  })

  it('stops just short of 100 no matter how long the stream gets', () => {
    expect(wait(0, 10_000_000, 1000)).toBe(STREAM_CEIL)
    expect(wait(0, DEFAULT_SPEC_CHARS * 4)).toBe(STREAM_CEIL)
  })

  it('any streamed character clears the waiting ceiling', () => {
    expect(wait(CREEP_MS * 3, 1)).toBeGreaterThan(CREEP_CEIL)
  })
})

describe('nextSpecChars', () => {
  it('adopts the first measured length outright', () => {
    expect(nextSpecChars(0, 3210)).toBe(3210)
    expect(nextSpecChars(Number.NaN, 3210)).toBe(3210)
  })

  it('blends new measurements toward the new value', () => {
    expect(nextSpecChars(1000, 2000)).toBe(1300)
    expect(nextSpecChars(2000, 1000)).toBe(1700)
  })
})
