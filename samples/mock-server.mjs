/**
 * Local demo backend + mock LLM for the embedded ExampleCRM demo.
 *
 *   GET  /stats              → hit counters (used by the E2E check)
 *   POST /login              → { access_token } (email+password required)
 *   GET  /leads              → lead list
 *   POST /v1/chat/completions→ OpenAI-style SSE that emits render_ui /
 *                              call_api tool calls based on the conversation
 *
 * Run: node samples/mock-server.mjs   (port 8787)
 */
import { createServer } from 'node:http'

const PORT = 8787
const stats = { llm: 0, login: 0, leads: 0 }

const LEADS = [
  ['Ana Ruiz', 'Northwind', 'Qualified', '$12,400'],
  ['Ken Sato', 'Acme Co', 'Proposal', '$8,900'],
  ['Lena Berg', 'Polaris', 'New', '$3,200'],
  ['Mo Chen', 'Fabrikam', 'Qualified', '$15,750']
]

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors })
  res.end(JSON.stringify(body))
}

/* ------------------------------ spec library ------------------------------ */

const loginSpec = {
  version: 1,
  page: 'login',
  pages: [
    {
      id: 'login',
      name: 'Login',
      layout: [
        { name: 'Heading', id: 'login-title', props: { text: 'Welcome back', level: 2 }, grid: { x: 3, y: 0, w: 6, h: 1 } },
        { name: 'Paragraph', id: 'login-sub', props: { text: 'Sign in to continue to ExampleCRM.', muted: true }, grid: { x: 3, y: 1, w: 6, h: 1 } },
        {
          name: 'Form',
          id: 'login-form',
          grid: { x: 3, y: 2, w: 6, h: 5 },
          children: [
            { name: 'Input', id: 'login-email', props: { label: 'Email', name: 'email', type: 'email', placeholder: 'you@example.com' } },
            { name: 'Input', id: 'login-password', props: { label: 'Password', name: 'password', type: 'password', placeholder: '••••••••' } },
            { name: 'Checkbox', id: 'login-remember', props: { label: 'Remember me', name: 'remember', defaultChecked: true } },
            { name: 'Button', id: 'login-submit', props: { text: 'Sign in', variant: 'primary' } }
          ]
        }
      ]
    }
  ]
}

const loginFailedSpec = JSON.parse(JSON.stringify(loginSpec))
loginFailedSpec.pages[0].layout.unshift({
  name: 'Alert',
  id: 'login-error',
  props: { message: '이메일 또는 비밀번호가 올바르지 않습니다.', variant: 'danger' },
  grid: { x: 3, y: 0, w: 6, h: 1 }
})
loginFailedSpec.pages[0].layout[1].grid.y = 1
loginFailedSpec.pages[0].layout[2].grid.y = 2

const dashboardSpec = {
  version: 1,
  page: 'main',
  pages: [
    {
      id: 'main',
      name: 'Dashboard',
      layout: [
        { name: 'Heading', id: 'main-title', props: { text: 'Lead Dashboard', level: 2 }, grid: { x: 0, y: 0, w: 8, h: 1 } },
        { name: 'Badge', id: 'main-badge', props: { text: 'live · mock API', variant: 'success' }, grid: { x: 10, y: 0, w: 2, h: 1 } },
        { name: 'StatCard', id: 'stat-new', props: { label: 'New leads', value: '128', delta: '+12%', deltaGood: true }, grid: { x: 0, y: 1, w: 4, h: 2 } },
        { name: 'StatCard', id: 'stat-open', props: { label: 'Open deals', value: '42', delta: '+4%', deltaGood: true }, grid: { x: 4, y: 1, w: 4, h: 2 } },
        { name: 'StatCard', id: 'stat-won', props: { label: 'Won this month', value: '9', delta: '-2%', deltaGood: false }, grid: { x: 8, y: 1, w: 4, h: 2 } },
        {
          name: 'Table',
          id: 'main-table',
          props: { columns: ['Name', 'Company', 'Stage', 'Value'], rows: LEADS },
          grid: { x: 0, y: 3, w: 8, h: 5 }
        },
        {
          name: 'Section',
          id: 'main-side',
          props: { title: 'Quick actions' },
          grid: { x: 8, y: 3, w: 4, h: 5 },
          children: [
            { name: 'Paragraph', id: 'qa-hint', props: { text: 'Create a lead or import an existing list.' } },
            { name: 'Button', id: 'qa-new-lead', props: { text: 'New lead', variant: 'primary' } },
            { name: 'Button', id: 'qa-import', props: { text: 'Import CSV', variant: 'secondary' } },
            { name: 'Alert', id: 'qa-alert', props: { message: '3 leads need follow-up today.', variant: 'warning' } }
          ]
        }
      ]
    }
  ]
}

const createdSpec = {
  version: 1,
  page: 'main',
  pages: [
    {
      id: 'main',
      name: 'New Lead',
      layout: [
        { name: 'Heading', id: 'created-title', props: { text: 'New lead created', level: 2 }, grid: { x: 0, y: 0, w: 8, h: 1 } },
        { name: 'Badge', id: 'created-badge', props: { text: 'saved', variant: 'success' }, grid: { x: 10, y: 0, w: 2, h: 1 } },
        { name: 'Alert', id: 'created-alert', props: { message: '리드가 추가되었습니다. 대시보드로 돌아가세요.', variant: 'success' }, grid: { x: 0, y: 1, w: 12, h: 1 } },
        {
          name: 'Table',
          id: 'created-table',
          props: {
            columns: ['Name', 'Company', 'Stage', 'Value'],
            rows: [...LEADS, ['New Prospect', 'Contoso', 'New', '$2,100']]
          },
          grid: { x: 0, y: 2, w: 8, h: 5 }
        },
        {
          name: 'Section',
          id: 'created-side',
          props: { title: 'Next' },
          grid: { x: 8, y: 2, w: 4, h: 5 },
          children: [
            { name: 'Paragraph', props: { text: 'Back to the dashboard keeps your place in history.' } },
            { name: 'Button', id: 'created-back', props: { text: 'Back to dashboard', variant: 'secondary' } }
          ]
        }
      ]
    }
  ]
}

/* ------------------------------ mock LLM -------------------------------- */

// Decide from the two latest user turns — the runtime pushes the raw event
// (ACTION …) then the turn prompt ("see ACTION above"), and older history can
// contain tool results that would poison a whole-conversation scan.
function latestUserText(messages) {
  const users = messages.filter((m) => m.role === 'user')
  return users
    .slice(-2)
    .map((m) => String(m.content ?? ''))
    .join('\n')
}

function pickSpec(messages) {
  const last = latestUserText(messages)
  if (last.includes('Login attempt FAILED') || last.includes('AUTH FAILED')) return loginFailedSpec
  if (last.includes('INITIAL SCREEN') && last.includes('Logged in: no')) return loginSpec
  if (last.includes('Authentication SUCCEEDED')) return dashboardSpec
  if (last.includes('ACTION')) return createdSpec
  if (messages.some((m) => m.role === 'tool')) return dashboardSpec
  return dashboardSpec
}

function planToolCalls(messages) {
  const last = latestUserText(messages)
  const hasToolResult = messages.some((m) => m.role === 'tool')
  if (last.includes('Authentication SUCCEEDED') && !hasToolResult) {
    return [{ name: 'call_api', args: { path: '/leads', method: 'GET' } }]
  }
  return [{ name: 'render_ui', args: { spec: pickSpec(messages) } }]
}

async function streamChat(res, body) {
  stats.llm++
  const dbg = (body.messages ?? []).map((m) => `${m.role}: ${String(m.content ?? '').slice(0, 160)}`)
  console.log(`\n[mock] llm call #${stats.llm}\n${dbg.join('\n')}`)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...cors
  })
  const calls = planToolCalls(body.messages ?? [])
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  send({ id: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
  await sleep(80)

  calls.forEach((call, callIndex) => {
    send({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: callIndex, id: `call_${callIndex}`, type: 'function', function: { name: call.name, arguments: '' } }
            ]
          }
        }
      ]
    })
    const args = JSON.stringify(call.args)
    const size = 90
    for (let i = 0; i < args.length; i += size) {
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: callIndex, function: { arguments: args.slice(i, i + size) } }]
            }
          }
        ]
      })
    }
  })

  await sleep(80)
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

/* ------------------------------- http server ------------------------------ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  if (url.pathname === '/stats' && req.method === 'GET') return json(res, 200, stats)

  if (url.pathname === '/login' && req.method === 'POST') {
    stats.login++
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const body = JSON.parse(raw || '{}')
      if (body.email && body.password) return json(res, 200, { access_token: 'demo-token-123', user: body.email })
      return json(res, 401, { error: 'invalid credentials' })
    } catch {
      return json(res, 400, { error: 'bad json' })
    }
  }

  if (url.pathname === '/leads' && req.method === 'GET') {
    stats.leads++
    return json(res, 200, { leads: LEADS.map(([name, company, stage, value]) => ({ name, company, stage, value })) })
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      return await streamChat(res, JSON.parse(raw))
    } catch (err) {
      return json(res, 400, { error: String(err) })
    }
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock backend + LLM listening on http://127.0.0.1:${PORT}`)
})
