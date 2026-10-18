import type { UiSpec } from '../spec'

/**
 * Hardcoded demo specs — prove the "already-built app" rendering path
 * before any LLM is involved.
 */

export const demoLoginSpec: UiSpec = {
  version: 1,
  page: 'login',
  pages: [
    {
      id: 'login',
      name: 'Login',
      layout: [
        { name: 'Heading', id: 'login-title', props: { text: 'Welcome back', level: 2 }, grid: { x: 3, y: 0, w: 6, h: 1 } },
        { name: 'Paragraph', id: 'login-sub', props: { text: 'Sign in to continue to your dashboard.', muted: true }, grid: { x: 3, y: 1, w: 6, h: 1 } },
        {
          name: 'Form',
          id: 'login-form',
          grid: { x: 3, y: 2, w: 6, h: 4 },
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

export const demoMainSpec: UiSpec = {
  version: 1,
  page: 'main',
  pages: [
    {
      id: 'main',
      name: 'Dashboard',
      layout: [
        { name: 'Heading', id: 'main-title', props: { text: 'Lead Dashboard', level: 2 }, grid: { x: 0, y: 0, w: 8, h: 1 } },
        { name: 'Button', id: 'main-refresh', props: { text: 'Refresh', variant: 'secondary' }, grid: { x: 10, y: 0, w: 2, h: 1 } },
        { name: 'StatCard', id: 'stat-new', props: { label: 'New leads', value: '128', delta: '+12%', deltaGood: true }, grid: { x: 0, y: 1, w: 4, h: 2 } },
        { name: 'StatCard', id: 'stat-open', props: { label: 'Open deals', value: '42', delta: '+4%', deltaGood: true }, grid: { x: 4, y: 1, w: 4, h: 2 } },
        { name: 'StatCard', id: 'stat-won', props: { label: 'Won this month', value: '9', delta: '-2%', deltaGood: false }, grid: { x: 8, y: 1, w: 4, h: 2 } },
        {
          name: 'Table',
          id: 'main-table',
          props: {
            columns: ['Name', 'Company', 'Stage', 'Value'],
            rows: [
              ['Ana Ruiz', 'Northwind', 'Qualified', '$12,400'],
              ['Ken Sato', 'Acme Co', 'Proposal', '$8,900'],
              ['Lena Berg', 'Polaris', 'New', '$3,200']
            ]
          },
          grid: { x: 0, y: 3, w: 8, h: 4 }
        },
        {
          name: 'Section',
          id: 'main-side',
          props: { title: 'Quick actions' },
          grid: { x: 8, y: 3, w: 4, h: 4 },
          children: [
            { name: 'Paragraph', props: { text: 'Common tasks for today.' } },
            { name: 'Button', id: 'qa-new-lead', props: { text: 'New lead' } },
            { name: 'Button', id: 'qa-import', props: { text: 'Import CSV', variant: 'secondary' } },
            { name: 'Alert', props: { message: '3 leads need follow-up.', variant: 'warning' } }
          ]
        }
      ]
    }
  ]
}

export const demoSpecs = { login: demoLoginSpec, main: demoMainSpec }
