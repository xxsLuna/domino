import { describe, expect, it } from 'vitest'
import { getComponent, withRegistryNames } from './registry'

describe('getComponent (names as models write them)', () => {
  it('resolves registered names exactly', () => {
    expect(getComponent('Table')?.name).toBe('Table')
    expect(getComponent('Section')?.name).toBe('Section')
  })
  it('forgives case and punctuation slips', () => {
    expect(getComponent('TextArea')?.name).toBe('Textarea')
    expect(getComponent('page-header')?.name).toBe('PageHeader')
    expect(getComponent('stat_card')?.name).toBe('StatCard')
  })
  it('maps names from other UI kits', () => {
    expect(getComponent('Text')?.name).toBe('Paragraph')
    expect(getComponent('TextField')?.name).toBe('Input')
    expect(getComponent('DataTable')?.name).toBe('Table')
    expect(getComponent('Dropdown')?.name).toBe('Select')
  })
  it('still rejects names it cannot place', () => {
    expect(getComponent('Carousel')).toBeUndefined()
  })
})

describe('withRegistryNames', () => {
  it('rewrites aliases throughout the tree and keeps unchanged specs as is', () => {
    const spec = {
      version: 1 as const,
      page: 'p',
      pages: [{ id: 'p', name: 'P', layout: [{ name: 'Form', children: [{ name: 'button' }, { name: 'TextField' }] }] }]
    }
    const out = withRegistryNames(spec)
    expect(out.pages[0].layout[0].children?.map((c) => c.name)).toEqual(['Button', 'Input'])
    expect(withRegistryNames(out)).toBe(out)
  })
})
