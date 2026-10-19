import { describe, expect, it } from 'vitest'
import { parseDomino } from '../domino/parse'
import type { UiSpec } from '../spec'
import { MAX_PREGEN_TARGETS, mergeKnownPage, pregenTargets } from './pregen'

const domino = (source: string) => parseDomino(source).domino!

const spec = (page: string, pages: string[], nav: string[] = []): UiSpec => ({
  version: 1,
  page,
  nav: nav.map((id) => ({ id, label: id })),
  pages: pages.map((id) => ({ id, name: id, layout: [] }))
})

describe('pregenTargets', () => {
  it('takes nav tabs first, then scripted goto/render pages, minus known ones', () => {
    const d = domino(
      '[meta]\nname = X\n[script]\nwhen error == "billing" -> goto upgrade\non logout -> render feedback\n'
    )
    const targets = pregenTargets(d, spec('main', ['main'], ['main', 'leads', 'reports']), true)
    expect(targets).toEqual(['leads', 'reports', 'upgrade'])
  })

  it('caps at three targets', () => {
    const d = domino('[meta]\nname = X\n')
    const targets = pregenTargets(
      d,
      spec('a', ['a'], ['a', 'b', 'c', 'd', 'e']),
      true
    )
    expect(targets).toHaveLength(MAX_PREGEN_TARGETS)
    expect(targets).toEqual(['b', 'c', 'd'])
  })

  it('dedupes pages that appear in both nav and script', () => {
    const d = domino('[meta]\nname = X\n[script]\nwhen logged_in -> goto settings\n')
    const targets = pregenTargets(d, spec('main', ['main'], ['settings', 'main']), true)
    expect(targets).toEqual(['settings'])
  })

  it('never targets the login page', () => {
    const d = domino('[meta]\nname = X\n[script]\non auth_failed -> goto login\n')
    expect(pregenTargets(d, spec('main', ['main'], ['main']), true)).toEqual([])
  })

  it('builds nothing while signed out of an auth-required app', () => {
    const d = domino(
      '[meta]\nname = X\n[auth]\nrequired = true\nlogin_endpoint = /login\n[script]\nwhen logged_in -> goto main\n'
    )
    expect(pregenTargets(d, spec('login', ['login']), false)).toEqual([])
    expect(pregenTargets(d, spec('login', ['login']), true)).toEqual(['main'])
  })

  it('skips everything when nothing is missing', () => {
    const d = domino('[meta]\nname = X\n')
    expect(pregenTargets(d, spec('a', ['a', 'b'], ['a', 'b']), true)).toEqual([])
  })
})

describe('mergeKnownPage', () => {
  const base = spec('dash', ['dash', 'leads'], ['dash', 'leads'])

  it('inserts the new page and keeps page/nav/other pages untouched', () => {
    const built = spec('reports', ['reports'], ['dash', 'reports'])
    const merged = mergeKnownPage(base, built, 'reports')
    expect(merged.pages.map((p) => p.id)).toEqual(['reports', 'dash', 'leads'])
    expect(merged.page).toBe('dash')
    expect(merged.nav).toEqual(base.nav)
  })

  it('replaces an existing page of the same id', () => {
    const rebuilt = { ...spec('leads', ['leads']), pages: [{ id: 'leads', name: 'v2', layout: [] }] }
    const merged = mergeKnownPage(base, rebuilt, 'leads')
    expect(merged.pages.map((p) => p.id)).toEqual(['leads', 'dash'])
    expect(merged.pages[0].name).toBe('v2')
  })

  it('discards a build that rendered some other page', () => {
    const wrong = spec('other', ['other'])
    expect(mergeKnownPage(base, wrong, 'reports')).toEqual(base)
  })
})
