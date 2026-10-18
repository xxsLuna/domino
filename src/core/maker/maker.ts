import { parsePartialJson } from '../agent/partialJson'
import { parseDomino } from '../domino/parse'
import type { ChatMessage, LLMAdapter, ToolCall, ToolDef } from '../llm/types'

/**
 * domino maker: turns a free-form description of a service into a .domino
 * file. The model either asks for what it is missing (`ask_user`) or writes
 * the file (`write_domino`); a file is only handed over once the real parser
 * accepts it — parse errors go back to the model to fix first.
 */

export interface MakerQuestion {
  id: string
  question: string
  /** Why it matters, shown under the question. */
  why?: string
  placeholder?: string
  /** Suggested answers; the user can still type their own. */
  options?: string[]
}

export type MakerStep =
  | { type: 'questions'; intro?: string; questions: MakerQuestion[] }
  | { type: 'domino'; name: string; content: string; summary: string; assumptions: string[] }
  | { type: 'error'; message: string }

export interface MakerProgress {
  /** Prose the model streamed (rarely shown). */
  text?: string
  /** The .domino text as it is being written, for a live preview. */
  draft?: string
}

export interface MakerTurnOptions {
  adapter: LLMAdapter
  /** Conversation so far (no system message); appended to in place. */
  history: ChatMessage[]
  onProgress?: (p: MakerProgress) => void
  maxIterations?: number
}

const askUserTool: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the user for information you cannot reasonably assume. Use at most 5 short, concrete questions per call. The user answers in the next message.',
  parameters: {
    type: 'object',
    properties: {
      intro: { type: 'string', description: 'One sentence on what you understood so far' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'short snake_case id' },
            question: { type: 'string' },
            why: { type: 'string', description: 'Why this is needed (one short sentence)' },
            placeholder: { type: 'string', description: 'Example answer' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Likely answers, if any'
            }
          },
          required: ['id', 'question']
        }
      }
    },
    required: ['questions']
  }
}

const writeDominoTool: ToolDef = {
  name: 'write_domino',
  description:
    'Write the complete .domino file once nothing essential is missing. It is validated; on errors you will get them back to fix.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name without extension, kebab-case' },
      content: { type: 'string', description: 'The full .domino file text' },
      summary: {
        type: 'string',
        description: 'Two or three sentences for the user on what the app does'
      },
      assumptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Defaults you chose that the user did not specify'
      }
    },
    required: ['name', 'content', 'summary']
  }
}

export const makerTools: ToolDef[] = [askUserTool, writeDominoTool]

export const MAKER_SYSTEM_PROMPT = `You are "domino maker". The user describes, in their own words, an app or service they want; you turn it into a .domino file — the definition the domino runtime opens to generate the app's screens live with an LLM.

# How to work
1. Read everything the user wrote. Infer as much as you reasonably can.
2. If something ESSENTIAL is missing, call ask_user (max 5 questions, plain language, in the user's language). Essential means the app can't work or would be wrong without it:
   - what the service is and who uses it, if that is unclear;
   - the API base URL when the user mentions an existing backend without one;
   - for each API the app relies on: method + path, and roughly what it returns or expects (fields) — unless the user already said;
   - login: whether users sign in, the login endpoint, and the response field holding the token, if login is implied.
   Never ask about colors, theme, density, page ids or wording — choose good defaults.
3. When nothing essential is missing, call write_domino with the complete file. If the user says they don't know or don't care, choose a sensible default and list it in "assumptions".
4. After a file is written, the user may ask for changes: apply them and call write_domino again with the full updated file.
Always reply through a tool call, never with plain text.

# .domino format (INI sections; "key = value"; lines starting with ; or # are comments)
[meta]
name = <app name, required>
description = <one-line summary>
home = <page id of the main screen, default main>
logo = <optional image URL>

[auth]                         ; only if users sign in
required = true
login_endpoint = <URL, or path relative to base_url; receives POST {"email","password"} (or the fields you describe in [guide])>
token_key = <response field holding the token, e.g. access_token>
skip_if_logged_in = true

[api]
base_url = <https://api.example.com>
allow = </path, /path/*, ...>  ; comma-separated; the app can call ONLY these paths (wildcard * at the end)

[ui]
theme = auto                   ; light | dark | auto
primary = #4f46e5              ; accent color
style = soft                   ; soft | sharp
density = comfortable          ; comfortable | compact

[script]                       ; routing rules, evaluated top to bottom
when not logged_in -> goto login
when logged_in -> goto main
; conditions: logged_in, not, and, or, ==, != ; commands: goto <page>, render <page>
; without auth use: when not logged_in -> goto main

[guide]
<Free text, any length — the most important section. The runtime's UI model reads it to build every screen. Write it as a clear brief:
 - what the service is and who uses it;
 - the screens/pages to have (with page ids matching [script]/home) and what each shows;
 - every API: method, path, request body fields, response fields, and what the UI should do with them;
 - actions, validations, business rules, empty/error states.
 Keep the user's own words where they are precise.>

# Rules
- Every path the app must call (including the login endpoint path when it is relative) belongs in [api] allow.
- No auth section when the app has no sign-in. Without a backend, omit [api] and describe local-only behavior in [guide].
- Write [guide] in the user's language. Keys and section names stay in English.`

/** Answers to an ask_user round, as the next user message. */
export function formatAnswers(questions: MakerQuestion[], answers: Record<string, string>): string {
  const lines = questions.map((q) => {
    const a = answers[q.id]?.trim()
    return `- ${q.question}\n  → ${a ? a : '(모르겠음 / 알아서 정해 주세요)'}`
  })
  return `Answers:\n${lines.join('\n')}`
}

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(args)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

function toQuestions(raw: unknown): MakerQuestion[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((q, i) => {
    if (typeof q === 'string') return [{ id: `q${i + 1}`, question: q }]
    if (!q || typeof q !== 'object') return []
    const r = q as Record<string, unknown>
    const question = str(r.question ?? r.text ?? r.label).trim()
    if (!question) return []
    return [
      {
        id: str(r.id).trim() || `q${i + 1}`,
        question,
        why: str(r.why).trim() || undefined,
        placeholder: str(r.placeholder).trim() || undefined,
        options: Array.isArray(r.options) ? r.options.map(str).filter(Boolean) : undefined
      }
    ]
  })
}

/** A .domino file written as plain text instead of a tool call. */
function fencedDomino(text: string): string | null {
  const m = /```(?:ini|domino|toml)?\s*\n([\s\S]*?)```/.exec(text)
  return m && /\[meta\]/.test(m[1]) ? m[1].trim() : null
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app'

/** Validate a written file; returns the problems to send back, or null. */
export function dominoProblems(content: string): string[] | null {
  const res = parseDomino(content)
  const problems = res.errors.map((e) => `line ${e.line}: ${e.message}`)
  if (!res.ok && !problems.length) problems.push('[meta] name is required')
  return problems.length ? problems : null
}

/** Run until the model asks questions or delivers a valid file. */
export async function runMakerTurn(opts: MakerTurnOptions): Promise<MakerStep> {
  const maxIterations = opts.maxIterations ?? 4
  const messages: ChatMessage[] = [
    { role: 'system', content: MAKER_SYSTEM_PROMPT },
    ...opts.history
  ]
  let nudged = false
  let lastProblems: string[] = []

  const finish = (step: MakerStep): MakerStep => {
    opts.history.splice(0, opts.history.length, ...messages.filter((m) => m.role !== 'system'))
    return step
  }

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let text = ''
      const calls = new Map<string, ToolCall>()
      const order: string[] = []
      let lastPreview = 0
      for await (const d of opts.adapter.chat({ messages, tools: makerTools, temperature: 0.3 })) {
        if (d.type === 'text') {
          text += d.text
          opts.onProgress?.({ text })
        } else if (d.type === 'tool_call_start') {
          if (!calls.has(d.id)) {
            calls.set(d.id, { id: d.id, name: d.name, args: '' })
            order.push(d.id)
          } else if (!calls.get(d.id)!.name) calls.get(d.id)!.name = d.name
        } else if (d.type === 'tool_call_args') {
          const tc = calls.get(d.id)
          if (!tc) continue
          tc.args += d.argsDelta
          const now = Date.now()
          if (tc.name === 'write_domino' && now - lastPreview > 120) {
            lastPreview = now
            const partial = parsePartialJson<{ content?: string }>(tc.args)
            if (typeof partial?.content === 'string') opts.onProgress?.({ draft: partial.content })
          }
        } else if (d.type === 'error') {
          return finish({ type: 'error', message: d.message })
        }
      }

      const completed = order.map((id) => calls.get(id)!).filter((c) => c.name)
      const assistant: ChatMessage = { role: 'assistant', content: text }
      if (completed.length) assistant.toolCalls = completed.map((c) => ({ ...c }))
      if (text || completed.length) messages.push(assistant)

      if (!completed.length) {
        const fenced = fencedDomino(text)
        if (fenced && !dominoProblems(fenced)) {
          return finish({
            type: 'domino',
            name: 'app',
            content: fenced,
            summary: '',
            assumptions: []
          })
        }
        if (!nudged) {
          nudged = true
          messages.push({
            role: 'user',
            content:
              'Reply with a tool call: ask_user for missing information, or write_domino with the file.'
          })
          continue
        }
        // A model that only talks: show what it said as a question.
        return finish(
          text.trim()
            ? { type: 'questions', questions: [{ id: 'reply', question: text.trim() }] }
            : { type: 'error', message: 'The model returned an empty reply.' }
        )
      }

      let step: MakerStep | null = null
      for (const tc of completed) {
        const args = parseArgs(tc.args)
        let result: Record<string, unknown>
        if (!args) {
          result = { ok: false, error: 'Arguments were not valid JSON. Call the tool again.' }
        } else if (tc.name === 'ask_user') {
          const questions = toQuestions(args.questions)
          if (questions.length) {
            step = { type: 'questions', intro: str(args.intro).trim() || undefined, questions }
            result = {
              ok: true,
              note: 'Shown to the user. Their answers arrive as the next message.'
            }
          } else result = { ok: false, error: 'questions is empty' }
        } else if (tc.name === 'write_domino') {
          const content = str(args.content).replace(/\r\n/g, '\n').trim()
          const problems = dominoProblems(content)
          if (problems) {
            lastProblems = problems
            result = {
              ok: false,
              error: 'The file has problems. Fix them and call write_domino again.',
              problems
            }
          } else {
            step = {
              type: 'domino',
              name: slug(str(args.name) || 'app'),
              content: content + '\n',
              summary: str(args.summary).trim(),
              assumptions: Array.isArray(args.assumptions)
                ? args.assumptions.map(str).filter(Boolean)
                : []
            }
            result = { ok: true }
          }
        } else {
          result = { ok: false, error: `unknown tool ${tc.name}` }
        }
        messages.push({
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          content: JSON.stringify(result)
        })
      }
      if (step) return finish(step)
    }
  } catch (err) {
    return finish({ type: 'error', message: (err as Error).message })
  }
  return finish({
    type: 'error',
    message: lastProblems.length
      ? `The model could not produce a valid file:\n${lastProblems.join('\n')}`
      : 'The model did not finish. Try again.'
  })
}
