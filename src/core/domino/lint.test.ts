import { describe, expect, it } from 'vitest'
import { parseDomino } from './parse'
import { lintDomino } from './lint'

const lint = (text: string): string[] => {
  const res = parseDomino(text)
  if (!res.domino) throw new Error(JSON.stringify(res.errors))
  return lintDomino(res.domino).map((e) => e.message)
}

describe('lintDomino', () => {
  it('flags goto login in an app without [auth]', () => {
    const msgs = lint('[meta]\nname = X\n[script]\nwhen not logged_in -> goto login\n')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('goto login')
    expect(msgs[0]).toContain('"goto main"')
  })

  it('flags a boot route that misses [meta] home (no [pages] plan)', () => {
    const msgs = lint(
      '[meta]\nname = X\nhome = dashboard\n[auth]\nrequired = true\nlogin_endpoint = /l\n' +
        '[script]\nwhen not logged_in -> goto login\nwhen logged_in -> goto main\n'
    )
    expect(msgs).toEqual([
      '[script] sends a signed-in user to "main", but [meta] home is "dashboard" — use the same page id'
    ])
  })

  it('flags [data] / call paths outside [api] allow, but not FEED sources', () => {
    const msgs = lint(
      '[meta]\nname = X\n[api]\nbase_url = https://api.test\nallow = /leads, /leads/*\n' +
        '[data]\nleads = GET /leads?stage={stage}\nstats = GET /stats\n' +
        'rss = FEED https://example.com/rss.xml\n' +
        '[actions]\nsave = call POST /leads with form\nwipe = call DELETE /admin/{row.id}\n'
    )
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toContain('[data] stats: /stats is not covered by [api] allow')
    expect(msgs[1]).toContain('[actions] wipe: call DELETE /admin/{row.id} is not covered')
  })

  it('flags relative paths without a base_url', () => {
    const msgs = lint('[meta]\nname = X\n[api]\nallow = /x\n[data]\nx = GET /x\n')
    expect(msgs[0]).toContain('no base_url')
  })

  it('is quiet for a consistent definition', () => {
    expect(
      lint(
        [
          '[meta]',
          'name = X',
          'home = leads',
          '[auth]',
          'required = true',
          'login_endpoint = /login',
          '[api]',
          'base_url = https://api.test',
          'allow = /login, /leads, /leads/*',
          '[pages]',
          'leads = Leads | the list | nav',
          'lead-new = New lead',
          '[script]',
          'when not logged_in -> goto login',
          'when logged_in -> goto leads',
          '[data]',
          'leads = GET /leads',
          '[actions]',
          'new-lead-form = call POST /leads with form ; refresh leads ; goto leads'
        ].join('\n')
      )
    ).toEqual([])
  })
})
