import { describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { createAdapter, type LLMConfig } from '../llm'
import type { ReasoningLevel } from '../llm/reasoning'
import { runAgentTurn } from './engine'
import { buildSystemPrompt } from './prompt'
import { parseDomino } from '../domino/parse'
import type { ChatMessage } from '../llm/types'

/**
 * Field benchmark: drives the REAL engine, prompt and adapter against a live
 * provider at each reasoning depth, over a data-backed dashboard turn. It
 * measures the two things the knob is meant to move — wall latency and the
 * chance a screen comes back valid on the first pass (fewer corrective rounds).
 *
 * It is opt-in and self-skipping: with no key it is a no-op, so the suite
 * stays green in CI. Run it with a real provider:
 *
 *   DOMINO_BENCH_API_KEY=sk-…            (required)
 *   DOMINO_BENCH_MODEL=gpt-5             (default)
 *   DOMINO_BENCH_PROVIDER=chat_completions  (default | responses | anthropic)
 *   DOMINO_BENCH_BASE_URL=…              (optional override)
 *   DOMINO_BENCH_RUNS=2                  (default 2 turns per depth)
 */

const API_KEY = process.env.DOMINO_BENCH_API_KEY
const MODEL = process.env.DOMINO_BENCH_MODEL ?? 'gpt-5'
const PROVIDER = (process.env.DOMINO_BENCH_PROVIDER ?? 'chat_completions') as LLMConfig['provider']
const BASE_URL = process.env.DOMINO_BENCH_BASE_URL
const RUNS = Math.max(1, Number(process.env.DOMINO_BENCH_RUNS ?? 2))

const LEVELS: Array<ReasoningLevel | undefined> = [undefined, 'low', 'medium', 'high']

/** A data-backed app: the turn must call_api, then bind the rows into a table. */
const DOMINO = `[meta]
name = Bench CRM
[api]
base_url = https://api.example.com
allow = /leads
[guide]
Sales pipeline. GET /leads returns rows of name, company, stage, value. Show a dashboard with a lead table and a couple of KPI cards.
`

const LEADS = Array.from({ length: 8 }, (_, i) => ({
  name: `Lead ${i}`,
  company: `Co ${i}`,
  stage: ['New', 'Qualified', 'Won'][i % 3],
  value: `$${(i + 1) * 1000}`
}))

interface Outcome {
  ms: number
  passes: number
  valid: boolean
  retries: boolean
  promptTokens?: number
  completionTokens?: number
}

async function drive(level: ReasoningLevel | undefined): Promise<Outcome> {
  const domino = parseDomino(DOMINO).domino!
  const config: LLMConfig = {
    provider: PROVIDER,
    model: MODEL,
    apiKey: API_KEY,
    ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    ...(level ? { reasoning: level } : {})
  }
  const adapter = createAdapter(config)
  const system = buildSystemPrompt(domino, { loggedIn: false })

  let passes = 0
  let retries = false
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  const wrapped = {
    chat: (req: Parameters<typeof adapter.chat>[0]) => {
      passes++
      // A corrective round is what the knob is meant to prevent.
      if (passes > 1) retries = true
      return adapter.chat(req)
    }
  }

  const history: ChatMessage[] = [{ role: 'user', content: 'Show the leads dashboard.' }]
  const started = Date.now()
  let valid = false
  for await (const update of runAgentTurn({
    adapter: wrapped as typeof adapter,
    system,
    history,
    api: { baseUrl: domino.api.baseUrl, allow: domino.api.allow, token: null }
  })) {
    if (update.type === 'spec' && update.final) valid = true
    if (update.type === 'usage') {
      promptTokens = (promptTokens ?? 0) + (update.usage.prompt ?? 0)
      completionTokens = (completionTokens ?? 0) + (update.usage.completion ?? 0)
    }
  }
  return { ms: Date.now() - started, passes, valid, retries, promptTokens, completionTokens }
}

describe.skipIf(!API_KEY)('reasoning field benchmark (live provider)', () => {
  it(
    'compares latency and first-pass validity across reasoning depths',
    { timeout: 600_000 },
    async () => {
      // Route only the fake app backend; the provider goes to the real network.
      setHttpFetch(async (input, init) => {
        const url = String(input)
        if (url.includes('api.example.com')) {
          return new Response(JSON.stringify({ rows: LEADS }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        }
        return globalThis.fetch(input as RequestInfo, init as RequestInit)
      })
      try {
        const rows: string[] = [
          `| depth | ms/pass | passes | valid | retries | prompt tok | completion tok |`,
          `|---|---|---|---|---|---|---|`
        ]
        for (const level of LEVELS) {
          const outcomes: Outcome[] = []
          for (let i = 0; i < RUNS; i++) outcomes.push(await drive(level))
          const avg = (f: (o: Outcome) => number) =>
            Math.round(outcomes.reduce((s, o) => s + f(o), 0) / outcomes.length)
          const label = level ?? '(unset)'
          rows.push(
            `| ${label} | ${avg((o) => o.ms)} | ${avg((o) => o.passes)} | ${
              outcomes.every((o) => o.valid) ? 'all' : 'some'
            } | ${outcomes.filter((o) => o.retries).length}/${outcomes.length} | ${
              avg((o) => o.promptTokens ?? 0) || '—'
            } | ${avg((o) => o.completionTokens ?? 0) || '—'} |`
          )
        }
        console.log(`\nreasoning bench — ${MODEL} (${PROVIDER}), ${RUNS} run(s)/depth\n${rows.join('\n')}\n`)
      } finally {
        setHttpFetch((input, init) => globalThis.fetch(input as RequestInfo, init as RequestInit))
      }
      // The harness itself must not throw; a transport failure shows as an
      // invalid screen in the table, which is the signal, not an error here.
      expect(true).toBe(true)
    }
  )
})
