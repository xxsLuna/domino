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

export type NetTransport = (url: string, req: NetRequest, onEvent: (e: NetEvent) => void) => void

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

/**
 * Adapt an event-based transport (IPC to a shell process) into `fetch`.
 * Bodies are streamed as they arrive, so SSE keeps working. Text bodies only
 * — everything this goes through is JSON or event streams. Anything the
 * transport can't carry (non-http URLs, binary bodies) uses the platform fetch.
 */
export function bridgedFetch(transport: NetTransport): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init)
    const body = init?.body
    if (!/^https?:/i.test(request.url) || (body !== undefined && body !== null && typeof body !== 'string')) {
      return globalThis.fetch(input, init)
    }
    return new Promise<Response>((resolve, reject) => {
      const encoder = new TextEncoder()
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) })
      let headSeen = false
      transport(
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
              controller.enqueue(encoder.encode(e.text))
              break
            case 'end':
              controller.close()
              break
            case 'error':
              // Same shape as a browser network failure.
              if (headSeen) controller.error(new TypeError(e.message))
              else reject(new TypeError(e.message))
              break
          }
        }
      )
    })
  }
}
