import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgedFetch, httpFetch, setHttpFetch, type NetEvent, type NetRequest } from './net'

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
  vi.restoreAllMocks()
})

/** A fake shell transport that replays scripted events asynchronously. */
function transport(events: NetEvent[], seen: Array<{ url: string; req: NetRequest }> = []) {
  return (url: string, req: NetRequest, onEvent: (e: NetEvent) => void) => {
    seen.push({ url, req })
    let i = 0
    const tick = (): void => {
      if (i >= events.length) return
      onEvent(events[i++])
      setTimeout(tick, 0)
    }
    setTimeout(tick, 0)
  }
}

describe('bridgedFetch', () => {
  it('forwards method, headers and body, and streams the response', async () => {
    const seen: Array<{ url: string; req: NetRequest }> = []
    const f = bridgedFetch(
      transport(
        [
          {
            type: 'head',
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'text/event-stream']]
          },
          { type: 'chunk', text: 'data: {"a":1}\n\n' },
          { type: 'chunk', text: 'data: [DONE]\n\n' },
          { type: 'end' }
        ],
        seen
      )
    )
    const res = await f('https://llm.example/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      body: '{"x":1}'
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: {"a":1}\n\ndata: [DONE]\n\n')
    expect(seen[0].url).toBe('https://llm.example/v1/chat/completions')
    expect(seen[0].req.method).toBe('POST')
    expect(seen[0].req.body).toBe('{"x":1}')
    expect(Object.fromEntries(seen[0].req.headers)).toMatchObject({ authorization: 'Bearer k' })
  })

  it('rejects like a browser network error when the request fails', async () => {
    const f = bridgedFetch(transport([{ type: 'error', message: 'net::ERR_NAME_NOT_RESOLVED' }]))
    await expect(f('https://nowhere.invalid/x')).rejects.toThrow(TypeError)
  })

  it('keeps HTTP errors as responses', async () => {
    const f = bridgedFetch(
      transport([
        { type: 'head', status: 401, statusText: 'Unauthorized', headers: [] },
        { type: 'chunk', text: '{"error":"bad key"}' },
        { type: 'end' }
      ])
    )
    const res = await f('https://llm.example/v1/x')
    expect(res.ok).toBe(false)
    expect(await res.json()).toEqual({ error: 'bad key' })
  })

  it('leaves non-http URLs to the platform fetch', async () => {
    const native = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const t = vi.fn()
    await bridgedFetch(t)('data:text/plain,hi')
    expect(t).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalled()
  })
})

describe('httpFetch', () => {
  it('uses the swapped-in implementation', async () => {
    const impl = vi.fn().mockResolvedValue(new Response('swapped'))
    setHttpFetch(impl)
    expect(await (await httpFetch('https://a.example')).text()).toBe('swapped')
    expect(impl).toHaveBeenCalledOnce()
  })
})

describe('routingHeaders', () => {
  it('adds a stable opencode session id only for opencode hosts', async () => {
    const { routingHeaders } = await import('./llm/routing')
    const a = routingHeaders('https://opencode.ai/zen/go/v1')
    expect(a['x-opencode-session']).toMatch(/\S{8,}/)
    expect(routingHeaders('https://opencode.ai/zen/v1')).toEqual(a)
    expect(routingHeaders('https://api.openai.com/v1')).toEqual({})
    // proxy-relative bases carry the marker the vite /zen CSRF gate requires
    expect(routingHeaders('/zen/v1')).toEqual({ 'x-domino-client': 'domino-web' })
  })
})
