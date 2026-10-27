import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { executeApi, isAllowed, resolveEndpoint } from './api'
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDelta } from '../llm/types'
import { setHttpFetch } from '../net'
import { runAgentTurn, specFromArgs } from './engine'
import { extractPartialSpec, parsePartialJson } from './partialJson'

const BASE = 'https://api.example.com/v1'

describe('isAllowed (domino allow list)', () => {
  it('exact match', () => {
    expect(isAllowed('/login', ['/login', '/me'], BASE)).toBe(true)
    expect(isAllowed('/nope', ['/login'], BASE)).toBe(false)
  })

  it('trailing /* wildcard', () => {
    expect(isAllowed('/leads', ['/leads/*'], BASE)).toBe(true)
    expect(isAllowed('/leads/42', ['/leads/*'], BASE)).toBe(true)
    expect(isAllowed('/leads/42/stage', ['/leads/*'], BASE)).toBe(true)
    expect(isAllowed('/other/42', ['/leads/*'], BASE)).toBe(false)
  })

  it('stays on the base_url origin — other hosts are denied even with a matching path', () => {
    expect(isAllowed('https://api.example.com/login', ['/login'], BASE)).toBe(true)
    expect(isAllowed('https://evil.example.com/login', ['/login'], BASE)).toBe(false)
    expect(isAllowed('https://evil.example.com/v1/leads', ['/leads/*'], BASE)).toBe(false)
  })

  it('denies requests with no trusted origin (path-only pattern, no base_url)', () => {
    expect(isAllowed('/login', ['/login'])).toBe(false)
    expect(isAllowed('https://api.example.com/login', ['/login'])).toBe(false)
    expect(isAllowed('https://api.example.com/login', ['*'])).toBe(false)
  })

  it('origin-pinned patterns work without base_url', () => {
    const allow = ['https://api.example.com/*']
    expect(isAllowed('https://api.example.com/login', allow)).toBe(true)
    expect(isAllowed('https://other.example.com/login', allow)).toBe(false)
  })

  it('normalizes dot segments before matching', () => {
    expect(isAllowed('/leads/../../admin', ['/leads/*'], BASE)).toBe(false)
    expect(isAllowed('/leads/42/../43', ['/leads/*'], BASE)).toBe(true)
    expect(isAllowed('https://api.example.com/v1/leads/../../admin', ['/leads/*'], BASE)).toBe(
      false
    )
  })

  it('empty allow list denies everything', () => {
    expect(isAllowed('/login', [], BASE)).toBe(false)
  })
})

describe('executeApi feed support', () => {
  afterEach(() => {
    setHttpFetch((input, init) => globalThis.fetch(input, init))
  })
  beforeAll(() => {
    // node has no DOMParser; the XML auto-parse path needs one (see parse.test.ts).
    ;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser
  })

  const FEED_XML = '<?xml version="1.0"?><rss><channel><title>T</title><item><title>Post</title><link>https://feeds.example.com/1</link></item></channel></rss>'

  it('parses an XML feed body into compact JSON', async () => {
    setHttpFetch(async () =>
      new Response(FEED_XML, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    )
    const result = await executeApi(
      { baseUrl: BASE, allow: ['https://feeds.example.com/*'], token: null },
      { path: 'https://feeds.example.com/rss.xml' }
    )
    expect(result.status).toBe(200)
    expect(result.data).toEqual({
      title: 'T',
      items: [{ title: 'Post', link: 'https://feeds.example.com/1' }]
    })
  })

  it('keeps non-XML bodies that fail JSON parsing as raw text', async () => {
    setHttpFetch(async () => new Response('plain, not json, not xml', { status: 200 }))
    const result = await executeApi(
      { baseUrl: BASE, allow: ['/raw/*'], token: null },
      { path: '/raw/page' }
    )
    expect(result.data).toBe('plain, not json, not xml')
  })

  it('sends the login token to an allowed backend', async () => {
    let seenAuth: string | null = null
    setHttpFetch(async (_input, init) => {
      seenAuth = new Headers(init?.headers).get('authorization')
      return new Response('{}', { status: 200 })
    })
    await executeApi(
      { baseUrl: BASE, allow: ['/leads'], token: 'secret-token' },
      { path: '/leads' }
    )
    expect(seenAuth).toBe('Bearer secret-token')
  })
})

describe('resolveEndpoint', () => {
  it('joins base_url and path', () => {
    expect(resolveEndpoint('/leads', 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/leads'
    )
    expect(resolveEndpoint('leads', 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/leads'
    )
  })
  it('keeps absolute urls', () => {
    expect(resolveEndpoint('https://x.test/a', 'https://api.example.com')).toBe('https://x.test/a')
  })
  it('resolves dot segments against the base', () => {
    expect(resolveEndpoint('/v1/leads/../../admin', 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/admin'
    )
    expect(resolveEndpoint('leads/../billing', 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/billing'
    )
  })
  it('returns null for a relative path without a base', () => {
    expect(resolveEndpoint('/leads')).toBeNull()
  })
  it('returns null for unparseable urls', () => {
    expect(resolveEndpoint('https://')).toBeNull()
    expect(resolveEndpoint('/x', 'not a url')).toBeNull()
  })
})

describe('parsePartialJson', () => {
  it('parses complete json', () => {
    expect(parsePartialJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 })
  })
  it('closes unterminated objects/strings', () => {
    expect(parsePartialJson('{"a": "he')).toEqual({ a: 'he' })
    expect(parsePartialJson('{"a": {"b": 1')).toEqual({ a: { b: 1 } })
  })
  it('drops dangling commas/keys', () => {
    expect(parsePartialJson('{"a": 1,')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a": 1, "b"')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a": 1, "b":')).toEqual({ a: 1 })
  })
  it('keeps a value string mid-escape without breaking', () => {
    expect(parsePartialJson('{"a": "x\\')).toEqual({ a: 'x' })
    expect(parsePartialJson('{"a": "x\\u00')).toEqual({ a: 'x' })
    expect(parsePartialJson('{"a": "say \\"hi')).toEqual({ a: 'say "hi' })
  })
  it('closes nested arrays and objects mid-stream', () => {
    expect(parsePartialJson('{"a": [1, 2, {"b": "c')).toEqual({ a: [1, 2, { b: 'c' }] })
    expect(parsePartialJson('{"a": [1, tr')).toEqual({ a: [1] })
    expect(parsePartialJson('[{"a": 1}, {')).toEqual([{ a: 1 }, {}])
  })
  it('stays linear on long streams', () => {
    const big = JSON.stringify({
      rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `row ${i}` }))
    })
    const t0 = performance.now()
    for (let cut = 1000; cut < big.length; cut += 997) parsePartialJson(big.slice(0, cut))
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(parsePartialJson(big)).toEqual(JSON.parse(big))
  })
  it('returns null for hopeless input', () => {
    expect(parsePartialJson('not json')).toBeNull()
    expect(parsePartialJson('')).toBeNull()
  })
})

describe('extractPartialSpec', () => {
  it('extracts a nested spec mid-stream', () => {
    const args =
      '{"spec": {"version": 1, "page": "p1", "pages": [{"id": "p1", "name": "P", "layout": [{"name": "Heading", "props": {"text": "Hel'
    const parsed = extractPartialSpec(args) as { version: number; page: string } | null
    expect(parsed?.version).toBe(1)
    expect(parsed?.page).toBe('p1')
  })
  it('accepts a bare spec as the whole argument', () => {
    expect(extractPartialSpec('{"version": 1')).toEqual({ version: 1 })
  })
  it('returns null before any brace appears', () => {
    expect(extractPartialSpec('{"spe')).toBeNull()
  })
})

describe('string-encoded specs (some models stringify the spec argument)', () => {
  const inner = '{"version": 1, "page": "p", "pages": [{"id": "p", "name": "P", "layout": [{"name": "Heading", "props": {"text": "Hello"}}]}]}'
  const wrap = (spec: string): string => JSON.stringify({ spec })

  it('previews a stringified spec while it streams', () => {
    const args = wrap(inner).slice(0, 120)
    const parsed = extractPartialSpec(args) as { page?: string } | null
    expect(parsed?.page).toBe('p')
  })

  it('accepts the stringified spec', () => {
    const { spec, repaired } = specFromArgs(wrap(inner))
    expect((spec as { page: string }).page).toBe('p')
    expect(repaired).toBe(true)
  })

  it('salvages a bracket too many or too few inside the string', () => {
    const extra = specFromArgs(wrap(inner + ']')).spec as { pages: unknown[] }
    expect(extra.pages).toHaveLength(1)
    const missing = specFromArgs(wrap(inner.slice(0, -1))).spec as { pages: unknown[] }
    expect(missing.pages).toHaveLength(1)
  })

  it('takes a plain object spec as is', () => {
    expect(specFromArgs(JSON.stringify({ spec: JSON.parse(inner) }))).toEqual({
      spec: JSON.parse(inner),
      repaired: false
    })
    expect(specFromArgs('not json').spec).toBeNull()
  })
})

describe('runAgentTurn with a misbehaving model', () => {
  const inner = '{"version": 1, "page": "p", "pages": [{"id": "p", "name": "P", "layout": [{"name": "Heading", "props": {"text": "Hello"}}]}]}'
  /** Replies with one render_ui call per request, taken from `replies` in order. */
  const fakeAdapter = (replies: string[], seen: ChatRequest[] = []): LLMAdapter => ({
    async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      seen.push({ ...req, messages: [...req.messages] })
      const args = replies.shift() ?? '{}'
      const id = `call-${seen.length}`
      yield { type: 'tool_call_start', id, name: 'render_ui' }
      yield { type: 'tool_call_args', id, argsDelta: args }
      yield { type: 'tool_call_end', id }
      yield { type: 'done' }
    }
  })
  const run = async (adapter: LLMAdapter, history: ChatMessage[]) => {
    const updates = []
    for await (const u of runAgentTurn({ adapter, system: 's', history, api: { allow: [], token: null } }))
      updates.push(u)
    return updates
  }

  it('renders a stringified spec and keeps the object form in history', async () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const updates = await run(fakeAdapter([JSON.stringify({ spec: inner + ']' })]), history)
    expect(updates.some((u) => u.type === 'spec' && u.final)).toBe(true)
    const call = history.find((m) => m.role === 'assistant')?.toolCalls?.[0]
    expect(typeof JSON.parse(call!.args).spec).toBe('object')
  })

  it('retries once with the validation error instead of giving up', async () => {
    const seen: ChatRequest[] = []
    const bad = JSON.stringify({ spec: { version: 1, page: 'p', pages: [] } })
    const updates = await run(fakeAdapter([bad, JSON.stringify({ spec: JSON.parse(inner) })], seen), [
      { role: 'user', content: 'go' }
    ])
    expect(seen).toHaveLength(2)
    expect(seen[1].messages.at(-1)?.content).toMatch(/invalid UiSpec — pages/)
    expect(updates.some((u) => u.type === 'spec' && u.final)).toBe(true)
    expect(updates.some((u) => u.type === 'error')).toBe(false)
  })

  it('asks again when the model replies without any tool call', async () => {
    const seen: ChatRequest[] = []
    const replies = ['', JSON.stringify({ spec: JSON.parse(inner) })]
    const adapter: LLMAdapter = {
      async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
        seen.push({ ...req, messages: [...req.messages] })
        const args = replies.shift()
        if (args) {
          yield { type: 'tool_call_start', id: 'r', name: 'render_ui' }
          yield { type: 'tool_call_args', id: 'r', argsDelta: args }
        }
        yield { type: 'done' }
      }
    }
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const updates = await run(adapter, history)
    expect(seen).toHaveLength(2)
    expect(seen[1].messages.at(-1)?.content).toMatch(/Call render_ui now/)
    expect(updates.some((u) => u.type === 'spec' && u.final)).toBe(true)
    // The empty reply is not recorded as an (invalid) empty assistant message.
    expect(history.filter((m) => m.role === 'assistant' && !m.content && !m.toolCalls)).toHaveLength(0)
  })

  it('says so when a turn ends without a screen', async () => {
    const adapter: LLMAdapter = {
      async *chat(): AsyncIterable<StreamDelta> {
        yield { type: 'done' }
      }
    }
    const updates = await run(adapter, [{ role: 'user', content: 'go' }])
    expect(updates.filter((u) => u.type === 'error').map((u) => (u as { message: string }).message)).toEqual([
      'The model ended its turn without rendering a screen.'
    ])
  })

  it('reports an error after the retry also fails', async () => {
    const bad = JSON.stringify({ spec: { version: 1, page: 'p', pages: [] } })
    const updates = await run(fakeAdapter([bad, bad]), [{ role: 'user', content: 'go' }])
    expect(updates.filter((u) => u.type === 'error')).toHaveLength(1)
  })
})

describe('history after render_ui', () => {
  it('records the validated spec in contract key order', async () => {
    const messy = JSON.stringify({
      spec: { page: 'p', pages: [{ id: 'p', name: 'P', layout: [{ name: 'Card', id: 'c', props: { title: 'T' }, grid: { x: 0, y: 0, w: 12, h: 0 } }] }] }
    })
    const adapter: LLMAdapter = {
      async *chat(): AsyncIterable<StreamDelta> {
        yield { type: 'tool_call_start', id: 'c1', name: 'render_ui' }
        yield { type: 'tool_call_args', id: 'c1', argsDelta: messy }
        yield { type: 'done' }
      }
    }
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    for await (const _ of runAgentTurn({ adapter, system: 's', history, api: { allow: [] } })) void _
    const { spec } = JSON.parse(history.find((m) => m.role === 'assistant')!.toolCalls![0].args)
    expect(Object.keys(spec)).toEqual(['version', 'page', 'pages'])
    expect(Object.keys(spec.pages[0].layout[0])).toEqual(['name', 'id', 'grid', 'props'])
    expect(spec.pages[0].layout[0].grid.h).toBe(1)
  })
})

describe('call_api schema memory', () => {
  const SPEC = '{"version": 1, "page": "p", "pages": [{"id": "p", "name": "P", "layout": [{"name": "Heading", "props": {"text": "Hi"}}]}]}'
  const API = { allow: ['/leads'], baseUrl: 'https://api.example.com/v1', token: null }

  /** call_api first, then render_ui — the two-iteration shape of a data screen. */
  const twoRoundAdapter = (seen: ChatRequest[]): LLMAdapter => {
    let round = 0
    return {
      async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
        seen.push({ ...req, messages: [...req.messages] })
        const id = `c${round}`
        yield round++ === 0
          ? { type: 'tool_call_start', id, name: 'call_api' }
          : { type: 'tool_call_start', id, name: 'render_ui' }
        yield {
          type: 'tool_call_args',
          id,
          argsDelta:
            round === 1
              ? JSON.stringify({ path: '/leads', method: 'GET' })
              : JSON.stringify({ spec: JSON.parse(SPEC) })
        }
        yield { type: 'tool_call_end', id }
        yield { type: 'done' }
      }
    }
  }

  const serveJson = (status: number, body: unknown): void => {
    setHttpFetch(async () => new Response(JSON.stringify(body), { status }))
  }

  const run = async (
    knownSchemas?: Record<string, Record<string, string>>
  ): Promise<{ updates: Awaited<ReturnType<typeof collect>>; seen: ChatRequest[] }> => {
    const seen: ChatRequest[] = []
    const history: ChatMessage[] = [{ role: 'user', content: 'show leads' }]
    const updates = await collect(
      runAgentTurn({
        adapter: twoRoundAdapter(seen),
        system: 's',
        history,
        api: API,
        knownSchemas
      })
    )
    return { updates, seen }
  }

  async function collect(
    gen: AsyncGenerator<unknown, void, undefined>
  ): Promise<Array<Record<string, any>>> {
    const out: Array<Record<string, any>> = []
    for await (const u of gen) out.push(u as Record<string, any>)
    return out
  }

  afterEach(() => {
    setHttpFetch((input, init) => globalThis.fetch(input, init))
  })

  it('attaches the response shape to api_result and the tool result', async () => {
    serveJson(200, { id: 1, name: 'Lead' })
    const { updates, seen } = await run()
    const api = updates.find((u) => u.type === 'api_result')!
    expect(api.schema).toEqual({ id: 'number', name: 'string' })
    expect(api.schemaChanged).toBeUndefined()
    const tool = seen[1].messages.find((m) => m.role === 'tool')!
    expect(JSON.parse(tool!.content as string)).toEqual({
      status: 200,
      data: { id: 1, name: 'Lead' }
    })
  })

  it('flags _schemaChange when the response has keys the memory lacks', async () => {
    serveJson(200, { id: 1, name: 'Lead', email: 'x' })
    const { updates, seen } = await run({ 'GET /leads': { id: 'number', legacy: 'boolean' } })
    const api = updates.find((u) => u.type === 'api_result')!
    expect(api.schemaChanged).toEqual({ added: ['name', 'email'], removed: ['legacy'], changed: [] })
    const tool = seen[1].messages.find((m) => m.role === 'tool')!
    const parsed = JSON.parse(tool!.content as string)
    expect(parsed._schemaChange).toEqual({
      added: ['name', 'email'],
      removed: ['legacy'],
      changed: []
    })
    expect(parsed.data.email).toBe('x')
  })

  it('stays quiet when the shape matches the memory', async () => {
    serveJson(200, { id: 1, name: 'Lead' })
    const { updates, seen } = await run({ 'GET /leads': { id: 'number', name: 'string' } })
    const api = updates.find((u) => u.type === 'api_result')!
    expect(api.schemaChanged).toBeUndefined()
    const tool = seen[1].messages.find((m) => m.role === 'tool')!
    expect(JSON.parse(tool!.content as string)).not.toHaveProperty('_schemaChange')
  })

  it('never records error responses as the endpoint shape', async () => {
    serveJson(500, { error: 'boom' })
    const { updates, seen } = await run({ 'GET /leads': { id: 'number' } })
    const api = updates.find((u) => u.type === 'api_result')!
    expect(api.schema).toBeUndefined()
    expect(api.schemaChanged).toBeUndefined()
    const tool = seen[1].messages.find((m) => m.role === 'tool')!
    expect(JSON.parse(tool!.content as string)).not.toHaveProperty('_schemaChange')
  })
})

describe('progress updates', () => {
  it('emits progress with the streamed render_ui argument size', async () => {
    const args =
      '{"spec": {"version": 1, "page": "p", "pages": [{"id": "p", "name": "P", "layout": [{"name": "Heading", "props": {"text": "Hello"}}]}]}}'
    const adapter: LLMAdapter = {
      async *chat(): AsyncIterable<StreamDelta> {
        yield { type: 'tool_call_start', id: 'g', name: 'render_ui' }
        yield { type: 'tool_call_args', id: 'g', argsDelta: args.slice(0, 40) }
        yield { type: 'tool_call_args', id: 'g', argsDelta: args.slice(40) }
        yield { type: 'tool_call_end', id: 'g' }
        yield { type: 'done' }
      }
    }
    const updates: Array<Record<string, any>> = []
    for await (const u of runAgentTurn({
      adapter,
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      api: { allow: [] }
    }))
      updates.push(u as Record<string, any>)
    const progress = updates.filter((u) => u.type === 'progress')
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[0].chars).toBe(40)
    // progress must arrive before the final spec it is measuring toward
    expect(updates.findIndex((u) => u.type === 'progress')).toBeLessThan(
      updates.findIndex((u) => u.type === 'spec' && u.final)
    )
  })
})
