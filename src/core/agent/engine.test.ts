import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDelta } from '../llm/types'
import { setHttpFetch } from '../net'
import { resolveNavigateTarget, runAgentTurn, specRepairNotes, type AgentUpdate } from './engine'

const SPEC = {
  version: 1,
  page: 'p',
  pages: [{ id: 'p', name: 'P', layout: [{ name: 'Heading', props: { text: 'Hi' } }] }]
}
const API = { allow: ['/a', '/b', '/leads'], baseUrl: 'https://api.example.com/v1', token: null }

type Call = { name: string; args: unknown }
type Reply = { calls?: Call[]; text?: string; truncated?: boolean; usage?: Array<Record<string, number>> }

/** Scripted adapter: one Reply per request (a function sees the request first). */
function scripted(
  replies: Array<Reply | ((req: ChatRequest) => Reply)>,
  seen: ChatRequest[] = []
): LLMAdapter {
  return {
    async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
      const next = replies.shift() ?? {}
      const reply = typeof next === 'function' ? next(req) : next
      if (reply.text) yield { type: 'text', text: reply.text }
      let n = 0
      for (const c of reply.calls ?? []) {
        const id = `c${seen.length}-${n++}`
        yield { type: 'tool_call_start', id, name: c.name }
        yield {
          type: 'tool_call_args',
          id,
          argsDelta: typeof c.args === 'string' ? c.args : JSON.stringify(c.args)
        }
        yield { type: 'tool_call_end', id }
      }
      for (const u of reply.usage ?? []) yield { type: 'usage', usage: u }
      yield { type: 'done', ...(reply.truncated ? { truncated: true } : {}) }
    }
  }
}

const render = (spec: unknown = SPEC): Call => ({ name: 'render_ui', args: { spec } })
const navigate = (page: string): Call => ({ name: 'navigate', args: { page } })
const callApi = (path: string, method = 'GET', body?: unknown): Call => ({
  name: 'call_api',
  args: { path, method, ...(body ? { body } : {}) }
})

async function collect(gen: AsyncGenerator<AgentUpdate>): Promise<AgentUpdate[]> {
  const out: AgentUpdate[] = []
  for await (const u of gen) out.push(u)
  return out
}

const errors = (updates: AgentUpdate[]): string[] =>
  updates.flatMap((u) => (u.type === 'error' ? [u.message] : []))
const finals = (updates: AgentUpdate[]) => updates.filter((u) => u.type === 'spec' && u.final)
const toolResults = (req: ChatRequest) =>
  req.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
})

describe('navigate', () => {
  it('to a known page ends the turn after one pass', async () => {
    const seen: ChatRequest[] = []
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [navigate('leads')] }], seen),
        system: 's',
        history,
        api: API,
        knownPages: ['main', 'leads']
      })
    )
    expect(seen).toHaveLength(1)
    expect(updates.filter((u) => u.type === 'navigated')).toEqual([{ type: 'navigated', page: 'leads' }])
    expect(errors(updates)).toEqual([])
    expect(JSON.parse(history.at(-1)!.content)).toEqual({ ok: true, page: 'leads' })
  })

  it('resolves a case/space slip to the canonical id and accepts history:<n>', () => {
    expect(resolveNavigateTarget('Leads ', ['main', 'leads'])).toBe('leads')
    expect(resolveNavigateTarget('history:3', ['main'])).toBe('history:3')
    expect(resolveNavigateTarget('nope', ['main'])).toBeNull()
    expect(resolveNavigateTarget('anything')).toBe('anything')
  })

  it('to an unknown page answers ok:false with knownPages and gets one corrective round', async () => {
    const seen: ChatRequest[] = []
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [navigate('reports')] }, { calls: [render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        knownPages: ['main', 'leads']
      })
    )
    expect(seen).toHaveLength(2)
    const [res] = toolResults(seen[1])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown page "reports"/)
    expect(res.knownPages).toEqual(['main', 'leads'])
    expect(updates.some((u) => u.type === 'navigated')).toBe(false)
    expect(finals(updates)).toHaveLength(1)
    expect(errors(updates)).toEqual([])
  })

  it('an unknown navigate with no render afterwards reports the missing screen', async () => {
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [navigate('reports')] }, { text: 'sorry' }]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        knownPages: ['main']
      })
    )
    expect(errors(updates)).toEqual(['The model ended its turn without rendering a screen.'])
  })

  it('a render in the same response wins over the navigate', async () => {
    const seen: ChatRequest[] = []
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [render(), navigate('leads')] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        knownPages: ['leads']
      })
    )
    expect(seen).toHaveLength(1)
    expect(finals(updates)).toHaveLength(1)
    expect(updates.some((u) => u.type === 'navigated')).toBe(false)
  })

  it('navigate wins over a call_api in the same response (no extra pass)', async () => {
    setHttpFetch(async () => new Response('{"rows":[]}', { status: 200 }))
    const seen: ChatRequest[] = []
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [callApi('/leads'), navigate('leads')] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        knownPages: ['leads']
      })
    )
    expect(seen).toHaveLength(1)
    expect(updates.some((u) => u.type === 'navigated')).toBe(true)
  })
})

describe('call_api continuation', () => {
  it('a 2xx call_api plus a valid render ends in one pass', async () => {
    setHttpFetch(async () => new Response('{"rows":[]}', { status: 200 }))
    const seen: ChatRequest[] = []
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [callApi('/leads'), render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(seen).toHaveLength(1)
    expect(finals(updates)).toHaveLength(1)
    const api = updates.find((u) => u.type === 'api_result')
    expect(api && api.type === 'api_result' && api.method).toBe('GET')
  })

  it('renames a provider call id that collides with one already in history', async () => {
    // Servers that number calls per response send call_0 every time; the
    // second pass must still carry this call_api's result.
    setHttpFetch(async () => new Response('{"rows":[]}', { status: 200 }))
    const sameIds = (calls: Call[]): LLMAdapter => {
      const replies = [calls, [render()]]
      return {
        async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
          seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
          for (const c of replies.shift() ?? []) {
            yield { type: 'tool_call_start', id: 'call_0', name: c.name }
            yield { type: 'tool_call_args', id: 'call_0', argsDelta: JSON.stringify(c.args) }
            yield { type: 'tool_call_end', id: 'call_0' }
          }
          yield { type: 'done' }
        }
      }
    }
    const seen: ChatRequest[] = []
    const history: ChatMessage[] = [
      { role: 'user', content: 'INITIAL' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'render_ui', args: '{}' }] },
      { role: 'tool', toolCallId: 'call_0', toolName: 'render_ui', content: '{"ok":true}' },
      { role: 'user', content: 'ACTION submit' }
    ]
    const updates = await collect(
      runAgentTurn({ adapter: sameIds([callApi('/leads')]), system: 's', history, api: API })
    )
    expect(errors(updates)).toEqual([])
    expect(finals(updates)).toHaveLength(1)
    expect(seen).toHaveLength(2)
    const second = seen[1].messages
    const call = second.filter((m) => m.role === 'assistant').at(-1)!.toolCalls![0]
    expect(call.id).toBe('call_0~2')
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_0~2' })
    expect(JSON.parse(second.at(-1)!.content).status).toBe(200)
  })

  it('a failed call_api next to a render earns a follow-up pass', async () => {
    setHttpFetch(async () => new Response('{"error":"boom"}', { status: 500 }))
    const seen: ChatRequest[] = []
    await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [callApi('/leads'), render()] }, { calls: [render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(seen).toHaveLength(2)
  })

  it('runs parallel GETs concurrently and records results in call order', async () => {
    let inFlight = 0
    let peak = 0
    setHttpFetch(async (input) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      const url = String(input)
      // /a answers last: order must still follow the calls.
      await new Promise((r) => setTimeout(r, url.endsWith('/a') ? 40 : 10))
      inFlight--
      return new Response(JSON.stringify({ from: url.slice(-2) }), { status: 200 })
    })
    const seen: ChatRequest[] = []
    await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [callApi('/a'), callApi('/b')] }, { calls: [render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(peak).toBe(2)
    expect(toolResults(seen[1]).map((r) => r.data.from)).toEqual(['/a', '/b'])
  })

  it('a write runs alone: reads after it start only once it landed', async () => {
    const log: string[] = []
    setHttpFetch(async (input, init) => {
      const tag = `${init?.method} ${String(input).slice(-2)}`
      log.push(`start ${tag}`)
      await new Promise((r) => setTimeout(r, 10))
      log.push(`end ${tag}`)
      return new Response('{}', { status: 200 })
    })
    await collect(
      runAgentTurn({
        adapter: scripted([
          { calls: [callApi('/a', 'POST', { x: 1 }), callApi('/b')] },
          { calls: [render()] }
        ]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(log).toEqual(['start POST /a', 'end POST /a', 'start GET /b', 'end GET /b'])
  })

  it('a read-only turn refuses writes without executing them', async () => {
    let fetched = 0
    setHttpFetch(async () => {
      fetched++
      return new Response('{}', { status: 200 })
    })
    const seen: ChatRequest[] = []
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [callApi('/leads', 'POST', { a: 1 })] }, { calls: [render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        readOnlyApi: true
      })
    )
    expect(fetched).toBe(0)
    expect(toolResults(seen[1])[0].error).toMatch(/not allowed in a background build/)
    const api = updates.find((u) => u.type === 'api_result')
    expect(api && api.type === 'api_result' && api.blocked).toBe(true)
    expect(finals(updates)).toHaveLength(1)
  })
})

describe('write ordering', () => {
  it('settles a write before yielding the render that came first in the response', async () => {
    setHttpFetch(async () => new Response('{"ok":true}', { status: 201 }))
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [render(), callApi('/leads', 'POST', { a: 1 })] }]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    const kinds = updates
      .filter((u) => u.type === 'api_result' || (u.type === 'spec' && u.final))
      .map((u) => u.type)
    expect(kinds).toEqual(['api_result', 'spec'])
  })

  it('settles a write before a navigate in the same response', async () => {
    setHttpFetch(async () => new Response('{}', { status: 200 }))
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [navigate('leads'), callApi('/leads/7', 'DELETE')] }]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        knownPages: ['leads']
      })
    )
    const kinds = updates.filter((u) => u.type === 'api_result' || u.type === 'navigated').map((u) => u.type)
    expect(kinds).toEqual(['api_result', 'navigated'])
  })

  it('a read-only build reports the refused write before its render', async () => {
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [render(), callApi('/leads', 'POST', { a: 1 })] }, { calls: [render()] }]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        readOnlyApi: true
      })
    )
    const first = updates.find((u) => u.type === 'api_result' || (u.type === 'spec' && u.final))
    expect(first?.type).toBe('api_result')
    expect(first && first.type === 'api_result' && first.blocked).toBe(true)
  })
})

describe('replayed tool arguments', () => {
  it('a failed render longer than the head is stored as valid JSON', async () => {
    const huge = { spec: { version: 1, page: 'p', pages: 'x'.repeat(5_000) } }
    const seen: ChatRequest[] = []
    await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [{ name: 'render_ui', args: huge }] }, { calls: [render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    const calls = seen[1].messages.flatMap((m) => m.toolCalls ?? [])
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(() => JSON.parse(c.args)).not.toThrow()
    expect(JSON.parse(calls[0].args).invalid).toBe(true)
  })

  it('malformed call arguments of any tool are stored as a JSON object', async () => {
    const seen: ChatRequest[] = []
    await collect(
      runAgentTurn({
        adapter: scripted(
          [{ calls: [{ name: 'render_ui', args: '{"spec": {"version": 1, "page"' }] }, { calls: [render()] }],
          seen
        ),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    for (const c of seen[1].messages.flatMap((m) => m.toolCalls ?? [])) {
      const v = JSON.parse(c.args)
      expect(v && typeof v === 'object' && !Array.isArray(v)).toBe(true)
    }
  })
})

describe('schema change follow-up', () => {
  it('an empty list after a full one is not a shape change', async () => {
    setHttpFetch(async () => new Response('{"rows":[]}', { status: 200 }))
    const seen: ChatRequest[] = []
    await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [callApi('/leads'), render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        knownSchemas: { 'GET /leads': { rows: 'array<object>', 'rows[].id': 'number', 'rows[].name': 'string' } }
      })
    )
    expect(seen).toHaveLength(1)
  })

  it('a real change is reported once per turn, not again on a later pass', async () => {
    setHttpFetch(async () => new Response('{"rows":[{"id":1,"title":"x"}]}', { status: 200 }))
    const seen: ChatRequest[] = []
    await collect(
      runAgentTurn({
        adapter: scripted(
          [{ calls: [callApi('/leads'), render()] }, { calls: [callApi('/leads'), render()] }, { calls: [render()] }],
          seen
        ),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        knownSchemas: { 'GET /leads': { rows: 'array<object>', 'rows[].id': 'number', 'rows[].name': 'string' } }
      })
    )
    expect(seen).toHaveLength(2)
  })
})

describe('iteration budget', () => {
  it('defaults to five passes and offers only render_ui on the last one', async () => {
    setHttpFetch(async () => new Response('{"n":1}', { status: 200 }))
    const seen: ChatRequest[] = []
    // A model that keeps fetching while it can, and renders once it must.
    const stubborn = (req: ChatRequest): Reply =>
      req.tools?.some((t) => t.name === 'call_api') ? { calls: [callApi('/leads')] } : { calls: [render()] }
    const updates = await collect(
      runAgentTurn({
        adapter: scripted(Array.from({ length: 6 }, () => stubborn), seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(seen).toHaveLength(5)
    expect(seen[4].tools?.map((t) => t.name)).toEqual(['render_ui'])
    expect(seen[3].tools?.map((t) => t.name)).toEqual(['render_ui', 'call_api', 'navigate'])
    expect(seen[4].messages.at(-1)?.content).toMatch(/^Data budget reached/)
    expect(finals(updates)).toHaveLength(1)
    expect(errors(updates)).toEqual([])
  })
})

describe('cut-off output', () => {
  const cut = JSON.stringify({ spec: SPEC }).slice(0, -12) // salvageable, but not finished

  it('a salvaged render on a truncated stream is a failed render with a corrective round', async () => {
    const seen: ChatRequest[] = []
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [{ name: 'render_ui', args: cut }], truncated: true }, { calls: [render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(seen).toHaveLength(2)
    expect(toolResults(seen[1])[0]).toMatchObject({ ok: false })
    expect(toolResults(seen[1])[0].error).toMatch(/cut off/)
    // Exactly one final spec — the corrected one; the cut-off one only previewed.
    expect(finals(updates)).toHaveLength(1)
    expect(errors(updates)).toEqual([])
  })

  it('reports the cut-off when the retry is also cut off', async () => {
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([
          { calls: [{ name: 'render_ui', args: cut }], truncated: true },
          { calls: [{ name: 'render_ui', args: cut }], truncated: true }
        ]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(finals(updates)).toHaveLength(0)
    expect(errors(updates)).toEqual(['render_ui output was cut off before the screen was complete'])
  })

  it('a complete render is accepted even when the stream reports truncation after it', async () => {
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [render()], truncated: true }]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(finals(updates)).toHaveLength(1)
  })
})

describe('usage', () => {
  it('yields the turn total summed across passes, monotonic', async () => {
    setHttpFetch(async () => new Response('{}', { status: 200 }))
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([
          { calls: [callApi('/leads')], usage: [{ prompt: 100, completion: 5 }, { prompt: 100, completion: 10, cached: 80 }] },
          { calls: [render()], usage: [{ prompt: 150, completion: 20, total: 170 }] }
        ]),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    const totals = updates.flatMap((u) => (u.type === 'usage' ? [u.usage] : []))
    expect(totals.map((u) => u.total)).toEqual([105, 110, 280])
    expect(totals.at(-1)).toEqual({ prompt: 250, completion: 30, total: 280, cached: 80 })
  })
})

describe('request shape', () => {
  it('sends the dynamic system part second and the transient context on the last user message only', async () => {
    const seen: ChatRequest[] = []
    const history: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'ACTION click' }
    ]
    const controller = new AbortController()
    await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [render()] }], seen),
        system: 'STABLE',
        systemDynamic: 'DYNAMIC',
        transientContext: '\nCurrent screen state: {"n":1}',
        history,
        api: API,
        signal: controller.signal,
        cacheKey: 'domino:abc'
      })
    )
    const msgs = seen[0].messages
    expect(msgs.slice(0, 2)).toEqual([
      { role: 'system', content: 'STABLE' },
      { role: 'system', content: 'DYNAMIC' }
    ])
    expect(msgs[2].content).toBe('first')
    expect(msgs[4].content).toBe('ACTION click\nCurrent screen state: {"n":1}')
    expect(seen[0].signal).toBe(controller.signal)
    expect(seen[0].cacheKey).toBe('domino:abc')
    // Never written back.
    expect(history[2].content).toBe('ACTION click')
  })

  it('sanitizes orphans out of the request but keeps the caller prefix intact', async () => {
    const seen: ChatRequest[] = []
    const history: ChatMessage[] = [
      { role: 'tool', toolCallId: 'gone', toolName: 'render_ui', content: '{"ok":true}' },
      { role: 'user', content: 'go' }
    ]
    const snapLen = history.length
    await collect(
      runAgentTurn({ adapter: scripted([{ calls: [render()] }], seen), system: 's', history, api: API })
    )
    expect(seen[0].messages.map((m) => m.role)).toEqual(['system', 'user'])
    // Caller slices its new messages by index: the prefix must not shift.
    expect(history[0].role).toBe('tool')
    expect(history.slice(snapLen).map((m) => m.role)).toEqual(['assistant', 'tool'])
  })

  it('ends quietly when the caller aborts', async () => {
    const controller = new AbortController()
    const adapter: LLMAdapter = {
      async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
        yield { type: 'text', text: 'working' }
        controller.abort()
        if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      }
    }
    const updates = await collect(
      runAgentTurn({
        adapter,
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API,
        signal: controller.signal
      })
    )
    expect(updates.map((u) => u.type)).toEqual(['text'])
  })
})

describe('repair notes', () => {
  it('reports repairs on the tool result while still showing the screen', async () => {
    const seen: ChatRequest[] = []
    const messy = {
      version: 1,
      page: 'missing',
      pages: [
        {
          id: 'p',
          name: 'P',
          layout: [{ name: 'Fancy', id: 'f' }, { props: { text: 'no name' } }, { name: 'Heading' }]
        }
      ]
    }
    const updates = await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [render(messy)] }, { calls: [render()] }], seen),
        system: 's',
        history: [{ role: 'user', content: 'go' }],
        api: API
      })
    )
    expect(seen).toHaveLength(1)
    expect(finals(updates)).toHaveLength(1)
    const shown = finals(updates)[0]
    if (shown.type !== 'spec') throw new Error('expected a spec')
    const notes = specRepairNotes(messy, shown.spec)
    expect(notes.some((n) => n.includes('page "missing" is not in pages'))).toBe(true)
    expect(notes.some((n) => n.includes('unknown component "Fancy"'))).toBe(true)
    expect(notes.some((n) => n.includes('1 malformed node(s) were dropped'))).toBe(true)
  })

  it('writes the notes into the render_ui tool result', async () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    await collect(
      runAgentTurn({
        adapter: scripted([{ calls: [render({ ...SPEC, page: 'nope' })] }]),
        system: 's',
        history,
        api: API
      })
    )
    const res = JSON.parse(history.at(-1)!.content)
    expect(res.ok).toBe(true)
    expect(res.notes).toEqual(['page "nope" is not in pages — showed "p"'])
  })

  it('a clean spec gets a bare {ok:true}', async () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    await collect(
      runAgentTurn({ adapter: scripted([{ calls: [render()] }]), system: 's', history, api: API })
    )
    expect(JSON.parse(history.at(-1)!.content)).toEqual({ ok: true })
  })
})
