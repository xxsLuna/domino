import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { LLMRequestError } from './retry'
import { LLMStallError, openStream, sseData } from './sse'

/** A body that sends `first` and then goes silent forever. */
function stalled(first: string): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(first))
      }
    }),
    { status: 200 }
  )
}

async function drain(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const s of it) out.push(s)
  return out
}

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
})

describe('sseData', () => {
  it('yields data payloads, skipping [DONE] and other fields', async () => {
    const res = new Response('event: a\ndata: {"x":1}\n\ndata: [DONE]\n\n')
    expect(await drain(sseData(res))).toEqual(['{"x":1}'])
  })

  it('keeps a final event that lacks a trailing newline', async () => {
    expect(await drain(sseData(new Response('data: one\ndata: two')))).toEqual(['one', 'two'])
  })

  it('fails a stream that goes silent past the idle window', async () => {
    const out: string[] = []
    await expect(async () => {
      for await (const s of sseData(stalled('data: first\n'), { idleMs: 30 })) out.push(s)
    }).rejects.toBeInstanceOf(LLMStallError)
    expect(out).toEqual(['first'])
  })

  it('stops promptly on abort with the abort reason', async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(new Error('superseded')), 10)
    await expect(drain(sseData(stalled('data: a\n'), { signal: ctl.signal }))).rejects.toThrow(
      'superseded'
    )
  })

  it('turns a dropped connection into a retryable error', async () => {
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(new TypeError('socket hang up'))
        }
      })
    )
    const err = await drain(sseData(res)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LLMRequestError)
    expect((err as LLMRequestError).retryable).toBe(true)
  })
})

describe('openStream', () => {
  const INIT = { headers: {}, body: '{}' }

  it('maps a network failure to a retryable error', async () => {
    setHttpFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const err = await openStream('https://llm.test/x', INIT).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LLMRequestError)
    expect((err as LLMRequestError).retryable).toBe(true)
  })

  it('maps a status to an error carrying the retry-after hint', async () => {
    setHttpFetch(
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
    )
    const err = (await openStream('https://llm.test/x', INIT).catch(
      (e: unknown) => e
    )) as LLMRequestError
    expect(err.status).toBe(429)
    expect(err.retryable).toBe(true)
    expect(err.retryAfterMs).toBe(2_000)
    expect(err.message).toMatch(/^LLM request failed: 429/)
  })

  it('fails when no response headers arrive within the idle window', async () => {
    setHttpFetch(() => new Promise<Response>(() => {}))
    await expect(openStream('https://llm.test/x', INIT, { idleMs: 20 })).rejects.toBeInstanceOf(
      LLMStallError
    )
  })

  it('enforces the hard cap on the whole stream', async () => {
    setHttpFetch(async () => stalled('data: a\n'))
    const { res, guard } = await openStream('https://llm.test/x', INIT, { timeoutMs: 20 })
    try {
      await expect(drain(sseData(res, { signal: guard.signal }))).rejects.toThrow(/timed out/)
    } finally {
      guard.release()
    }
  })
})
