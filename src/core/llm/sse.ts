/** Minimal SSE (text/event-stream) reader over fetch responses. */

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
    reader.releaseLock()
  }
}

export async function readError(res: Response): Promise<string> {
  let detail = ''
  try {
    detail = await res.text()
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
