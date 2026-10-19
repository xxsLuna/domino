/**
 * The fetch behind every outbound call: LLM providers, the app's [api]
 * backend, the login endpoint and remote .domino files.
 *
 * Browsers enforce CORS, so the web build keeps the platform fetch (plus its
 * dev proxy for providers that ignore preflights). A desktop app shouldn't
 * depend on a provider answering CORS preflights, so the Electron shell swaps
 * in a fetch that runs in its main process (see `bridgedFetch`).
 */

let impl: typeof fetch = (input, init) => globalThis.fetch(input, init)

export const httpFetch: typeof fetch = (input, init) => impl(input, init)

export function setHttpFetch(next: typeof fetch): void {
  impl = next
}

/** A request as it crosses the shell boundary (plain, cloneable data). */
export interface NetRequest {
  method: string
  headers: Array<[string, string]>
  body?: string
}

/** Response events streamed back for one request, in order. */
export type NetEvent =
  | { type: 'head'; status: number; statusText: string; headers: Array<[string, string]> }
  | { type: 'chunk'; text: string }
  | { type: 'end' }
  | { type: 'error'; message: string }

/**
 * Fire one request and receive its events. Returns an optional cancel function
 * the caller can invoke (via AbortSignal) to stop the remote fetch early.
 */
export type NetTransport = (
  url: string,
  req: NetRequest,
  onEvent: (e: NetEvent) => void
) => void | (() => void)

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Read a response body as text, stopping at `maxChars` and cancelling the
 * stream so a huge or endless body can't exhaust memory. Results of length
 * >= maxChars were truncated.
 */
export async function readTextCapped(res: Response, maxChars: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
      if (out.length >= maxChars) {
        await reader.cancel().catch(() => {})
        return `${out.slice(0, maxChars)}\n…[response truncated]`
      }
    }
    return out + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/**
 * Adapt an event-based transport (IPC to a shell process) into `fetch`.
 * Bodies are streamed as they arrive, so SSE keeps working. Text bodies only
 * — everything this goes through is JSON or event streams. Anything the
 * transport can't carry (non-http URLs, binary bodies) uses the platform fetch.
 *
 * Honors `init.signal`: an abort rejects a pending request, errors an open
 * stream, and asks the transport to stop the remote fetch (no connection leak).
 */
export function bridgedFetch(transport: NetTransport): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init)
    const body = init?.body
    if (!/^https?:/i.test(request.url) || (body !== undefined && body !== null && typeof body !== 'string')) {
      return globalThis.fetch(input, init)
    }
    const signal = init?.signal ?? null
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    return new Promise<Response>((resolve, reject) => {
      const encoder = new TextEncoder()
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) })
      let headSeen = false
      let finished = false

      const cancel = transport(
        request.url,
        { method: request.method, headers: [...request.headers], body: body ?? undefined },
        (e) => {
          switch (e.type) {
            case 'head':
              headSeen = true
              resolve(
                new Response(NULL_BODY_STATUS.has(e.status) ? null : stream, {
                  status: e.status,
                  statusText: e.statusText,
                  headers: e.headers
                })
              )
              break
            case 'chunk':
              // The consumer may have cancelled the stream; a late chunk then
              // throws, and the transport learns about it via net:cancel.
              try {
                controller.enqueue(encoder.encode(e.text))
              } catch {
                cancel?.()
              }
              break
            case 'end':
              finished = true
              signal?.removeEventListener('abort', onAbort)
              try {
                controller.close()
              } catch {
                /* already errored */
              }
              break
            case 'error':
              finished = true
              signal?.removeEventListener('abort', onAbort)
              // Same shape as a browser network failure.
              try {
                if (headSeen) controller.error(new TypeError(e.message))
                else reject(new TypeError(e.message))
              } catch {
                /* already settled */
              }
              break
          }
        }
      )

      function onAbort(): void {
        if (finished) return
        finished = true
        cancel?.()
        const reason = abortReason(signal!)
        if (!headSeen) reject(reason)
        else {
          try {
            controller.error(reason)
          } catch {
            /* already settled */
          }
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
