import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../llm/types'
import { compactHistory, isEngineNudge, sanitizeHistory } from './history'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const callMsg = (...calls: Array<[string, string, string]>): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: calls.map(([id, name, args]) => ({ id, name, args }))
})
const result = (id: string, name: string, content: unknown): ChatMessage => ({
  role: 'tool',
  toolCallId: id,
  toolName: name,
  content: JSON.stringify(content)
})

const bigSpec = (page: string): string =>
  JSON.stringify({
    spec: {
      version: 1,
      page,
      pages: [
        {
          id: page,
          name: page,
          layout: Array.from({ length: 30 }, (_, i) => ({
            name: 'Text',
            id: `t${i}`,
            props: { text: 'x'.repeat(80) }
          }))
        }
      ]
    }
  })

/** One ACTION → call_api → render_ui turn, the common data-screen shape. */
const dataTurn = (n: number): ChatMessage[] => [
  user(`ACTION click ${n}`),
  callMsg([`a${n}`, 'call_api', '{"path":"/leads"}']),
  result(`a${n}`, 'call_api', { status: 200, data: { rows: [{ id: 1 }], total: 1 }, bind: 'GET /leads' }),
  callMsg([`r${n}`, 'render_ui', bigSpec(`p${n}`)]),
  result(`r${n}`, 'render_ui', { ok: true })
]

/** Every assistant tool call has exactly one result right after it, and vice versa. */
function assertPaired(msgs: ChatMessage[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const ids = m.toolCalls.map((c) => c.id)
      const after = msgs.slice(i + 1, i + 1 + ids.length)
      expect(after.map((x) => x.role)).toEqual(ids.map(() => 'tool'))
      expect(after.map((x) => x.toolCallId).sort()).toEqual([...ids].sort())
    }
    if (m.role === 'tool') {
      let j = i - 1
      while (j >= 0 && msgs[j].role === 'tool') j--
      expect(msgs[j]?.role).toBe('assistant')
      expect(msgs[j].toolCalls?.some((c) => c.id === m.toolCallId)).toBe(true)
    }
  }
}

describe('sanitizeHistory', () => {
  it('drops a leading tool result and anything before the first user message', () => {
    const msgs = [
      result('x', 'call_api', { status: 200 }),
      callMsg(['y', 'render_ui', '{}']),
      result('y', 'render_ui', { ok: true }),
      user('go')
    ]
    expect(sanitizeHistory(msgs)).toEqual([user('go')])
  })

  it('drops tool results whose call is missing (a cut between call and result)', () => {
    const msgs = [user('go'), result('lost', 'render_ui', { ok: true }), user('again')]
    expect(sanitizeHistory(msgs).map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('strips calls that never got a result and drops an assistant left empty', () => {
    const msgs = [
      user('go'),
      callMsg(['a', 'call_api', '{}'], ['b', 'call_api', '{}']),
      result('a', 'call_api', { status: 200 }),
      user('next'),
      callMsg(['c', 'render_ui', '{}']),
      user('last')
    ]
    const out = sanitizeHistory(msgs)
    expect(out[1].toolCalls?.map((c) => c.id)).toEqual(['a'])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user'])
    assertPaired(out)
  })

  it('keeps an assistant with text when all its calls are stripped', () => {
    const msgs = [user('go'), { ...callMsg(['a', 'render_ui', '{}']), content: 'Here you go' }]
    const out = sanitizeHistory(msgs)
    expect(out[1]).toEqual({ role: 'assistant', content: 'Here you go' })
  })

  it('drops a result that arrives after an unrelated message (not adjacent to its call)', () => {
    const msgs = [
      user('go'),
      callMsg(['a', 'render_ui', '{}']),
      user('interrupt'),
      result('a', 'render_ui', { ok: true })
    ]
    expect(sanitizeHistory(msgs).map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('pairs results per block when a server reuses call ids across responses', () => {
    // llama.cpp / Ollama style: every response numbers its calls from call_0.
    const msgs = [
      user('INITIAL'),
      callMsg(['call_0', 'render_ui', '{}']),
      result('call_0', 'render_ui', { ok: true }),
      user('ACTION submit'),
      callMsg(['call_0', 'call_api', '{"path":"/leads"}']),
      result('call_0', 'call_api', { status: 200 })
    ]
    expect(sanitizeHistory(msgs)).toEqual(msgs)
  })

  it('strips a reused-id call whose own result is missing', () => {
    const out = sanitizeHistory([
      user('INITIAL'),
      callMsg(['call_0', 'render_ui', '{}']),
      result('call_0', 'render_ui', { ok: true }),
      user('ACTION submit'),
      callMsg(['call_0', 'call_api', '{"path":"/leads"}'])
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
  })

  it('returns valid history unchanged and never mutates the input', () => {
    const msgs = [...dataTurn(1), ...dataTurn(2)]
    const before = JSON.stringify(msgs)
    const out = sanitizeHistory(msgs)
    expect(out).toEqual(msgs)
    expect(out[0]).toBe(msgs[0])
    expect(JSON.stringify(msgs)).toBe(before)
  })
})

describe('compactHistory', () => {
  it('stubs render_ui args and call_api payloads of turns older than keepTurns', () => {
    const msgs = [...dataTurn(1), ...dataTurn(2), ...dataTurn(3), ...dataTurn(4)]
    const out = compactHistory(msgs, { keepTurns: 2 })
    expect(out).toHaveLength(msgs.length)
    // Turn 1 (old): stubbed, still valid JSON.
    const oldRender = out[3].toolCalls![0]
    expect(JSON.parse(oldRender.args)).toEqual({ spec: { page: 'p1', rendered: true } })
    const oldApi = JSON.parse(out[2].content)
    expect(oldApi).toEqual({ status: 200, bind: 'GET /leads', keys: ['rows', 'total'], elided: true })
    // Turn 4 (recent): untouched.
    expect(out[18].toolCalls![0].args).toBe(msgs[18].toolCalls![0].args)
    expect(JSON.parse(out[17].content).data).toEqual({ rows: [{ id: 1 }], total: 1 })
    assertPaired(out)
  })

  it('marks a failed old render as not rendered', () => {
    const msgs = [
      user('go'),
      callMsg(['r', 'render_ui', '{"spec": {"page": "x", "pages": "bro']),
      result('r', 'render_ui', { ok: false, error: 'bad' }),
      ...dataTurn(2)
    ]
    const out = compactHistory(msgs, { keepTurns: 1 })
    expect(JSON.parse(out[1].toolCalls![0].args)).toEqual({ spec: { page: 'x', rendered: false } })
    expect(JSON.parse(out[2].content)).toEqual({ ok: false })
  })

  it('drops whole turns from the front, never splitting a call from its result', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => dataTurn(i)).flat()
    const out = compactHistory(msgs, { maxMessages: 12, keepTurns: 1 })
    expect(out.length).toBeLessThanOrEqual(12)
    expect(out[0].role).toBe('user')
    expect(out.at(-1)).toEqual(msgs.at(-1))
    assertPaired(out)
  })

  it('keeps the newest turn even when it alone exceeds the limit', () => {
    const msgs = dataTurn(1)
    expect(compactHistory(msgs, { maxMessages: 2 })).toEqual(msgs)
  })

  it('treats engine nudges as part of their turn, not as a cut point', () => {
    const nudge = user('No screen was rendered. Call render_ui now with the screen for the request above.')
    expect(isEngineNudge(nudge)).toBe(true)
    const msgs = [
      ...dataTurn(1),
      user('ACTION click 2'),
      { role: 'assistant', content: 'thinking out loud' } as ChatMessage,
      nudge,
      callMsg(['r2', 'render_ui', bigSpec('p2')]),
      result('r2', 'render_ui', { ok: true })
    ]
    const out = compactHistory(msgs, { maxMessages: 6 })
    // The cut lands on "ACTION click 2", keeping the nudge with its request.
    expect(out[0].content).toBe('ACTION click 2')
    expect(out).toHaveLength(5)
  })

  it('enforces the character budget at turn boundaries', () => {
    const huge = (n: number): ChatMessage[] => [
      user(`turn ${n} ` + 'y'.repeat(5_000)),
      { role: 'assistant', content: 'ok' }
    ]
    const msgs = [...huge(1), ...huge(2), ...huge(3)]
    const out = compactHistory(msgs, { keepTurns: 3, maxChars: 11_000 })
    expect(out.map((m) => m.content.slice(0, 6))).toEqual(['turn 2', 'ok', 'turn 3', 'ok'])
  })

  it('clips long old prose, drops old thinking blocks, and never mutates the input', () => {
    const msgs: ChatMessage[] = [
      user('EDIT ' + 'z'.repeat(10_000)),
      { role: 'assistant', content: 'done', providerBlocks: [{ type: 'thinking' }] },
      ...dataTurn(2)
    ]
    const before = JSON.stringify(msgs)
    const out = compactHistory(msgs, { keepTurns: 1 })
    expect(out[0].content.length).toBeLessThan(2_100)
    expect(out[1].providerBlocks).toBeUndefined()
    expect(JSON.stringify(msgs)).toBe(before)
  })

  it('leaves an already-stubbed render alone', () => {
    const stub = JSON.stringify({ spec: { page: 'p', rendered: true } })
    const msgs = [user('a'), callMsg(['r', 'render_ui', stub]), result('r', 'render_ui', { ok: true }), user('b')]
    const out = compactHistory(msgs, { keepTurns: 0 })
    expect(out[1].toolCalls![0].args).toBe(stub)
  })
})
