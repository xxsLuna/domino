import { describe, expect, it } from 'vitest'
import {
  LLMRequestError,
  MAX_RETRY_DELAY_MS,
  parseRetryAfter,
  retryDelayMs,
  sleep,
  withRetry
} from './retry'

describe('parseRetryAfter', () => {
  it('reads retry-after-ms, seconds and HTTP dates', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '250' }))).toBe(250)
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }))).toBe(3_000)
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(
      parseRetryAfter(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' }), now)
    ).toBe(5_000)
  })

  it('is undefined when absent or garbage', () => {
    expect(parseRetryAfter(new Headers())).toBeUndefined()
    expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }))).toBeUndefined()
  })
})

describe('retryDelayMs', () => {
  it('honors the provider hint, capped at 8s', () => {
    expect(retryDelayMs(0, 1_200)).toBe(1_200)
    expect(retryDelayMs(0, 60_000)).toBe(MAX_RETRY_DELAY_MS)
  })

  it('backs off exponentially with jitter', () => {
    expect(retryDelayMs(0, undefined, () => 0)).toBe(500)
    expect(retryDelayMs(0, undefined, () => 1)).toBe(1_000)
    expect(retryDelayMs(1, undefined, () => 0)).toBe(1_000)
    expect(retryDelayMs(10, undefined, () => 1)).toBe(MAX_RETRY_DELAY_MS)
  })
})

describe('LLMRequestError', () => {
  it('derives retryability from the status', () => {
    for (const s of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
      expect(new LLMRequestError('x', { status: s }).retryable, String(s)).toBe(true)
    }
    for (const s of [400, 401, 403, 404, 413, 422]) {
      expect(new LLMRequestError('x', { status: s }).retryable, String(s)).toBe(false)
    }
  })
})

const noWait = async (): Promise<void> => {}

/** An attempt that fails before yielding anything, counting its runs. */
function failing(err: () => unknown, onRun: () => void = () => {}): () => AsyncIterable<number> {
  return () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        onRun()
        throw err()
      }
    })
  })
}

describe('withRetry', () => {
  it('re-runs a transient failure that happened before the first item', async () => {
    let calls = 0
    async function* attempt(): AsyncGenerator<number> {
      calls++
      if (calls < 3) throw new LLMRequestError('busy', { status: 529 })
      yield 1
    }
    const out: number[] = []
    for await (const n of withRetry(attempt, { wait: noWait })) out.push(n)
    expect(out).toEqual([1])
    expect(calls).toBe(3)
  })

  it('never retries once an item was yielded', async () => {
    let calls = 0
    async function* attempt(): AsyncGenerator<number> {
      calls++
      yield 1
      throw new LLMRequestError('dropped', { retryable: true })
    }
    const out: number[] = []
    await expect(async () => {
      for await (const n of withRetry(attempt, { wait: noWait })) out.push(n)
    }).rejects.toThrow('dropped')
    expect(out).toEqual([1])
    expect(calls).toBe(1)
  })

  it('does not retry permanent errors or plain exceptions', async () => {
    for (const err of [new LLMRequestError('bad', { status: 400 }), new Error('bug')]) {
      let calls = 0
      const attempt = failing(
        () => err,
        () => calls++
      )
      await expect(async () => {
        for await (const _ of withRetry(attempt, { wait: noWait })) void _
      }).rejects.toBe(err)
      expect(calls).toBe(1)
    }
  })

  it('stops after the retry budget', async () => {
    let calls = 0
    const attempt = failing(
      () => new LLMRequestError('busy', { status: 503 }),
      () => calls++
    )
    await expect(async () => {
      for await (const _ of withRetry(attempt, { wait: noWait, retries: 2 })) void _
    }).rejects.toThrow('busy')
    expect(calls).toBe(3)
  })

  it('aborts during the backoff instead of waiting it out', async () => {
    const ctl = new AbortController()
    const attempt = failing(() => new LLMRequestError('busy', { status: 429, retryAfterMs: 8_000 }))
    const started = Date.now()
    setTimeout(() => ctl.abort(new Error('cancelled')), 10)
    await expect(async () => {
      for await (const _ of withRetry(attempt, { signal: ctl.signal })) void _
    }).rejects.toThrow('cancelled')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('sleep', () => {
  it('rejects immediately for an aborted signal', async () => {
    const ctl = new AbortController()
    ctl.abort(new Error('now'))
    await expect(sleep(10_000, ctl.signal)).rejects.toThrow('now')
  })
})
