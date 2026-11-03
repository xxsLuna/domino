import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { createAdapter } from './index'
import { wireToolArgs } from './toolArgs'
import type { ChatMessage, LLMConfig } from './types'

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
})

describe('wireToolArgs', () => {
  it('passes a JSON object through unchanged', () => {
    expect(wireToolArgs('{"a":1}')).toBe('{"a":1}')
  })

  it('wraps anything else as a JSON object', () => {
    expect(wireToolArgs('')).toBe('{}')
    expect(JSON.parse(wireToolArgs('{"spec": {"page"'))._invalid).toBe('{"spec": {"page"')
    expect(JSON.parse(wireToolArgs('[1,2]'))).toEqual({ _invalid: '[1,2]' })
    expect(JSON.parse(wireToolArgs(`{"x":"${'y'.repeat(900)}…`))._invalid.length).toBe(500)
  })
})

describe('OpenAI-family adapters replay valid arguments only', () => {
  const HISTORY: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'render_ui', args: '{"spec": {"version": 1…' },
        { id: 'b', name: 'call_api', args: '' }
      ]
    },
    { role: 'tool', content: '{"ok":false}', toolCallId: 'a' },
    { role: 'tool', content: '{"ok":false}', toolCallId: 'b' }
  ]

  async function body(provider: LLMConfig['provider']): Promise<any> {
    let captured: any = null
    setHttpFetch(async (_input, init) => {
      captured = JSON.parse(String(init?.body))
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const adapter = createAdapter({ provider, model: 'llama3', apiKey: 'k', baseUrl: 'https://llm.test/v1' })
    for await (const d of adapter.chat({ messages: HISTORY })) void d
    return captured
  }

  it('chat completions', async () => {
    const b = await body('chat_completions')
    const args = b.messages.flatMap((m: any) => m.tool_calls ?? []).map((c: any) => c.function.arguments)
    expect(args).toHaveLength(2)
    for (const a of args) expect(typeof JSON.parse(a)).toBe('object')
  })

  it('responses', async () => {
    const b = await body('responses')
    const args = b.input.filter((i: any) => i.type === 'function_call').map((i: any) => i.arguments)
    expect(args).toHaveLength(2)
    for (const a of args) expect(typeof JSON.parse(a)).toBe('object')
  })
})
