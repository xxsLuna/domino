import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRequest, LLMAdapter, StreamDelta } from '../llm/types'
import { checkDomino, dominoProblems, formatAnswers, runMakerTurn } from './maker'

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

[pages]
main = Books | every book I read, newest first | nav

[script]
when not logged_in -> goto main

[data]
books = GET /books

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
    expect(step).toMatchObject({
      type: 'domino',
      name: 'bookshelf',
      assumptions: ['No login'],
      warnings: []
    })
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

describe('semantic validation', () => {
  const NO_AUTH_LOGIN = GOOD.replace('goto main', 'goto login')

  it('gives consistency problems one repair round, then delivers with warnings', async () => {
    const { adapter, requests } = scripted([
      { tool: { name: 'write_domino', args: { name: 'b', content: NO_AUTH_LOGIN, summary: 's' } } },
      { tool: { name: 'write_domino', args: { name: 'b', content: NO_AUTH_LOGIN, summary: 's' } } }
    ])
    const step = await runMakerTurn({ adapter, history: [{ role: 'user', content: 'books' }] })
    expect(requests).toHaveLength(2)
    const feedback = JSON.parse(String(requests[1].messages.at(-1)!.content))
    expect(feedback.ok).toBe(false)
    expect(feedback.problems.join('\n')).toContain('goto login')
    expect(step.type).toBe('domino')
    if (step.type === 'domino') expect(step.warnings.join('\n')).toContain('goto login')
  })

  it('accepts the repaired file without warnings', async () => {
    const { adapter } = scripted([
      { tool: { name: 'write_domino', args: { name: 'b', content: NO_AUTH_LOGIN, summary: 's' } } },
      { tool: { name: 'write_domino', args: { name: 'b', content: GOOD, summary: 's' } } }
    ])
    const step = await runMakerTurn({ adapter, history: [{ role: 'user', content: 'books' }] })
    expect(step).toMatchObject({ type: 'domino', warnings: [] })
  })

  it('separates syntax errors from consistency problems', () => {
    expect(checkDomino(GOOD)).toEqual({ errors: [], semantic: [] })
    expect(dominoProblems(GOOD)).toBeNull()
    const broken = checkDomino('[meta]\nname = X\n[data]\nx = POST /x\n')
    expect(broken.errors.join('\n')).toContain('POST is not allowed')
  })

  it('asks for [pages], declared targets, allowed paths and bound reads', () => {
    const file = [
      '[meta]',
      'name = X',
      'home = dash',
      '[api]',
      'base_url = https://api.test',
      'allow = /items, /items/*',
      '[script]',
      'when not logged_in -> goto main',
      '[data]',
      'stats = GET /stats',
      '[guide]',
      'GET /items returns a list. GET /items/{id} returns one. GET /other is not allowed.'
    ].join('\n')
    const { errors, semantic } = checkDomino(file)
    expect(errors).toEqual([])
    const text = semantic.join('\n')
    expect(text).toContain('no [pages] section')
    expect(text).toContain('[meta] home is "dash"')
    expect(text).toContain('[data] stats: /stats is not covered by [api] allow')
    expect(text).toContain('describes GET /items but no [data] source')
    expect(text).not.toContain('GET /items/{id}')
    expect(text).not.toContain('GET /other')
  })

  it('keeps the file that parsed when the repair attempt breaks it', async () => {
    const BROKEN = GOOD.replace('books = GET /books', 'books = POST /books\n[[[')
    const write = (content: string) => ({
      tool: { name: 'write_domino', args: { name: 'b', content, summary: 's' } }
    })
    const { adapter } = scripted([write(NO_AUTH_LOGIN), write(BROKEN), write(BROKEN)])
    const step = await runMakerTurn({
      adapter,
      history: [{ role: 'user', content: 'books' }],
      maxIterations: 3
    })
    expect(step.type).toBe('domino')
    if (step.type === 'domino') {
      expect(step.content).toBe(`${NO_AUTH_LOGIN.trim()}\n`)
      expect(step.warnings.length).toBeGreaterThan(0)
    }
  })

  it('keeps the file that parsed when the repair round answers in plain text', async () => {
    const { adapter } = scripted([
      { tool: { name: 'write_domino', args: { name: 'b', content: NO_AUTH_LOGIN, summary: 's' } } },
      { text: 'I think it is fine as is.' }
    ])
    const step = await runMakerTurn({ adapter, history: [{ role: 'user', content: 'books' }] })
    expect(step.type).toBe('domino')
  })

  it('never asks to poll a detail read, whatever its placeholder spelling', () => {
    for (const detail of ['/books/<id>', '/books/[id]', '/books/42', '/books/:id', '/books/{id}']) {
      const file = GOOD.replace(
        'GET /books returns',
        `Selecting a row opens book, which shows GET ${detail}. GET /books returns`
      )
      expect(checkDomino(file).semantic, detail).toEqual([])
    }
  })

  it('reports undeclared goto targets against the [pages] plan', () => {
    const file = GOOD.replace('[guide]', '[actions]\nopen = goto book-detail\n[guide]')
    expect(dominoProblems(file)?.join('\n')).toContain('"book-detail" is not a page in [pages]')
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
