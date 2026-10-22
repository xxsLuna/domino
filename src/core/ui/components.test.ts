import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Alert, Button, Checkbox, Form, Input, RadioGroup, Select, Switch, Textarea } from './components'
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
  const inputNode: CardNode = { name: 'Input', id: 'f-name', props: { label: 'Name', name: 'name' } }
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
