/**
 * Local demo backend + mock LLM for the embedded ExampleCRM demo.
 *
 *   GET  /stats              → hit counters (used by the E2E check)
 *   POST /login              → { access_token } (email+password required)
 *   GET  /leads              → lead list
 *   POST /v1/chat/completions→ OpenAI-style SSE that emits render_ui /
 *                              call_api tool calls based on the conversation
 *   GET  /app.domino         → the ExampleCRM definition wired to this server
 *
 * Run: node samples/mock-server.mjs   (port 8787, or PORT=…)
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8787)
const CHUNK_MS = Number(process.env.CHUNK_MS ?? 12)
const stats = { llm: 0, login: 0, leads: 0 }

const LEADS = [
  { id: 'lead-1', name: 'Ana Ruiz', title: 'Head of Ops', company: 'Northwind', stage: 'Qualified', owner: 'Luna Kim', value: '$12,400', email: 'ana@northwind.test', score: 82 },
  { id: 'lead-2', name: 'Ken Sato', title: 'CTO', company: 'Acme Co', stage: 'Proposal', owner: 'Jae Park', value: '$8,900', email: 'ken@acme.test', score: 74 },
  { id: 'lead-3', name: 'Lena Berg', title: 'Founder', company: 'Polaris', stage: 'New', owner: 'Luna Kim', value: '$3,200', email: 'lena@polaris.test', score: 41 },
  { id: 'lead-4', name: 'Mo Chen', title: 'VP Sales', company: 'Fabrikam', stage: 'Qualified', owner: 'Sam Lee', value: '$15,750', email: 'mo@fabrikam.test', score: 88 },
  { id: 'lead-5', name: 'Priya Nair', title: 'Procurement Lead', company: 'Litware', stage: 'Won', owner: 'Jae Park', value: '$22,000', email: 'priya@litware.test', score: 95 },
  { id: 'lead-6', name: 'Tom Weber', title: 'IT Manager', company: 'Contoso', stage: 'Proposal', owner: 'Sam Lee', value: '$6,300', email: 'tom@contoso.test', score: 63 },
  { id: 'lead-7', name: 'Sofia Rossi', title: 'COO', company: 'Tailspin', stage: 'New', owner: 'Luna Kim', value: '$4,800', email: 'sofia@tailspin.test', score: 37 },
  { id: 'lead-8', name: 'Diego Alvarez', title: 'Director', company: 'Woodgrove', stage: 'Lost', owner: 'Jae Park', value: '$9,100', email: 'diego@woodgrove.test', score: 22 }
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

// Primary navigation shared by every signed-in screen (6 items → phones show
// 4 tabs + "More", exercising the overflow path).
const NAV = [
  { id: 'main', label: 'Dashboard', icon: 'dashboard' },
  { id: 'leads', label: 'Leads', icon: 'users', badge: 3 },
  { id: 'deals', label: 'Deals', icon: 'briefcase' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', badge: 12 },
  { id: 'reports', label: 'Reports', icon: 'chart' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

const STAGE_VARIANT = { New: 'info', Qualified: 'success', Proposal: 'warning', Won: 'accent', Lost: 'danger' }
const stageChip = (stage) => ({ text: stage, variant: STAGE_VARIANT[stage] ?? 'neutral' })
const page = (id, name, layout) => ({ version: 1, page: id, nav: NAV, pages: [{ id, name, layout }] })

const loginForm = (y) => ({
  name: 'Form',
  id: 'login-form',
  props: { title: 'Sign in to ExampleCRM', description: 'Use any email and password — this is the local demo.' },
  grid: { x: 4, y, w: 4, h: 6 },
  children: [
    { name: 'Input', id: 'login-email', props: { label: 'Email', name: 'email', type: 'email', placeholder: 'you@example.com', icon: 'mail', required: true } },
    { name: 'Input', id: 'login-password', props: { label: 'Password', name: 'password', type: 'password', placeholder: '••••••••', icon: 'lock', required: true } },
    { name: 'Checkbox', id: 'login-remember', props: { label: 'Remember me', name: 'remember', defaultChecked: true } },
    { name: 'Button', id: 'login-submit', props: { text: 'Sign in', variant: 'primary', fullWidth: true } }
  ]
})

const loginSpec = {
  version: 1,
  page: 'login',
  pages: [{ id: 'login', name: 'Sign in', layout: [loginForm(0)] }]
}

const loginFailedSpec = {
  version: 1,
  page: 'login',
  pages: [
    {
      id: 'login',
      name: 'Sign in',
      layout: [
        { name: 'Alert', id: 'login-error', props: { title: 'Sign-in failed', message: '이메일 또는 비밀번호가 올바르지 않습니다.', variant: 'danger' }, grid: { x: 4, y: 0, w: 4, h: 1 } },
        loginForm(1)
      ]
    }
  ]
}

const leadRows = (leads) => leads.map((l) => [l.name, l.company, stageChip(l.stage), l.owner, l.value])

const dashboardSpec = () =>
  page('main', 'Dashboard', [
    {
      name: 'PageHeader',
      id: 'main-header',
      props: { title: 'Dashboard', description: 'Pipeline overview · live mock API' },
      grid: { x: 0, y: 0, w: 12, h: 1 },
      children: [
        { name: 'Button', id: 'main-export', props: { text: 'Export', variant: 'secondary', icon: 'download' } },
        { name: 'Button', id: 'new-lead', props: { text: 'New lead', variant: 'primary', icon: 'plus' } }
      ]
    },
    { name: 'StatCard', id: 'stat-new', props: { label: 'New leads', value: '128', delta: '+12%', deltaGood: true, icon: 'users', description: 'vs. last week' }, grid: { x: 0, y: 1, w: 3, h: 2 } },
    { name: 'StatCard', id: 'stat-open', props: { label: 'Open deals', value: '42', delta: '+4%', deltaGood: true, icon: 'briefcase', description: 'vs. last week' }, grid: { x: 3, y: 1, w: 3, h: 2 } },
    { name: 'StatCard', id: 'stat-won', props: { label: 'Won this month', value: '9', delta: '-2%', deltaGood: false, icon: 'star', description: 'vs. last month' }, grid: { x: 6, y: 1, w: 3, h: 2 } },
    { name: 'StatCard', id: 'stat-revenue', props: { label: 'Revenue', value: '$84.2k', delta: '+8%', deltaGood: true, icon: 'wallet', description: 'quarter to date' }, grid: { x: 9, y: 1, w: 3, h: 2 } },
    {
      name: 'Table',
      id: 'main-table',
      props: { title: 'Recent leads', columns: ['Name', 'Company', 'Stage', 'Owner', 'Value'], rows: leadRows(LEADS.slice(0, 5)), rowAction: true },
      grid: { x: 0, y: 3, w: 8, h: 6 }
    },
    {
      name: 'Card',
      id: 'main-followups',
      props: { title: 'Follow-ups', description: '3 due today', icon: 'bell' },
      grid: { x: 8, y: 3, w: 4, h: 3 },
      children: [
        {
          name: 'List',
          id: 'followup-list',
          props: {
            items: [
              { id: 'f1', title: 'Call Ana Ruiz', description: 'Northwind · renewal terms', icon: 'phone', badge: 'Today', badgeVariant: 'warning' },
              { id: 'f2', title: 'Send proposal to Ken', description: 'Acme Co · $8,900', icon: 'send', badge: 'Today', badgeVariant: 'warning' },
              { id: 'f3', title: 'Intro meeting', description: 'Polaris · Lena Berg', icon: 'calendar', badge: 'Fri' }
            ]
          }
        }
      ]
    },
    {
      name: 'Card',
      id: 'main-pipeline',
      props: { title: 'Pipeline health', icon: 'chart' },
      grid: { x: 8, y: 6, w: 4, h: 3 },
      children: [
        { name: 'Progress', id: 'p-qualified', props: { label: 'Qualified → Proposal', value: 68, showValue: true } },
        { name: 'Progress', id: 'p-proposal', props: { label: 'Proposal → Won', value: 31, showValue: true } },
        { name: 'Progress', id: 'p-quota', props: { label: 'Quarterly quota', value: 84, showValue: true } }
      ]
    }
  ])

const leadsSpec = (opts = {}) => {
  const leads = opts.created ? [{ name: 'New Prospect', company: 'Contoso', stage: 'New', owner: 'You', value: '$2,100' }, ...LEADS] : LEADS
  const layout = [
    {
      name: 'PageHeader',
      id: 'leads-header',
      props: { title: 'Leads', description: `${leads.length} leads · sorted by last activity` },
      grid: { x: 0, y: 0, w: 12, h: 1 },
      children: [{ name: 'Button', id: 'new-lead', props: { text: 'New lead', variant: 'primary', icon: 'plus' } }]
    },
    { name: 'SearchField', id: 'leads-search', props: { name: 'q', placeholder: 'Search by name or company…' }, grid: { x: 0, y: 1, w: 8, h: 1 } },
    { name: 'Select', id: 'leads-stage', props: { name: 'stage', placeholder: 'All stages', options: ['All stages', 'New', 'Qualified', 'Proposal', 'Won'] }, grid: { x: 8, y: 1, w: 4, h: 1 } },
    {
      name: 'Table',
      id: 'leads-table',
      props: { columns: ['Name', 'Company', 'Stage', 'Owner', 'Value'], rows: leadRows(leads), rowAction: true },
      grid: { x: 0, y: 2, w: 12, h: 8 }
    },
    { name: 'Pagination', id: 'leads-pages', props: { page: 1, total: 3 }, grid: { x: 0, y: 10, w: 12, h: 1 } }
  ]
  if (opts.created) {
    layout.splice(1, 0, { name: 'Alert', id: 'leads-created', props: { title: 'Lead created', message: 'New Prospect (Contoso) was added to your pipeline.', variant: 'success' }, grid: { x: 0, y: 1, w: 12, h: 1 } })
    for (const n of layout.slice(2)) n.grid = { ...n.grid, y: n.grid.y + 1 }
  }
  return page('leads', 'Leads', layout)
}

const leadDetailSpec = (name) => {
  const lead = LEADS.find((l) => l.name === name) ?? LEADS[0]
  return page('lead', lead.name, [
    { name: 'Breadcrumbs', id: 'lead-crumbs', props: { items: [{ id: 'leads', label: 'Leads' }, { id: 'lead', label: lead.name }] }, grid: { x: 0, y: 0, w: 12, h: 1 } },
    {
      name: 'PageHeader',
      id: 'lead-header',
      props: { title: lead.name, description: `${lead.title} · ${lead.company}`, badge: lead.stage, badgeVariant: STAGE_VARIANT[lead.stage] },
      grid: { x: 0, y: 1, w: 12, h: 1 },
      children: [
        { name: 'Button', id: 'lead-delete', props: { text: 'Delete', variant: 'danger', icon: 'trash', confirm: `Delete ${lead.name}? This cannot be undone.` } },
        { name: 'Button', id: 'lead-edit', props: { text: 'Edit', variant: 'secondary', icon: 'edit' } },
        { name: 'Button', id: 'lead-convert', props: { text: 'Convert to deal', variant: 'primary' } }
      ]
    },
    {
      name: 'Card',
      id: 'lead-main',
      grid: { x: 0, y: 2, w: 8, h: 6 },
      children: [
        {
          name: 'Tabs',
          id: 'lead-tabs',
          props: { tabs: ['Overview', 'Activity', 'Notes'] },
          children: [
            {
              name: 'KeyValue',
              id: 'lead-facts',
              props: {
                columns: 2,
                items: [
                  { label: 'Company', value: lead.company },
                  { label: 'Email', value: lead.email },
                  { label: 'Deal value', value: lead.value },
                  { label: 'Stage', value: lead.stage },
                  { label: 'Owner', value: lead.owner },
                  { label: 'Source', value: 'Website form' }
                ]
              }
            },
            {
              name: 'List',
              id: 'lead-activity',
              props: {
                items: [
                  { title: 'Email opened', description: 'Proposal v2 · 2 hours ago', icon: 'mail' },
                  { title: 'Call logged', description: '12 min · yesterday', icon: 'phone' },
                  { title: 'Stage changed to ' + lead.stage, description: '3 days ago', icon: 'flag' }
                ]
              }
            },
            {
              name: 'Form',
              id: 'lead-notes',
              children: [
                { name: 'Textarea', id: 'lead-note', props: { label: 'Add a note', name: 'note', placeholder: 'What happened?', rows: 3 } },
                { name: 'Button', id: 'lead-note-save', props: { text: 'Save note', variant: 'primary' } }
              ]
            }
          ]
        }
      ]
    },
    {
      name: 'Card',
      id: 'lead-owner',
      props: { title: 'Owner' },
      grid: { x: 8, y: 2, w: 4, h: 3 },
      children: [
        { name: 'Avatar', id: 'lead-owner-avatar', props: { name: lead.owner, description: 'Account executive' } },
        { name: 'Divider' },
        { name: 'Progress', id: 'lead-score', props: { label: 'Lead score', value: lead.score, showValue: true } }
      ]
    },
    {
      name: 'Card',
      id: 'lead-next',
      props: { title: 'Next step' },
      grid: { x: 8, y: 5, w: 4, h: 3 },
      children: [
        { name: 'Paragraph', props: { text: 'Send the revised proposal and book a pricing review.', muted: true } },
        { name: 'Button', id: 'lead-schedule', props: { text: 'Schedule meeting', variant: 'secondary', icon: 'calendar', fullWidth: true } }
      ]
    }
  ])
}

const newLeadSpec = () =>
  page('new-lead', 'New lead', [
    { name: 'Breadcrumbs', id: 'new-crumbs', props: { items: [{ id: 'leads', label: 'Leads' }, { id: 'new-lead', label: 'New lead' }] }, grid: { x: 2, y: 0, w: 8, h: 1 } },
    {
      name: 'Form',
      id: 'new-lead-form',
      props: { title: 'New lead', description: 'Add a prospect to your pipeline.', columns: 2 },
      grid: { x: 2, y: 1, w: 8, h: 8 },
      children: [
        { name: 'Input', id: 'nl-name', props: { label: 'Full name', name: 'name', placeholder: 'Jane Doe', required: true } },
        { name: 'Input', id: 'nl-company', props: { label: 'Company', name: 'company', placeholder: 'Contoso' } },
        { name: 'Input', id: 'nl-email', props: { label: 'Email', name: 'email', type: 'email', placeholder: 'jane@contoso.com' } },
        { name: 'Input', id: 'nl-value', props: { label: 'Deal value', name: 'value', type: 'number', placeholder: '2100' } },
        { name: 'Select', id: 'nl-stage', props: { label: 'Stage', name: 'stage', options: ['New', 'Qualified', 'Proposal'], value: 'New' } },
        { name: 'RadioGroup', id: 'nl-source', props: { label: 'Source', name: 'source', options: ['Website', 'Referral', 'Event'], value: 'Website', orientation: 'horizontal' } },
        { name: 'Textarea', id: 'nl-notes', props: { label: 'Notes', name: 'notes', placeholder: 'Context for the team…', rows: 3 } },
        { name: 'Switch', id: 'nl-notify', props: { label: 'Notify the owner', name: 'notify', defaultChecked: true } },
        { name: 'Button', id: 'nl-cancel', props: { text: 'Cancel', variant: 'secondary' } },
        { name: 'Button', id: 'nl-save', props: { text: 'Create lead', variant: 'primary' } }
      ]
    }
  ])

const settingsSpec = () =>
  page('settings', 'Settings', [
    { name: 'PageHeader', id: 'settings-header', props: { title: 'Settings', description: 'Workspace preferences for ExampleCRM' }, grid: { x: 0, y: 0, w: 12, h: 1 } },
    {
      name: 'Form',
      id: 'settings-form',
      props: { title: 'Workspace', columns: 2 },
      grid: { x: 0, y: 1, w: 8, h: 7 },
      children: [
        { name: 'Input', id: 's-name', props: { label: 'Workspace name', name: 'workspace', value: 'ExampleCRM' } },
        { name: 'Input', id: 's-email', props: { label: 'Billing email', name: 'billing', type: 'email', value: 'billing@example.com', description: 'Invoices are sent here.' } },
        { name: 'Select', id: 's-tz', props: { label: 'Time zone', name: 'tz', options: ['Asia/Seoul', 'UTC', 'America/New_York'], value: 'Asia/Seoul' } },
        { name: 'Select', id: 's-currency', props: { label: 'Currency', name: 'currency', options: [{ label: 'US Dollar', value: 'USD' }, { label: 'Korean Won', value: 'KRW' }], value: 'USD' } },
        { name: 'Switch', id: 's-email-notify', props: { label: 'Email notifications', name: 'notify', defaultChecked: true, description: 'Daily summary of lead activity' } },
        { name: 'Switch', id: 's-digest', props: { label: 'Weekly digest', name: 'digest' } },
        { name: 'Checkbox', id: 's-beta', props: { label: 'Join beta features', name: 'beta' } },
        { name: 'Button', id: 's-save', props: { text: 'Save changes', variant: 'primary' } }
      ]
    },
    {
      name: 'Card',
      id: 'settings-plan',
      props: { title: 'Plan', icon: 'card' },
      grid: { x: 8, y: 1, w: 4, h: 3 },
      children: [
        { name: 'KeyValue', id: 'plan-kv', props: { items: { Plan: 'Pro', Seats: '8 of 10', Renews: 'Nov 1, 2026' } } },
        { name: 'Button', id: 'plan-manage', props: { text: 'Manage plan', variant: 'secondary', fullWidth: true } }
      ]
    },
    {
      name: 'Card',
      id: 'settings-danger',
      props: { title: 'Danger zone', icon: 'warning' },
      grid: { x: 8, y: 4, w: 4, h: 3 },
      children: [
        { name: 'Paragraph', props: { text: 'Signing out clears the stored token on this device.', muted: true } },
        { name: 'Button', id: 'logout', props: { text: 'Sign out', variant: 'danger', icon: 'logout', confirm: 'Sign out of ExampleCRM?' } }
      ]
    }
  ])

const comingSoonSpec = (id) => {
  const item = NAV.find((n) => n.id === id) ?? { id, label: id }
  return page(id, item.label, [
    { name: 'PageHeader', id: `${id}-header`, props: { title: item.label }, grid: { x: 0, y: 0, w: 12, h: 1 } },
    {
      name: 'EmptyState',
      id: `${id}-empty`,
      props: { icon: item.icon ?? 'box', title: `No ${item.label.toLowerCase()} yet`, description: 'This area of the demo has no data. Real apps would load it with call_api.' },
      grid: { x: 0, y: 1, w: 12, h: 4 },
      children: [{ name: 'Button', id: 'back-dashboard', props: { text: 'Back to dashboard', variant: 'secondary' } }]
    }
  ])
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

/** Parse the runtime's `ACTION <event> from <name>/<id> data {...}` line. */
function latestAction(text) {
  const m = /ACTION (\w+) from ([\w-]+)\/([\w-]+)(?: data (\{.*\}))?/.exec(text)
  if (!m) return null
  let data = {}
  try {
    data = m[4] ? JSON.parse(m[4].replace(/ \(page "[^"]*"\)$/, '')) : {}
  } catch {
    /* keep empty */
  }
  return { event: m[1], name: m[2], id: m[3], data }
}

function pickSpec(messages) {
  const last = latestUserText(messages)
  if (last.includes('Login attempt FAILED') || last.includes('AUTH FAILED')) return loginFailedSpec
  if (last.includes('INITIAL SCREEN') && last.includes('Logged in: no')) return loginSpec
  if (last.includes('Authentication SUCCEEDED')) return dashboardSpec()
  // Initial/boot turns and background pre-generation name their page directly:
  // `INITIAL SCREEN… Show the "X" page…` (no ACTION line to route on).
  const asked = /INITIAL SCREEN[\s\S]*?Show the "([^"]+)" page/.exec(last)
  if (asked) {
    const target = asked[1]
    if (target === 'main') return dashboardSpec()
    if (target === 'leads') return leadsSpec()
    if (target === 'settings') return settingsSpec()
    return comingSoonSpec(target)
  }
  // Live edit: re-render the named page (a real model would apply the change
  // too; the demo just proves the edit loop re-renders the same screen).
  const edited = /EDIT REQUEST \(page "([^"]+)"\)/.exec(last)
  if (edited) {
    const target = edited[1]
    if (target === 'main') return dashboardSpec()
    if (target === 'leads') return leadsSpec()
    if (target === 'settings') return settingsSpec()
    return comingSoonSpec(target)
  }
  const action = latestAction(last)
  if (action) {
    const { event, id, data } = action
    if (event === 'navigate') {
      const target = data.page ?? id
      if (target === 'main') return dashboardSpec()
      if (target === 'leads') return leadsSpec()
      if (target === 'settings') return settingsSpec()
      return comingSoonSpec(target)
    }
    if (event === 'select') {
      const name = data.row?.Name ?? data.title
      if (name && LEADS.some((l) => l.name === name)) return leadDetailSpec(name)
      return leadDetailSpec(LEADS[0].name)
    }
    if (event === 'submit' && id === 'new-lead-form') return leadsSpec({ created: true })
    if (event === 'click' && id === 'new-lead') return newLeadSpec()
    if (event === 'click' && (id === 'nl-cancel' || id === 'back-dashboard')) return id === 'nl-cancel' ? leadsSpec() : dashboardSpec()
    if (event === 'click' && id === 'logout') return loginSpec
    if (event === 'search' || event === 'change' || event === 'page') return leadsSpec()
  }
  return dashboardSpec()
}

function planToolCalls(messages) {
  const last = latestUserText(messages)
  const hasToolResult = messages.some((m) => m.role === 'tool')
  if (last.includes('Authentication SUCCEEDED') && !hasToolResult) {
    return [{ name: 'call_api', args: { path: '/leads', method: 'GET' } }]
  }
  return [{ name: 'render_ui', args: { spec: pickSpec(messages) } }]
}

/* ---------------------------- mock domino maker --------------------------- */

/** The maker asks one round of questions, then writes a file from the answers. */
function planMakerCalls(messages) {
  const users = messages.filter((m) => m.role === 'user').map((m) => String(m.content ?? ''))
  const description = users[0] ?? ''
  const answers = users.find((u) => u.startsWith('Answers:'))
  if (!answers) {
    return [
      {
        name: 'ask_user',
        args: {
          intro: `요청을 이해했습니다: "${description.slice(0, 60)}${description.length > 60 ? '…' : ''}"`,
          questions: [
            { id: 'base_url', question: 'API 서버 주소가 무엇인가요?', why: '앱이 호출할 수 있는 주소를 정해야 합니다.', placeholder: 'https://api.example.com', options: ['아직 없음'] },
            { id: 'login', question: '사용자가 로그인해야 하나요?', options: ['예', '아니요'] }
          ]
        }
      }
    ]
  }
  const pick = (q) => (new RegExp(`${q}[^\\n]*\\n\\s*→ ([^\\n]*)`).exec(answers)?.[1] ?? '').trim()
  const base = pick('API 서버 주소') || 'https://api.example.com'
  const login = /^예|yes/i.test(pick('로그인'))
  const content = [
    '[meta]',
    'name = Requests',
    'description = 요청을 등록하고 승인하는 사내 앱',
    'home = main',
    '',
    ...(login
      ? ['[auth]', 'required = true', 'login_endpoint = /login', 'token_key = access_token', 'skip_if_logged_in = true', '']
      : []),
    '[api]',
    `base_url = ${/^https?:/.test(base) ? base : 'https://api.example.com'}`,
    `allow = ${login ? '/login, ' : ''}/requests, /requests/*`,
    '',
    '[ui]',
    'theme = auto',
    '',
    '[script]',
    login ? 'when not logged_in -> goto login' : 'when not logged_in -> goto main',
    ...(login ? ['when logged_in -> goto main'] : []),
    '',
    '[guide]',
    description,
    '',
    'GET /requests → [{id, title, requester, status}] 목록을 표로 보여 준다.',
    'POST /requests {title, reason} → 새 요청을 만든다. 성공하면 목록으로 돌아가 알림을 띄운다.'
  ].join('\n')
  return [
    {
      name: 'write_domino',
      args: {
        name: 'requests',
        content,
        summary: '요청 목록, 새 요청 작성, 승인 화면을 가진 사내 요청 관리 앱입니다.',
        assumptions: ['테마는 시스템 설정을 따릅니다', 'API 응답 필드는 설명을 바탕으로 추정했습니다']
      }
    }
  ]
}

/** Emit node keys in the order the system prompt asks for (grid before props). */
const NODE_KEYS = ['name', 'id', 'grid', 'props', 'children']
function nodeKeyOrder(_key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || !('props' in value || 'grid' in value)) return value
  const ordered = {}
  for (const k of NODE_KEYS) if (k in value) ordered[k] = value[k]
  for (const k of Object.keys(value)) if (!(k in ordered)) ordered[k] = value[k]
  return ordered
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
  const isMaker = (body.tools ?? []).some((t) => (t.function?.name ?? t.name) === 'write_domino')
  const calls = isMaker ? planMakerCalls(body.messages ?? []) : planToolCalls(body.messages ?? [])
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  send({ id: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
  await sleep(80)

  // Stream like a real model (~90 chars every CHUNK_MS) so the runtime's
  // progressive render is exercised; CHUNK_MS=0 sends everything at once.
  for (const [callIndex, call] of calls.entries()) {
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
    const args = JSON.stringify(call.args, nodeKeyOrder)
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
      if (CHUNK_MS > 0) await sleep(CHUNK_MS)
    }
  }

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

  if (url.pathname === '/app.domino' && req.method === 'GET') {
    const origin = `http://127.0.0.1:${PORT}`
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...cors })
    res.end(
      [
        '; ExampleCRM served by the mock backend (login → dashboard → leads/detail/settings).',
        '[meta]',
        'name = ExampleCRM',
        'home = main',
        '[auth]',
        'required = true',
        `login_endpoint = ${origin}/login`,
        'token_key = access_token',
        'skip_if_logged_in = true',
        '[api]',
        `base_url = ${origin}`,
        'allow = /login, /leads, /leads/*, /me',
        '[ui]',
        `theme = ${url.searchParams.get('theme') ?? 'auto'}`,
        `primary = ${url.searchParams.get('primary') ?? '#4f46e5'}`,
        `density = ${url.searchParams.get('density') ?? 'comfortable'}`,
        ...(url.searchParams.get('style') ? [`style = ${url.searchParams.get('style')}`] : []),
        '[script]',
        'when not logged_in -> goto login',
        'when logged_in -> goto main',
        ''
      ].join('\n')
    )
    return
  }

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
    return json(res, 200, { leads: LEADS.map(({ id, name, company, stage, value, owner }) => ({ id, name, company, stage, value, owner })) })
  }

  // Detail/create/profile endpoints so a real model has data for every CRM screen.
  const leadMatch = url.pathname.match(/^\/leads\/([\w-]+)$/)
  if (leadMatch && req.method === 'GET') {
    const lead = LEADS.find((l) => l.id === leadMatch[1])
    return lead ? json(res, 200, { lead }) : json(res, 404, { error: 'lead not found' })
  }

  if (url.pathname === '/leads' && req.method === 'POST') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const body = JSON.parse(raw || '{}')
      if (!body.name || !body.company) return json(res, 422, { error: 'name and company are required' })
      const lead = { stage: 'New', owner: 'Luna Kim', value: '$0', score: 50, ...body, id: `lead-${LEADS.length + 1}` }
      LEADS.push(lead)
      return json(res, 201, { lead })
    } catch {
      return json(res, 400, { error: 'bad json' })
    }
  }

  if (url.pathname === '/me' && req.method === 'GET') {
    return json(res, 200, { name: 'Luna Kim', email: 'luna@example.test', role: 'Sales lead', plan: 'Team', notifications: { email: true, weeklyDigest: false } })
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
