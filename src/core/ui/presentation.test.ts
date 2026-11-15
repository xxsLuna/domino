import { describe, expect, it } from 'vitest'
import type { CardNode, PageSpec } from '../spec'
import { MODAL_MAX_FIELDS, formFieldCount, isModalPresentation, prettyTime } from './presentation'

const node = (name: string, children?: CardNode[]): CardNode => ({
  name,
  id: name.toLowerCase(),
  ...(children ? { children } : {})
})

const page = (layout: CardNode[], id = 'new-lead'): PageSpec => ({
  id,
  name: id,
  layout
})

const fieldForm = (fields: number, id = 'new-lead'): PageSpec =>
  page(
    [
      node('Breadcrumbs'),
      node(
        'Form',
        Array.from({ length: fields }, () => node('Input'))
      )
    ],
    id
  )

describe('isModalPresentation', () => {
  it('presents a short create/edit form as a sheet', () => {
    expect(isModalPresentation(fieldForm(3))).toBe(true)
  })

  it('switches to a page card once the form has too much content', () => {
    expect(isModalPresentation(fieldForm(MODAL_MAX_FIELDS))).toBe(true)
    expect(isModalPresentation(fieldForm(MODAL_MAX_FIELDS + 1))).toBe(false)
  })

  it('never sheets the login page — there is nothing behind it', () => {
    expect(isModalPresentation(fieldForm(2, 'login'))).toBe(false)
  })

  it('leaves pages without a form, and empty forms, as page cards', () => {
    expect(isModalPresentation(page([node('PageHeader'), node('Table')]))).toBe(false)
    expect(isModalPresentation(page([node('Form', [node('Button')])]))).toBe(false)
  })

  it('counts fields nested at any depth', () => {
    const nested = page([node('Card', [node('Form', [node('Input'), node('Select')])])])
    expect(formFieldCount(nested)).toBe(2)
    expect(isModalPresentation(nested)).toBe(true)
  })
})

describe('prettyTime (feed timestamps in a List meta)', () => {
  it('reformats RFC-822 and ISO stamps instead of showing the raw wire text', () => {
    for (const raw of ['Sun, 15 Nov 2026 11:17:23 +0900', '2026-11-15T02:17:00.000Z']) {
      const out = prettyTime(raw)
      expect(out).not.toBe(raw)
      expect(out).not.toMatch(/\+0900|GMT|T\d{2}:\d{2}:\d{2}|\.000Z/)
      expect(out).toMatch(/\d/)
    }
  })
  it('leaves relative labels, bare times and unparseable look-alikes alone', () => {
    expect(prettyTime('2 hours ago')).toBe('2 hours ago')
    expect(prettyTime('09:00')).toBe('09:00')
    expect(prettyTime('sometime in November')).toBe('sometime in November')
    expect(prettyTime('Sun, 99 Xyz')).toBe('Sun, 99 Xyz')
  })
})
