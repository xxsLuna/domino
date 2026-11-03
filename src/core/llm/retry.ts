/**
 * Transient-failure handling for LLM requests.
 *
 * Providers shed load with 429/529 and drop connections; a turn that fails
 * on the first such blip is a blank screen for the user. A request is
 * retried only while nothing has reached the consumer yet — once a delta
 * was yielded, a replay would duplicate text and tool calls, so a failure
 * mid-stream always surfaces.
 */

/** Statuses worth a second try: timeouts, conflicts, rate limits, overload, gateway errors. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 529
])

/** Retries after the first attempt. */
export const LLM_RETRIES = 2

/** Longest single backoff — a provider asking for a minute gets 8s and one more try. */
export const MAX_RETRY_DELAY_MS = 8_000

const BASE_RETRY_DELAY_MS = 500

/**
 * A failed LLM request. `retryable` marks transient failures (status above,
 * network errors, provider overload reported before any output);
 * `retryAfterMs` carries the provider's own backoff hint.
 */
export class LLMRequestError extends Error {
  readonly status?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}
  ) {
    super(message)
    this.name = 'LLMRequestError'
    this.status = opts.status
    this.retryable =
      opts.retryable ?? (opts.status !== undefined && RETRYABLE_STATUS.has(opts.status))
    this.retryAfterMs = opts.retryAfterMs
  }
}

/**
 * The provider's backoff hint in ms: `retry-after-ms`, else `retry-after` as
 * seconds or an HTTP date. Undefined when absent or unparseable.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms')
  if (ms !== null && ms.trim() !== '') {
    const n = Number(ms)
    if (Number.isFinite(n) && n >= 0) return n
  }
  const raw = headers.get('retry-after')
  if (raw === null || raw.trim() === '') return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : undefined
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/**
 * Wait before retry number `attempt` (0-based): the provider's hint when it
 * gave one, else jittered exponential backoff (0.5–1s, 1–2s, …) — always
 * capped at MAX_RETRY_DELAY_MS.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random
): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS)
  }
  const base = BASE_RETRY_DELAY_MS * 2 ** attempt
  return Math.min(base + random() * base, MAX_RETRY_DELAY_MS)
}

export function isRetryableError(err: unknown): err is LLMRequestError {
  return err instanceof LLMRequestError && err.retryable
}

/** The reason an aborted signal carries (or a standard AbortError). */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/** Sleep that rejects as soon as `signal` aborts — a cancelled turn never waits out a backoff. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RetryOptions {
  signal?: AbortSignal
  retries?: number
  /** Test seam; defaults to the abortable sleep above. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Run a streaming attempt, re-running it on a retryable failure that happens
 * before its first item was yielded. Anything after the first item — and any
 * failure once `signal` aborted — propagates unchanged.
 */
export async function* withRetry<T>(
  attempt: () => AsyncIterable<T>,
  opts: RetryOptions = {}
): AsyncGenerator<T> {
  const retries = opts.retries ?? LLM_RETRIES
  const wait = opts.wait ?? sleep
  for (let n = 0; ; n++) {
    let yielded = false
    try {
      for await (const item of attempt()) {
        yielded = true
        yield item
      }
      return
    } catch (err) {
      if (yielded || opts.signal?.aborted || n >= retries || !isRetryableError(err)) throw err
      await wait(retryDelayMs(n, err.retryAfterMs), opts.signal)
    }
  }
}
