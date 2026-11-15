import { describe, expect, it } from 'vitest'
import { externalHrefFor } from './links'

const APP = 'https://localhost'

describe('externalHrefFor', () => {
  it('sends an article row out of the app', () => {
    expect(
      externalHrefFor({ href: 'https://www.yna.co.kr/view/AKR1', target: '_blank' }, APP)
    ).toBe('https://www.yna.co.kr/view/AKR1')
  })
  it('treats any cross-origin link as leaving the app, blank target or not', () => {
    expect(externalHrefFor({ href: 'https://x.dev/a' }, APP)).toBe('https://x.dev/a')
  })
  it('keeps same-origin links inside', () => {
    expect(externalHrefFor({ href: 'https://localhost/settings' }, APP)).toBeNull()
    expect(externalHrefFor({ href: '/relative' }, APP)).toBeNull()
  })
  it('keeps same-origin explicit tabs out (a link asked for a new window)', () => {
    expect(externalHrefFor({ href: 'https://localhost/doc', target: '_blank' }, APP)).toBe(
      'https://localhost/doc'
    )
  })
  it('leaves mailto:, tel: and javascript: to the system', () => {
    expect(externalHrefFor({ href: 'mailto:a@b.c', target: '_blank' }, APP)).toBeNull()
    expect(externalHrefFor({ href: 'tel:112', target: '_blank' }, APP)).toBeNull()
    expect(externalHrefFor({ href: 'javascript:alert(1)', target: '_blank' }, APP)).toBeNull()
  })
  it('shrugs at junk and at no anchor', () => {
    expect(externalHrefFor({ href: 'not a url' }, APP)).toBeNull()
    expect(externalHrefFor(null, APP)).toBeNull()
  })
})
