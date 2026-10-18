import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDelta } from '../llm/types'
import { formatAnswers, runMakerTurn } from './maker'

type Reply = { text?: string; tool?: { name: string; args: unknown } }

/** Fake model: replays one scripted reply per chat() call, recording requests. */
function scripted(replies: Reply[]) {
  const requests: ChatRequest[] = []
  const adapter: LLMAdapter = {
    async *chat(req): AsyncIterable<StreamDelta> {
      requests.push({ ...req, messages: [...req.messages] })
      const r = replies.shift() ?? { text: '' }
      if (r.text) yield { type: 'text', text: r.text }
      if (r.tool) {
        const id = `call_${requests.length}`
        yield { type: 'tool_call_start', id, name: r.tool.name }
        const json = JSON.stringify(r.tool.args)
        for (let i = 0; i < json.length; i += 40) {
          yield { type: 'tool_call_args', id, argsDelta: json.slice(i, i + 40) }
        }
        yield { type: 'tool_call_end', id }
      }
      yield { type: 'done' }
    }
  }
  return { adapter, requests }
}

const GOOD = `[meta]
name = Bookshelf
description = Track books I read

[api]
base_url = https://api.books.test
allow = /books, /books/*

[script]
when not logged_in -> goto main

[guide]
GET /books returns [{id, title, author, status}].
`

describe('runMakerTurn', () => {
  it('returns questions when the model asks', async () => {
    const { adapter } = scripted([
      {
        tool: {
          name: 'ask_user',
          args: {
            intro: 'A reading tracker.',
            questions: [{ id: 'base_url', question: 'API 주소가 무엇인가요?', options: ['없음'] }]
          }
        }
      }
    ])
    const history: ChatMessage[] = [{ role: 'user', content: '책 읽은 기록 앱' }]
    const step = await runMakerTurn({ adapter, history })
    expect(step).toMatchObject({
      type: 'questions',
      intro: 'A reading tracker.',
      questions: [{ id: 'base_url', options: ['없음'] }]
    })
    // assistant tool call + tool result recorded, so answers can follow
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('sends parse errors back and returns the corrected file', async () => {
    const { adapter, requests } = scripted([
      {
        tool: { name: 'write_domino', args: { name: 'x', content: '[meta]\nnope', summary: 's' } }
      },
      {
        tool: {
          name: 'write_domino',
          args: {
            name: 'Bookshelf',
            content: GOOD,
            summary: 'Reading tracker.',
            assumptions: ['No login']
          }
        }
      }
    ])
    const drafts: string[] = []
    const step = await runMakerTurn({
      adapter,
      history: [{ role: 'user', content: 'books' }],
      onProgress: (p) => p.draft && drafts.push(p.draft)
    })
    expect(step).toMatchObject({ type: 'domino', name: 'bookshelf', assumptions: ['No login'] })
    if (step.type === 'domino') expect(step.content).toContain('[guide]')
    const feedback = requests[1].messages.at(-1)!
    expect(feedback.role).toBe('tool')
    expect(feedback.content).toContain('problems')
    expect(drafts.length).toBeGreaterThan(0)
  })

  it('nudges a chatty model once, then shows its text as a question', async () => {
    const { adapter, requests } = scripted([
      { text: 'What does it do?' },
      { text: 'Tell me more?' }
    ])
    const step = await runMakerTurn({ adapter, history: [{ role: 'user', content: 'app' }] })
    expect(requests).toHaveLength(2)
    expect(step).toEqual({
      type: 'questions',
      questions: [{ id: 'reply', question: 'Tell me more?' }]
    })
  })

  it('accepts a fenced file written as plain text', async () => {
    const { adapter } = scripted([{ text: 'Here you go:\n```ini\n' + GOOD + '```' }])
    const step = await runMakerTurn({ adapter, history: [{ role: 'user', content: 'books' }] })
    expect(step.type).toBe('domino')
  })
})

describe('formatAnswers', () => {
  it('marks skipped questions as "decide for me"', () => {
    const text = formatAnswers(
      [
        { id: 'a', question: 'Base URL?' },
        { id: 'b', question: 'Login?' }
      ],
      { a: 'https://api.test' }
    )
    expect(text).toContain('→ https://api.test')
    expect(text).toContain('알아서 정해 주세요')
  })
})
