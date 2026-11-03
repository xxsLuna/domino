import { parsePartialJson } from '../agent/partialJson'
import { isAllowed } from '../agent/api'
import { parseDomino } from '../domino/parse'
import type { DominoFile, ParseError } from '../domino/types'
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
  | {
      type: 'domino'
      name: string
      content: string
      summary: string
      assumptions: string[]
      /**
       * Consistency problems still left after the repair round (the file
       * parses and runs; these parts may not work as intended).
       */
      warnings: string[]
    }
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
   Never ask about colors, theme, density, page ids, widget ids or wording — choose good defaults.
3. When nothing essential is missing, call write_domino with the complete file. If the user says they don't know or don't care, choose a sensible default and list it in "assumptions".
4. After a file is written, the user may ask for changes: apply them and call write_domino again with the full updated file.
5. write_domino may answer with "problems" (syntax errors, or consistency issues such as a goto to an undeclared page). Fix every one and call write_domino again.
Always reply through a tool call, never with plain text.

# Why the structure matters
The runtime is fast only where the file is explicit. Pages declared in [pages] are pre-built in the background and linked by id; [data] sources are fetched and bound by the runtime with no model call; [actions] run reads, writes and navigation with no model call. Anything left to [guide] prose costs a slow LLM turn every time a user presses a button.

# .domino format (INI sections; "key = value"; lines starting with ; or # are comments)
[meta]
name = <app name, required>
description = <one-line summary>
home = <page id of the main screen — must be declared in [pages]>
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

[pages]                        ; the page plan: every screen, with a stable id
<page-id> = <Name> | <what the page shows and lets the user do> | nav
; ids are lowercase kebab-case (leads, lead-detail, lead-new); "nav" = listed in the main navigation.
; Do not declare "login": the runtime owns the sign-in page.

[script]                       ; routing rules, evaluated top to bottom
; with [auth]:
when not logged_in -> goto login
when logged_in -> goto <home>
on auth_failed -> goto login
; without [auth]: "when not logged_in -> goto <home>" (or no [script] at all).
; "goto login" is ONLY valid with [auth] required = true.
; conditions: logged_in, error, not, and, or, ==, != ; commands: goto <page>, render <page>, call [METHOD] /path

[data]                         ; read-only live sources the RUNTIME fetches (no model call)
<key> = GET /path every 30s
; one source per list/read endpoint a screen shows; "every Ns" (5-600) only for live data.
; {stateKey} in a path fills from page state, and the source loads only once that key is set.
; Screens bind them: {"$data": "<key>.<json path>"}. Only GET (or FEED for RSS) — never POST/PUT/PATCH/DELETE.

[actions]                      ; widget behaviors the RUNTIME runs (no model call)
<widget-id> = <step> ; <step> ; ...
; steps: set <stateKey> = form.<field> | refresh <dataKey> | goto <page-id> | call <METHOD> /path [with form]
; call paths may use {form.field}, {row.field} (the selected row when the widget is a Table/List) and {stateKey}.
; widget-id = the id the UI gives that Form (its submit) or Button; inline comments start with #.

[guide]
<Free text, any length. The runtime's UI model reads it to build every screen. Write it as a clear brief:
 - what the service is and who uses it;
 - for each page id in [pages]: what it shows, which [data] key it binds ({"$data": "leads"}), and which widget ids it must use for [actions] entries;
 - every API: method, path, request body fields, response fields, and what the UI should do with them;
 - validations, business rules, empty/error states.
 Keep the user's own words where they are precise.>

# Rules
- Every page id used anywhere — [meta] home, [script], [actions] goto, [guide] — is declared in [pages] with exactly the same spelling.
- Every path the app calls belongs in [api] allow: [data] paths, [actions] call paths, and the login endpoint path when it is relative.
- Every list/read endpoint a screen shows gets a [data] source; [guide] tells the page to bind it.
- Every write (create/update/delete) the UI performs with a form gets an [actions] entry on that Form, e.g.
  new-lead-form = call POST /leads with form ; refresh leads ; goto leads
  and plain navigation buttons get a goto, e.g. new-lead = goto lead-new. Name those widget ids in [guide].
- Detail pages that depend on the pressed record stay in [guide] (the model renders them), but still declare the page in [pages].
- No [auth] section when the app has no sign-in. Without a backend, omit [api], [data] and call steps and describe local-only behavior in [guide].
- RSS/Atom reader: declare a source like "feeds = FEED @subscriptions every 60s" in [data] (or one fixed "FEED https://…/rss.xml") — the runtime fetches and parses the feed itself, so feed URLs never belong in [api] allow. @subscriptions is the user's runtime-managed list; describing the subscribe/refresh flow in [guide] helps the model render it well.
- Write [guide] and the [pages] names/purposes in the user's language. Keys, ids and section names stay in English.

# Example (shortened)
[meta]
name = LeadBook
home = leads

[api]
base_url = https://api.example.com
allow = /leads, /leads/*

[pages]
leads = Leads | every lead as a table, newest first | nav
lead-new = New lead | form to add a lead
lead-detail = Lead | one lead's fields, opened from a table row

[script]
when not logged_in -> goto leads

[data]
leads = GET /leads every 60s

[actions]
new-lead = goto lead-new
new-lead-form = call POST /leads with form ; refresh leads ; goto leads

[guide]
GET /leads returns [{id, name, company, stage}]. The leads page binds its Table rows to {"$data": "leads"} and has a Button with id new-lead.
lead-new is a Form with id new-lead-form (fields name, company). Selecting a row opens lead-detail, which shows GET /leads/{id}.`

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

export interface DominoCheck {
  /** Syntax problems: the file is never handed over with these. */
  errors: string[]
  /**
   * Consistency problems (undeclared pages, login without [auth], paths
   * outside [api] allow, reads left to prose…): sent back for ONE repair
   * round, then the file is delivered with them listed as warnings.
   */
  semantic: string[]
}

/** Path part of `GET /x?y` with `{…}`/`:param` segments marking a detail read. */
function listPath(path: string): string | null {
  const bare = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  // Any placeholder spelling ({id}, :id, <id>, [id], *) or a concrete id
  // segment (42, a UUID) makes it a detail read of one record.
  if (/[{}:<>[\]*]/.test(bare)) return null
  const detail = bare
    .split('/')
    .some((seg) => /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg))
  return detail ? null : bare
}

/**
 * GET endpoints the [guide] describes that no [data] source reads: each one
 * is a screen whose data needs a call_api round trip inside a model turn
 * instead of a runtime-bound source. Detail reads (`/x/{id}`, `/x/:id`) are
 * left to the model on purpose — they depend on the pressed record.
 */
function unboundReads(domino: DominoFile): string[] {
  if (!domino.guide || !domino.api.baseUrl) return []
  const relative = (p: string): string => {
    if (!/^https?:\/\//i.test(p)) return p
    try {
      return new URL(p).pathname
    } catch {
      return p
    }
  }
  const declared = new Set(
    domino.data.filter((d) => d.method === 'GET').map((d) => listPath(relative(d.path)))
  )
  const out = new Set<string>()
  // The path runs up to whitespace or punctuation; `[` / `<` and their
  // closers are part of it, so "/leads/[id]" or "/leads/<id>" is read whole
  // (and then recognised as a detail read) instead of cut to "/leads/".
  for (const m of domino.guide.matchAll(/\bGET\s+(\/[^\s,;)}'"`]*)/g)) {
    const path = listPath(m[1].replace(/[.:]+$/, ''))
    if (!path || declared.has(path)) continue
    // Only endpoints the app may actually call (others would 403 anyway).
    if (!isAllowed(path, domino.api.allow, domino.api.baseUrl)) continue
    out.add(path)
  }
  return [...out].flatMap((path) => {
    const key =
      path
        .split('/')
        .filter(Boolean)
        .pop()
        ?.replace(/[^A-Za-z0-9_-]/g, '') || 'items'
    // A key that would read as a record id ("42") or a placeholder ("id")
    // means the path is not a list — never suggest polling it.
    if (/^\d+$/.test(key) || /^(id|uuid|key|slug)$/i.test(key)) return []
    return [
      `[guide] describes GET ${path} but no [data] source reads it — declare "${key} = GET ${path}" in [data] and bind it on its page ({"$data": "${key}"}) so the runtime loads it without a model call`
    ]
  })
}

/** Syntax and consistency check of a written file. */
export function checkDomino(content: string): DominoCheck {
  const res = parseDomino(content)
  const fmt = (e: ParseError): string => `line ${e.line}: ${e.message}`
  const errors = res.errors.map(fmt)
  if (!res.ok && !errors.length) errors.push('[meta] name is required')
  if (!res.ok || !res.domino) return { errors, semantic: [] }
  const syntax = new Set(res.errors)
  const semantic = res.warnings.filter((w) => !syntax.has(w)).map(fmt)
  if (res.domino.pages.length === 0) {
    semantic.push(
      'no [pages] section — declare every screen as "<page-id> = <Name> | <purpose> | nav" (home included) so pages can be pre-built and linked by id'
    )
  }
  semantic.push(...unboundReads(res.domino))
  return { errors, semantic }
}

/** Validate a written file; returns the problems to send back, or null. */
export function dominoProblems(content: string): string[] | null {
  const { errors, semantic } = checkDomino(content)
  const problems = [...errors, ...semantic]
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
  // Consistency problems get one repair round per turn; after that the file
  // is delivered with them listed, rather than failing a usable file.
  let semanticRound = false
  let lastProblems: string[] = []
  /**
   * The file that already parsed when the repair round was asked for. It is
   * usable as it stands (only consistency warnings), so a repair attempt
   * that breaks it, a stream error, or a reply without a new file delivers
   * THIS one — with its warnings — instead of nothing. A later valid
   * write_domino replaces it as usual.
   */
  let pending: Extract<MakerStep, { type: 'domino' }> | null = null

  const finish = (step: MakerStep): MakerStep => {
    opts.history.splice(0, opts.history.length, ...messages.filter((m) => m.role !== 'system'))
    return step
  }
  /** A step that would discard the file that parsed: deliver that file instead. */
  const orPending = (step: MakerStep): MakerStep =>
    pending && step.type !== 'domino' ? { ...pending } : step

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
          return finish(orPending({ type: 'error', message: d.message }))
        }
      }

      const completed = order.map((id) => calls.get(id)!).filter((c) => c.name)
      const assistant: ChatMessage = { role: 'assistant', content: text }
      if (completed.length) assistant.toolCalls = completed.map((c) => ({ ...c }))
      if (text || completed.length) messages.push(assistant)

      if (!completed.length) {
        const fenced = fencedDomino(text)
        const fencedCheck = fenced ? checkDomino(fenced) : null
        if (fenced && fencedCheck && !fencedCheck.errors.length) {
          return finish({
            type: 'domino',
            name: 'app',
            content: fenced,
            summary: '',
            assumptions: [],
            warnings: fencedCheck.semantic
          })
        }
        // The repair round answered without a file: the one that parsed stands.
        if (pending) return finish({ ...pending })
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
          const { errors, semantic } = checkDomino(content)
          if (errors.length) {
            lastProblems = [...errors, ...semantic]
            result = {
              ok: false,
              error: 'The file has problems. Fix them and call write_domino again.',
              problems: lastProblems
            }
          } else if (semantic.length && !semanticRound) {
            semanticRound = true
            lastProblems = semantic
            pending = {
              type: 'domino',
              name: slug(str(args.name) || 'app'),
              content: content + '\n',
              summary: str(args.summary).trim(),
              assumptions: Array.isArray(args.assumptions)
                ? args.assumptions.map(str).filter(Boolean)
                : [],
              warnings: semantic
            }
            result = {
              ok: false,
              error:
                'The file parses, but parts of it would not work as written. Fix these and call write_domino again with the full file.',
              problems: semantic
            }
          } else {
            step = {
              type: 'domino',
              name: slug(str(args.name) || 'app'),
              content: content + '\n',
              summary: str(args.summary).trim(),
              assumptions: Array.isArray(args.assumptions)
                ? args.assumptions.map(str).filter(Boolean)
                : [],
              warnings: semantic
            }
            result = semantic.length ? { ok: true, warnings: semantic } : { ok: true }
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
      // Questions in place of the repaired file: the file that parsed stands.
      if (step) return finish(orPending(step))
    }
  } catch (err) {
    return finish(orPending({ type: 'error', message: (err as Error).message }))
  }
  return finish(
    orPending({
      type: 'error',
      message: lastProblems.length
        ? `The model could not produce a valid file:\n${lastProblems.join('\n')}`
        : 'The model did not finish. Try again.'
    })
  )
}
