import { describe, expect, it } from 'vitest'
import {
  canAutoLink,
  declaredPageLink,
  isMutatingControl,
  isOpenerControl,
  isReplayableEvent
} from './actionPolicy'
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
  const press = (id: string, text: string, props: Record<string, unknown> = {}) => ({
    name: 'Button',
    id,
    props: { text, ...props }
  })
  it('are mutating: their first press must reach the API', () => {
    for (const [id, text] of [
      ['add-to-cart', 'Add to cart'],
      ['place-order', 'Place order'],
      ['book', 'Book now'],
      ['join', 'Join'],
      ['start-timer', 'Start'],
      ['duplicate', 'Duplicate'],
      ['invite', 'Invite'],
      ['apply', '신청하기'],
      ['add-item', '품목 추가']
    ]) {
      expect(isMutatingControl(press(id, text)), id).toBe(true)
    }
  })

  it('stay mutating with an explicit `to`: words and `to` never prove a press only opens a page', () => {
    expect(isMutatingControl(press('add-item', '품목 추가', { to: 'item_add' }))).toBe(true)
    expect(isMutatingControl(press('add-to-cart', '장바구니에 추가', { to: 'cart' }))).toBe(true)
  })
})

describe('openers ("추가", "Add", "Join")', () => {
  const add = button('add-item', { text: '품목 추가', to: 'item_add' })

  it('are never auto-linked, whatever edge was observed: one answer says nothing about the next press', () => {
    expect(canAutoLink({ to: 'item_add', kind: 'action' }, add, 'main')).toBe(false)
    expect(
      canAutoLink(
        { to: 'cart', kind: 'action' },
        button('add-to-cart', { text: 'Add to cart' }),
        'p'
      )
    ).toBe(false)
  })

  it('follow a learned link only to the page their `to` names right now', () => {
    const learned = { to: 'item_add', kind: 'action' as const, reused: true as const }
    expect(canAutoLink(learned, add, 'main', 'item_add')).toBe(true)
    // Nothing learnable (never declared, seen writing, record page…), or the
    // `to` now names another page.
    expect(canAutoLink(learned, add, 'main')).toBe(false)
    expect(canAutoLink(learned, add, 'main', null)).toBe(false)
    expect(canAutoLink(learned, add, 'main', 'item_wizard')).toBe(false)
    // A learned flag on a data action or a self-loop means nothing.
    expect(canAutoLink({ ...learned, kind: 'form' }, add, 'main', 'item_add')).toBe(false)
    expect(canAutoLink({ ...learned, to: 'main' }, add, 'main', 'main')).toBe(false)
  })

  it('a learned link never clears a verb that always acts or a structural signal', () => {
    const learned = { to: 'x', kind: 'action' as const, reused: true as const }
    expect(canAutoLink(learned, button('delete', { text: 'Delete', to: 'x' }), 'main', 'x')).toBe(
      false
    )
    expect(canAutoLink(learned, button('save', { text: '저장', to: 'x' }), 'main', 'x')).toBe(false)
    expect(
      canAutoLink(learned, button('add', { text: 'Add', to: 'x', variant: 'danger' }), 'main', 'x')
    ).toBe(false)
    expect(
      canAutoLink(learned, button('add', { text: 'Add', to: 'x', confirm: 'Sure?' }), 'main', 'x')
    ).toBe(false)
  })

  it('isOpenerControl: only an opener verb made the control mutating', () => {
    expect(isOpenerControl(add)).toBe(true)
    expect(isOpenerControl(button('join', { text: '참여하기' }))).toBe(true)
    // Always-acting verbs and structural signals are not openers.
    expect(isOpenerControl(button('pay', { text: '결제' }))).toBe(false)
    expect(isOpenerControl(button('delete', { text: 'Delete' }))).toBe(false)
    expect(isOpenerControl(button('add', { text: 'Add', variant: 'danger' }))).toBe(false)
    expect(isOpenerControl(button('add', { text: 'Add', confirm: 'Sure?' }))).toBe(false)
    expect(isOpenerControl(button('add', { text: 'Add' }), { inForm: true })).toBe(false)
    // Plain controls and missing nodes are not openers either.
    expect(isOpenerControl(button('view-all', { text: 'View all' }))).toBe(false)
    expect(isOpenerControl(null)).toBe(false)
  })
})

describe('declaredPageLink', () => {
  it('reads a Button/Link `to` without decorations', () => {
    expect(declaredPageLink(button('a', { to: ' #/item_add ' }))).toBe('item_add')
    expect(declaredPageLink(button('a', { to: 'page:stats' }))).toBe('stats')
    expect(declaredPageLink(button('a', { to: '#' }))).toBeNull()
    expect(declaredPageLink(button('a', { to: ' ' }))).toBeNull()
    expect(declaredPageLink(button('a'))).toBeNull()
    expect(declaredPageLink({ name: 'Card', id: 'c', props: { to: 'x' } })).toBeNull()
    expect(declaredPageLink(null)).toBeNull()
  })
})
