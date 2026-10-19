/** Minimal SSE (text/event-stream) reader over fetch responses. */

import { readTextCapped } from '../net'

/** A single SSE line beyond this is pathological — stop buffering it. */
const MAX_LINE_CHARS = 1_000_000

export async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('response has no body')
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_LINE_CHARS && !buffer.includes('\n')) {
        throw new Error('SSE stream sent an oversized line')
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        yield payload
      }
    }
  } finally {
    // If the consumer stops early (superseded turn), cancel so the HTTP
    // connection closes instead of downloading into the void; a no-op when
    // the stream already ended.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
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
