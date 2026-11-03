import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Paragraph,
  RadioGroup,
  Select,
  Switch,
  Textarea,
  buttonSubmits,
  collectLooseFields,
  fieldName,
  internalPageTarget,
  isBindingObject,
  listSelectData,
  recordOf,
  reportsChange,
  stateEcho,
  syncedValue,
  tableSelectData,
  toColumns
} from './components'
import type { CardNode } from '../spec'

const render = <P extends object>(c: ComponentType<P>, props: P): string =>
  renderToStaticMarkup(createElement(c, props))

/** Attributes of the first element matching `tag` (and `extra`, e.g. type="checkbox"). */
function attrsOf(html: string, tag: string, extra = ''): Record<string, string> {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*${extra}[^>]*>`))
  expect(m, `<${tag} ${extra}> in ${html}`).toBeTruthy()
  return Object.fromEntries([...m![0].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))
}

// Agents read names off the DOM: the visible label must be on the control itself,
// not only reachable through aria-labelledby or a wrapping <label>.
describe('form controls carry their label as their name', () => {
  it('Input, with or without an icon, is named by its label rather than the placeholder', () => {
    for (const icon of ['mail', undefined]) {
      const html = render(Input, { label: 'Email', placeholder: 'you@company.com', icon })
      const input = attrsOf(html, 'input')
      expect(input['aria-label']).toBe('Email')
      // aria-labelledby still points at the <Label>, never at the input (no doubled name).
      expect(input['aria-labelledby']).toBeTruthy()
      expect(input['aria-labelledby']).not.toContain(input.id)
    }
  })

  it('Textarea is named by its label', () => {
    const html = render(Textarea, { label: 'Notes', placeholder: 'Context…' })
    expect(attrsOf(html, 'textarea')['aria-label']).toBe('Notes')
  })

  it('Checkbox and Switch are named by their label, not their value "on"', () => {
    expect(attrsOf(render(Checkbox, { label: 'Remember me' }), 'input')['aria-label']).toBe(
      'Remember me'
    )
    const html = render(Switch, { label: 'Email notifications', description: 'Daily summary' })
    const input = attrsOf(html, 'input', 'role="switch"')
    expect(input['aria-label']).toBe('Email notifications')
    // The help text stays announced, as a description (React Aria adds its own slot ids too).
    const helpId = html.match(/<span id="([^"]+)"[^>]*>Daily summary</)?.[1]
    expect(input['aria-describedby']?.split(' ')).toContain(helpId)
  })

  it('Radio options are named by their label, not their value', () => {
    const html = render(RadioGroup, {
      label: 'Currency',
      options: [{ label: 'US Dollar', value: 'USD' }]
    })
    const input = attrsOf(html, 'input', 'type="radio"')
    expect(input['aria-label']).toBe('US Dollar')
    expect(input.value).toBe('USD')
  })

  it('Select trigger is named by its label', () => {
    const html = render(Select, { label: 'Stage', options: ['New', 'Won'] })
    expect(attrsOf(html, 'button')['aria-label']).toBe('Stage')
  })

  it('unlabeled controls keep their fallback names', () => {
    const search = attrsOf(render(Input, { name: 'q', placeholder: 'Find…' }), 'input')
    expect(search['aria-label']).toBe('Find…')
    expect(attrsOf(render(Checkbox, { name: 'agree' }), 'input')['aria-label']).toBe('agree')
  })
})

// Models sometimes send a form whose only button is Cancel (or none at all) —
// the runtime must still render a working submit rather than a dead form.
describe('a form with fields always renders a submit action', () => {
  const inputNode: CardNode = {
    name: 'Input',
    id: 'f-name',
    props: { label: 'Name', name: 'name' }
  }
  const cancelNode: CardNode = {
    name: 'Button',
    id: 'nl-cancel',
    props: { text: '취소', variant: 'secondary' }
  }
  const submitNode: CardNode = { name: 'Button', id: 'f-ok', props: { text: '등록' } }

  const formHtml = (nodes: CardNode[], props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(Form, {
        ...props,
        nodeId: 'f',
        nodeName: 'Form',
        childNodes: nodes,
        children: nodes.map((n) =>
          n.name === 'Button'
            ? createElement(Button, { key: n.id, ...n.props, nodeName: 'Button', nodeId: n.id })
            : createElement(Input, { key: n.id, ...n.props })
        )
      })
    )

  const submitCount = (html: string): number => (html.match(/type="submit"/g) ?? []).length

  it('adds a default "저장" submit when the form only carries a Cancel', () => {
    const html = formHtml([inputNode, cancelNode])
    expect(submitCount(html)).toBe(1)
    expect(html).toContain('저장')
    expect(html).toContain('취소')
  })

  it('does not double up when the form already has its primary submit', () => {
    const html = formHtml([inputNode, submitNode])
    expect(submitCount(html)).toBe(1)
    expect(html).toContain('등록')
    expect(html).not.toContain('저장')
  })

  it('honors submitText next to a Cancel button instead of dropping it', () => {
    const html = formHtml([inputNode, cancelNode], { submitText: '등록하기' })
    expect(submitCount(html)).toBe(1)
    expect(html).toContain('등록하기')
    expect(html).not.toContain('저장')
  })

  it('adds the default submit to a buttonless field form', () => {
    const html = formHtml([inputNode])
    expect(submitCount(html)).toBe(1)
    expect(html).toContain('저장')
  })
})

describe('Alert recovery action', () => {
  it('renders the runtime action button next to the dismiss control', () => {
    const html = renderToStaticMarkup(
      createElement(Alert, {
        variant: 'danger',
        title: '화면을 만들지 못했습니다',
        message: 'boom',
        action: { label: '다시 시도', onPress: () => {} },
        onClose: () => {}
      })
    )
    expect(html).toContain('다시 시도')
    expect(html).toContain('Dismiss')
    expect(html).toContain('boom')
  })

  it('renders without an action when none is given', () => {
    const html = renderToStaticMarkup(createElement(Alert, { variant: 'info', message: 'hi' }))
    expect(html).not.toContain('다시 시도')
    expect(html).toContain('hi')
  })
})

/* ----------------------- select events keep record identity ----------------------- */

describe('tableSelectData', () => {
  const cols = toColumns(['Name', 'Stage'], [])

  it('carries the source record and its id even when id is not a column', () => {
    const raw = {
      id: 42,
      name: 'Acme',
      stage: { text: 'Won', variant: 'success' },
      owner: { id: 1 }
    }
    const data = tableSelectData(raw, cols, 3)
    expect(data.index).toBe(3)
    // The visible projection stays as it was (labels → cell text).
    expect(data.row).toEqual({ Name: 'Acme', Stage: 'Won' })
    expect(data.id).toBe(42)
    // Chip cells flatten to their text; nested objects are left out.
    expect(data.record).toEqual({ id: 42, name: 'Acme', stage: 'Won' })
  })

  it('caps long strings and falls back to other identity keys', () => {
    const raw = { slug: 'acme-co', notes: 'x'.repeat(500) }
    const data = tableSelectData(raw, cols, 0)
    expect(data.id).toBe('acme-co')
    expect(String((data.record as Record<string, unknown>).notes)).toHaveLength(200)
  })

  it('array rows keep the visible projection only', () => {
    const data = tableSelectData(['Acme', 'New'], cols, 1)
    expect(data).toEqual({ index: 1, row: { Name: 'Acme', Stage: 'New' } })
  })
})

describe('listSelectData', () => {
  it('carries the whole item alongside id and title', () => {
    const raw = { id: '7', title: 'Inbox', unread: 3, href: '/x' }
    expect(listSelectData({ id: '7', title: 'Inbox', raw })).toEqual({
      id: '7',
      title: 'Inbox',
      record: { id: '7', title: 'Inbox', unread: 3, href: '/x' }
    })
  })

  it('string items have no record', () => {
    expect(listSelectData({ id: 'a', title: 'A', raw: 'A' })).toEqual({ id: 'a', title: 'A' })
  })
})

describe('recordOf', () => {
  it('returns null for non-objects', () => {
    expect(recordOf(null)).toBeNull()
    expect(recordOf(['a'])).toBeNull()
    expect(recordOf('x')).toBeNull()
  })
})

/* --------------------------------- links ---------------------------------- */

describe('internalPageTarget', () => {
  it('reads page ids out of in-app hrefs', () => {
    expect(internalPageTarget('#leads')).toBe('leads')
    expect(internalPageTarget('page:lead-detail')).toBe('lead-detail')
    expect(internalPageTarget('/settings')).toBe('settings')
    expect(internalPageTarget('./settings/')).toBe('settings')
    expect(internalPageTarget('#/leads?')).toBe('leads')
    expect(internalPageTarget('leads')).toBe('leads')
  })

  it('an id with a query or fragment names a record: a plain click, not a switch', () => {
    expect(internalPageTarget('#order-detail?id=42')).toBeNull()
    expect(internalPageTarget('#/leads?tab=2')).toBeNull()
    expect(internalPageTarget('page:order#42')).toBeNull()
  })

  it('leaves external URLs, other schemes and deep paths alone', () => {
    expect(internalPageTarget('https://example.com')).toBeNull()
    expect(internalPageTarget('//cdn.example.com/x')).toBeNull()
    expect(internalPageTarget('mailto:a@b.c')).toBeNull()
    expect(internalPageTarget('javascript:alert(1)')).toBeNull()
    expect(internalPageTarget('/leads/42')).toBeNull()
    expect(internalPageTarget('')).toBeNull()
    expect(internalPageTarget(undefined)).toBeNull()
  })
})

/* ------------------------------ form values ------------------------------- */

describe('buttonSubmits', () => {
  it('never submits outside a Form, even with type="submit"', () => {
    expect(buttonSubmits({ type: 'submit' }, false)).toBe(false)
    expect(buttonSubmits({}, false)).toBe(false)
  })

  it('inside a Form: explicit submit or the primary variant', () => {
    expect(buttonSubmits({ type: 'submit', variant: 'secondary' }, true)).toBe(true)
    expect(buttonSubmits({}, true)).toBe(true)
    expect(buttonSubmits({ variant: 'secondary' }, true)).toBe(false)
    expect(buttonSubmits({ type: 'button' }, true)).toBe(false)
  })

  it('a type="submit" Button outside a Form renders as a working plain button', () => {
    const html = render(Button, {
      text: 'Save',
      type: 'submit',
      nodeId: 'save',
      nodeName: 'Button'
    })
    expect(attrsOf(html, 'button').type).toBe('button')
  })
})

describe('fieldName', () => {
  it('falls back from name to node id to label', () => {
    expect(fieldName('email', 'f-email', 'Email')).toBe('email')
    expect(fieldName(undefined, 'f-email', 'Email')).toBe('f-email')
    expect(fieldName(undefined, undefined, 'Email')).toBe('Email')
    expect(fieldName(undefined, undefined, undefined)).toBeUndefined()
  })

  it('an unnamed password submits as "password", never its id or label', () => {
    expect(attrsOf(render(Input, { type: 'password', nodeId: 'pw' }), 'input').name).toBe(
      'password'
    )
    expect(attrsOf(render(Input, { type: 'password', label: '비밀번호' }), 'input').name).toBe(
      'password'
    )
    expect(attrsOf(render(Input, { type: 'password', name: 'pin' }), 'input').name).toBe('pin')
  })

  it('unnamed fields submit under their node id', () => {
    expect(attrsOf(render(Input, { label: 'Title', nodeId: 'task-title' }), 'input').name).toBe(
      'task-title'
    )
    expect(attrsOf(render(Textarea, { label: 'Notes', nodeId: 'notes' }), 'textarea').name).toBe(
      'notes'
    )
    const sw = attrsOf(render(Switch, { label: 'Dark', nodeId: 'dark' }), 'input', 'role="switch"')
    expect(sw.name).toBe('dark')
    expect(attrsOf(render(Checkbox, { label: 'Agree', nodeId: 'agree' }), 'input').name).toBe(
      'agree'
    )
  })
})

describe('collectLooseFields', () => {
  const el = (
    name: string,
    value: string,
    extra: { type?: string; checked?: boolean; inForm?: boolean } = {}
  ) => ({
    name,
    value,
    type: extra.type ?? 'text',
    checked: extra.checked,
    closest: (sel: string) => (sel === 'form' && extra.inForm ? {} : null)
  })
  const root = (els: ReturnType<typeof el>[]) => ({ querySelectorAll: () => els })

  it('collects named values next to a button, outside any form', () => {
    expect(
      collectLooseFields(
        root([
          el('task', 'Buy milk'),
          el('urgent', 'on', { type: 'checkbox', checked: true }),
          el('q', 'acme', { type: 'search' }),
          el('inner', 'x', { inForm: true })
        ])
      )
    ).toEqual({ task: 'Buy milk', urgent: true })
  })

  it('sends a loose password field under "password", never its own free-form name', () => {
    expect(
      collectLooseFields(root([el('user', 'jane'), el('pw', 'hunter2', { type: 'password' })]))
    ).toEqual({ user: 'jane', password: 'hunter2' })
  })

  it('is null when nothing was typed (header and toggle-only cards keep bare clicks)', () => {
    expect(collectLooseFields(root([el('task', '')]))).toBeNull()
    expect(
      collectLooseFields(root([el('a', 'on', { type: 'checkbox', checked: true })]))
    ).toBeNull()
    expect(collectLooseFields(null)).toBeNull()
  })
})

/* ---------------------------- state-bound fields --------------------------- */

describe('syncedValue (bound fields follow their prop)', () => {
  const NONE = Symbol('none')
  type S = Parameters<typeof syncedValue<string>>[0]
  const state = (value: string, seen: string, sent: string | symbol = NONE): S =>
    ({ value, seen, sent }) as S

  it('keeps the same state when the prop did not change', () => {
    const s = state('typed', 'a')
    expect(syncedValue(s, 'a')).toBe(s)
  })

  it('adopts an external change (stepper, back/forward, another control)', () => {
    const next = syncedValue(state('typed', 'a'), 'b')
    expect(next.value).toBe('b')
    expect(next.seen).toBe('b')
  })

  it('ignores its own debounced echo so later typing is not overwritten', () => {
    const next = syncedValue(state('abcd', '', 'abc'), 'abc')
    expect(next.value).toBe('abcd')
    expect(next.seen).toBe('abc')
  })
})

describe('reportsChange', () => {
  const keys = new Set(['theme'])
  it('outside a Form every choice control reports', () => {
    expect(reportsChange(false, 'stage', keys)).toBe(true)
  })
  it('inside a Form only state-key controls report', () => {
    expect(reportsChange(true, 'theme', keys)).toBe(true)
    expect(reportsChange(true, 'stage', keys)).toBe(false)
    expect(reportsChange(true, undefined, keys)).toBe(false)
  })
})

describe('controlled fields render their current prop', () => {
  it('Input shows the bound value', () => {
    expect(attrsOf(render(Input, { label: 'Qty', name: 'qty', value: 3 }), 'input').value).toBe('3')
  })

  it('Switch and Checkbox show the bound selection', () => {
    const on = attrsOf(
      render(Switch, { label: 'Dark', name: 'dark', checked: true }),
      'input',
      'role="switch"'
    )
    expect('checked' in on).toBe(true)
    const off = attrsOf(
      render(Switch, { label: 'Dark', name: 'dark', checked: false }),
      'input',
      'role="switch"'
    )
    expect('checked' in off).toBe(false)
    const cb = attrsOf(
      render(Checkbox, { label: 'Agree', name: 'agree', defaultChecked: true }),
      'input'
    )
    expect('checked' in cb).toBe(true)
  })
})

describe('unresolved bindings never render as JSON', () => {
  it('isBindingObject recognizes $state / $data objects only', () => {
    expect(isBindingObject({ $state: 'q' })).toBe(true)
    expect(isBindingObject({ $data: 'leads.total' })).toBe(true)
    expect(isBindingObject({ $state: 'q', x: 1 })).toBe(false)
    expect(isBindingObject({ text: 'a' })).toBe(false)
    expect(isBindingObject(['$state'])).toBe(false)
  })

  it('text props and input values render empty', () => {
    const p = renderToStaticMarkup(
      createElement(Paragraph, { text: { $state: 'count' } as unknown as string })
    )
    expect(p).not.toContain('$state')
    const html = render(Input, { label: 'Q', name: 'q', value: { $state: 'q' } })
    expect(html).not.toContain('$state')
    expect(attrsOf(html, 'input').value ?? '').toBe('')
  })
})

describe('number field echo', () => {
  it('keeps what the user typed when the stored number comes back', () => {
    for (const typed of ['1.0', '-0', '0.10', '007']) {
      const sent = stateEcho(typed, 'number')
      const echo = String(Number(typed)) // what the runtime hands back as the prop
      const next = syncedValue({ value: typed, seen: '', sent }, echo)
      expect(next.value, typed).toBe(typed)
    }
    expect(stateEcho('', 'number')).toBe('')
    expect(stateEcho('1.0', 'text')).toBe('1.0')
  })
})
