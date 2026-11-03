import { describe, expect, it } from 'vitest'
import { navBadgeText, navDataKeys, resolveNavItems, type NavItemInput } from './nav'

describe('resolveNavItems', () => {
  it('resolves $data and $state badges against the live maps', () => {
    const items: NavItemInput[] = [
      { id: 'inbox', label: 'Inbox', badge: { $data: 'inbox.unread' } },
      { id: 'cart', label: 'Cart', badge: { $state: 'cartCount' } },
      { id: 'feed', label: 'Feed', badge: { $data: 'api:GET /feed.xml.items.length' } },
      { id: 'home', label: 'Home', badge: 3 }
    ]
    const out = resolveNavItems(
      items,
      { inbox: { unread: 5 }, 'api:GET /feed.xml': { items: { length: 2 } } },
      { cartCount: 1 }
    )
    expect(out.map((i) => i.badge)).toEqual([5, 1, 2, 3])
  })

  it('a missing value hides the badge, never the item', () => {
    const out = resolveNavItems([{ id: 'inbox', label: 'Inbox', badge: { $data: 'inbox.unread' } }])
    expect(out).toEqual([{ id: 'inbox', label: 'Inbox', badge: undefined }])
  })

  it('returns the same array when nothing is bound', () => {
    const items: NavItemInput[] = [
      { id: 'a', label: 'A', badge: '2' },
      { id: 'b', label: 'B' }
    ]
    expect(resolveNavItems(items, {}, {})).toBe(items)
  })

  it('coerces odd literals', () => {
    const out = resolveNavItems([
      { id: 'a', label: 'A', badge: true },
      { id: 'b', label: 'B', badge: { nope: 1 } }
    ])
    expect(out.map((i) => i.badge)).toEqual(['•', undefined])
  })
})

describe('navBadgeText', () => {
  it('shows counts and labels, hides zero, empty and non-scalars', () => {
    expect(navBadgeText(4)).toBe('4')
    expect(navBadgeText('new')).toBe('new')
    expect(navBadgeText(0)).toBeUndefined()
    expect(navBadgeText('')).toBeUndefined()
    expect(navBadgeText({ $data: 'x.y' })).toBeUndefined()
    expect(navBadgeText(null)).toBeUndefined()
  })
})

describe('navDataKeys', () => {
  it('lists the [data] sources nav badges bind', () => {
    expect(
      navDataKeys([
        { id: 'a', label: 'A', badge: { $data: 'inbox.unread' } },
        { id: 'b', label: 'B', badge: { $state: 'n' } },
        { id: 'c', label: 'C', badge: 1 }
      ])
    ).toEqual(new Set(['inbox']))
    expect(navDataKeys(undefined)).toEqual(new Set())
  })
})
