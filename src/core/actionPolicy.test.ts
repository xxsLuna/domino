import { describe, expect, it } from 'vitest'
import { canAutoLink, isMutatingControl, isReplayableEvent } from './actionPolicy'
import type { CardNode } from './spec'

const button = (id: string, props: Record<string, unknown> = {}): CardNode => ({
  name: 'Button',
  id,
  props: { text: id, ...props }
})

describe('isMutatingControl', () => {
  it('treats plain navigation buttons as safe', () => {
    expect(isMutatingControl(button('new-lead', { text: 'New lead' }))).toBe(false)
    expect(isMutatingControl(button('view-order', { text: 'View order' }))).toBe(false)
    expect(isMutatingControl(button('open-settings', { text: 'Settings' }))).toBe(false)
    expect(isMutatingControl(button('view-all', { text: 'View all' }))).toBe(false)
  })

  it('flags mutating verbs in ids and button text', () => {
    for (const id of [
      'delete-lead',
      'remove',
      'save-profile',
      'submit',
      'archive-item',
      'approve',
      'reject-request',
      'send-message',
      'complete-task',
      'mark-all-read',
      'refresh',
      'reload-data',
      'sync',
      'logout',
      'sign-out',
      'markDone'
    ])
      expect(isMutatingControl(button(id, { text: 'x' })), id).toBe(true)
    expect(isMutatingControl(button('b1', { text: 'Delete' }))).toBe(true)
    expect(isMutatingControl(button('b2', { text: '삭제하기' }))).toBe(true)
    expect(isMutatingControl(button('b3', { text: '새로고침' }))).toBe(true)
  })

  it('matches whole words only', () => {
    expect(isMutatingControl(button('saved-items', { text: 'Saved items' }))).toBe(false)
    expect(isMutatingControl(button('bookmarks', { text: 'Bookmarks' }))).toBe(false)
  })

  it('flags danger, confirm, stateKey, submit buttons, forms and anything inside a form', () => {
    expect(isMutatingControl(button('x', { text: 'Go', variant: 'danger' }))).toBe(true)
    expect(isMutatingControl(button('x', { text: 'Go', confirm: 'Sure?' }))).toBe(true)
    expect(isMutatingControl(button('x', { text: '+', stateKey: 'count', delta: 1 }))).toBe(true)
    expect(isMutatingControl(button('x', { text: 'Go', type: 'submit' }))).toBe(true)
    expect(isMutatingControl({ name: 'Form', id: 'lead-form' })).toBe(true)
    expect(isMutatingControl(button('next', { text: 'Next' }), { inForm: true })).toBe(true)
  })

  it('is false for a missing node', () => {
    expect(isMutatingControl(null)).toBe(false)
    expect(isMutatingControl(undefined)).toBe(false)
  })
})

describe('isReplayableEvent', () => {
  it('replays navigation, data-free clicks and selects', () => {
    expect(isReplayableEvent({ event: 'navigate', data: { page: 'leads' } })).toBe(true)
    expect(isReplayableEvent({ event: 'click' })).toBe(true)
    expect(isReplayableEvent({ event: 'click', data: {} })).toBe(true)
    expect(isReplayableEvent({ event: 'select', data: { id: 1 } })).toBe(true)
  })

  it('never replays writes, queries or data-carrying clicks', () => {
    expect(isReplayableEvent({ event: 'submit', data: { name: 'milk' } })).toBe(false)
    expect(isReplayableEvent({ event: 'search', data: { query: 'x' } })).toBe(false)
    expect(isReplayableEvent({ event: 'page', data: { page: 2 } })).toBe(false)
    expect(isReplayableEvent({ event: 'change', data: { name: 'f', value: 1 } })).toBe(false)
    expect(isReplayableEvent({ event: 'click', data: { id: 7 } })).toBe(false)
  })
})

describe('canAutoLink', () => {
  const edge = (to: string, kind: 'action' | 'nav' | 'form' | 'data' = 'action') => ({ to, kind })

  it('links a plain button to a different page', () => {
    expect(canAutoLink(edge('detail'), button('open-detail'), 'list')).toBe(true)
  })

  it('never links a self-loop (the press updated the page in place)', () => {
    expect(canAutoLink(edge('list'), button('next-page'), 'list')).toBe(false)
  })

  it('never links a mutating control, even to another page', () => {
    expect(canAutoLink(edge('list'), button('delete-lead'), 'detail')).toBe(false)
    expect(canAutoLink(edge('list'), button('x', { variant: 'danger' }), 'detail')).toBe(false)
  })

  it('never links form submits, data refreshes or unknown destinations', () => {
    expect(canAutoLink(edge('done', 'form'), { name: 'Form', id: 'f' }, 'new')).toBe(false)
    expect(canAutoLink(edge('other', 'data'), button('open'), 'list')).toBe(false)
    expect(canAutoLink(edge(''), button('open'), 'list')).toBe(false)
    expect(canAutoLink(null, button('open'), 'list')).toBe(false)
  })

  it('links an unknown widget only through a nav edge', () => {
    expect(canAutoLink(edge('leads', 'nav'), null, 'home')).toBe(true)
    expect(canAutoLink(edge('leads', 'action'), null, 'home')).toBe(false)
  })
})

describe('actions that create or start something', () => {
  const press = (id: string, text: string) => ({ name: 'Button', id, props: { text } })
  it('are mutating: their first press must reach the API', () => {
    for (const [id, text] of [
      ['add-to-cart', 'Add to cart'],
      ['place-order', 'Place order'],
      ['book', 'Book now'],
      ['join', 'Join'],
      ['start-timer', 'Start'],
      ['duplicate', 'Duplicate'],
      ['invite', 'Invite'],
      ['apply', '신청하기']
    ]) {
      expect(isMutatingControl(press(id, text)), id).toBe(true)
    }
  })
})
