/** Minimal SSE (text/event-stream) reader over fetch responses, plus the guarded request that opens one. */

import { httpFetch, readTextCapped } from '../net'
import { LLMRequestError, abortReason, parseRetryAfter } from './retry'
import { LLM_IDLE_TIMEOUT_MS, LLM_TIMEOUT_MS } from './types'

/** A single SSE line beyond this is pathological — stop buffering it. */
const MAX_LINE_CHARS = 1_000_000

/** Raised when a request goes silent for longer than the idle window. */
export class LLMStallError extends Error {
  constructor(idleMs: number) {
    super(`LLM stream stalled: no data for ${Math.round(idleMs / 1000)}s`)
    this.name = 'LLMStallError'
  }
}

export interface StreamGuard {
  /** Caller cancellation and the timeouts in one signal. */
  signal: AbortSignal
  /** Silence window for the body (see sseData). */
  idleMs: number
  /** Drop the timers and the caller-signal listener once the stream is done. */
  release(): void
}

export interface OpenStreamOptions {
  signal?: AbortSignal
  idleMs?: number
  timeoutMs?: number
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts — transports
 * that ignore the signal (a stubbed fetch, an IPC bridge mid-handshake)
 * still release the caller promptly.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/**
 * POST a streaming request and return its successful response.
 *
 * One controller carries every way the request can end early: the caller's
 * signal (abort reason passed through), the hard cap (LLM_TIMEOUT_MS for the
 * whole stream) and the idle window while waiting for headers. A non-2xx
 * status becomes an LLMRequestError (retryable per RETRYABLE_STATUS, with
 * the provider's retry-after hint); a network failure becomes a retryable
 * one. The caller must `release()` the guard when it stops reading.
 */
export async function openStream(
  url: string,
  init: { headers: Record<string, string>; body: string },
  opts: OpenStreamOptions = {}
): Promise<{ res: Response; guard: StreamGuard }> {
  const idleMs = opts.idleMs ?? LLM_IDLE_TIMEOUT_MS
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS
  const ctl = new AbortController()
  const caller = opts.signal
  const onCallerAbort = (): void => ctl.abort(abortReason(caller!))
  if (caller?.aborted) throw abortReason(caller)
  caller?.addEventListener('abort', onCallerAbort, { once: true })
  const hardTimer = setTimeout(
    () =>
      ctl.abort(
        new LLMRequestError(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s`)
      ),
    timeoutMs
  )
  const guard: StreamGuard = {
    signal: ctl.signal,
    idleMs,
    release: () => {
      clearTimeout(hardTimer)
      caller?.removeEventListener('abort', onCallerAbort)
    }
  }

  const headerTimer = setTimeout(() => ctl.abort(new LLMStallError(idleMs)), idleMs)
  let res: Response
  try {
    res = await raceAbort(
      httpFetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: ctl.signal
      }),
      ctl.signal
    )
  } catch (err) {
    guard.release()
    if (ctl.signal.aborted) throw abortReason(ctl.signal)
    const msg = err instanceof Error ? err.message : String(err)
    throw new LLMRequestError(`LLM request failed: network error — ${msg}`, { retryable: true })
  } finally {
    clearTimeout(headerTimer)
  }
  if (!res.ok) {
    const retryAfterMs = parseRetryAfter(res.headers)
    let detail: string
    try {
      detail = await readError(res)
    } finally {
      guard.release()
    }
    throw new LLMRequestError(`LLM request failed: ${detail}`, { status: res.status, retryAfterMs })
  }
  return { res, guard }
}

/**
 * One body read that gives up after `idleMs` of silence or when `signal`
 * aborts. The pending read is left to the reader's cancel in sseData's
 * cleanup; its eventual settlement is swallowed here.
 */
function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal: AbortSignal | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      reject(new LLMStallError(idleMs))
    }, idleMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (r) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(r)
      },
      (e) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

export interface SseOptions {
  /** Fail when no bytes arrive for this long (default LLM_IDLE_TIMEOUT_MS). */
  idleMs?: number
  /** Stop reading as soon as this aborts (its reason is thrown). */
  signal?: AbortSignal
}

function* dataLines(lines: string[]): Generator<string> {
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    yield payload
  }
}

export async function* sseData(res: Response, opts: SseOptions = {}): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('response has no body')
  const idleMs = opts.idleMs ?? LLM_IDLE_TIMEOUT_MS
  const signal = opts.signal
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await readWithin(reader, idleMs, signal)
      } catch (err) {
        if (signal?.aborted) throw abortReason(signal)
        if (err instanceof LLMStallError) throw err
        // The connection dropped mid-body. Retryable only while no delta has
        // reached the consumer — withRetry decides.
        const msg = err instanceof Error ? err.message : String(err)
        throw new LLMRequestError(`LLM stream interrupted: ${msg}`, { retryable: true })
      }
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length > MAX_LINE_CHARS && !buffer.includes('\n')) {
        throw new Error('SSE stream sent an oversized line')
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      yield* dataLines(lines)
    }
    // A final event without a trailing newline is still an event.
    buffer += decoder.decode()
    if (buffer) yield* dataLines([buffer])
  } finally {
    // If the consumer stops early (superseded turn), cancel so the HTTP
    // connection closes instead of downloading into the void; a no-op when
    // the stream already ended.
    await reader.cancel().catch(() => {})
    try {
      reader.releaseLock()
    } catch {
      /* a read is still pending on an older runtime — the cancel above ends it */
    }
  }
}

/** Read an error body with a size cap — it ends up in a user-facing message. */
export async function readError(res: Response): Promise<string> {
  let detail = ''
  try {
    detail = await readTextCapped(res, 8_192)
  } catch {
    /* ignore */
  }
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } }
    detail = parsed.error?.message ?? detail
  } catch {
    /* keep raw */
  }
  return `${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ''}`
}
