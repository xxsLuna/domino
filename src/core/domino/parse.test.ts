import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDomino } from './parse'
import { applyScript, buildScriptContext } from './script'
import { evalCondition } from './conditions'

const sample = (name: string): string =>
  readFileSync(join(__dirname, '../../../samples', name), 'utf-8')

describe('parseDomino', () => {
  it('parses the example-crm sample', () => {
    const result = parseDomino(sample('example-crm.domino'))
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    const d = result.domino!
    expect(d.meta.name).toBe('ExampleCRM')
    expect(d.meta.home).toBe('main')
    expect(d.auth.required).toBe(true)
    expect(d.auth.loginEndpoint).toBe('https://api.example.com/auth/login')
    expect(d.auth.tokenKey).toBe('access_token')
    expect(d.auth.skipIfLoggedIn).toBe(true)
    expect(d.api.baseUrl).toBe('https://api.example.com')
    expect(d.api.allow).toContain('/leads/*')
    expect(d.ui.theme).toBe('dark')
    expect(d.ui.primary).toBe('#4f46e5')
    expect(d.ui.style).toBe('sharp')
    expect(d.ui.density).toBe('compact')
    expect(d.ui.success).toBe('#10b981')
    expect(d.script).toHaveLength(3)
    expect(d.id).toBe('ExampleCRM|https://api.example.com')
  })

  it('parses the no-auth sample', () => {
    const result = parseDomino(sample('notes-board.domino'))
    expect(result.ok).toBe(true)
    expect(result.domino!.auth.required).toBe(false)
    expect(result.domino!.ui.theme).toBe('light')
  })

  it('reports missing name with a line number', () => {
    const result = parseDomino('[meta]\nhome = main\n')
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain('name is required')
    expect(result.errors[0].line).toBe(1)
  })

  it('rejects content outside sections', () => {
    const result = parseDomino('oops = 1\n[meta]\nname = X\n')
    expect(result.ok).toBe(true)
    expect(result.errors[0].message).toContain('outside of any section')
  })

  it('flags required auth without login_endpoint', () => {
    const result = parseDomino('[meta]\nname = X\n[auth]\nrequired = true\n')
    expect(result.errors.some((e) => e.message.includes('login_endpoint'))).toBe(true)
  })

  it('keeps unknown keys as extras', () => {
    const result = parseDomino('[meta]\nname = X\ncustom_thing = hi\n')
    expect(result.ok).toBe(true)
    expect(result.domino!.extras.meta.custom_thing).toBe('hi')
  })

  it('reports bad script rules', () => {
    const result = parseDomino('[meta]\nname = X\n[script]\nthis is nonsense\n')
    expect(result.errors.some((e) => e.message.includes('bad script rule'))).toBe(true)
  })

  it('parses [ui] design theme keys and applies defaults', () => {
    const result = parseDomino(
      '[meta]\nname = X\n[ui]\nstyle = sharp\ndensity = compact\nradius = 2\nsuccess = #10b981\n'
    )
    const ui = result.domino!.ui
    expect(ui.style).toBe('sharp')
    expect(ui.density).toBe('compact')
    expect(ui.radius).toBe(2)
    expect(ui.success).toBe('#10b981')
    // defaults when [ui] omitted entirely
    const bare = parseDomino('[meta]\nname = Y\n').domino!.ui
    expect(bare.theme).toBe('auto')
    expect(bare.style).toBe('soft')
    expect(bare.density).toBe('comfortable')
    expect(bare.radius).toBeUndefined()
  })

  it('accepts theme = auto and rejects unknown themes', () => {
    const auto = parseDomino('[meta]\nname = X\n[ui]\ntheme = auto\n')
    expect(auto.ok).toBe(true)
    expect(auto.domino!.ui.theme).toBe('auto')
    const bad = parseDomino('[meta]\nname = X\n[ui]\ntheme = sepia\n')
    expect(bad.domino!.ui.theme).toBe('auto') // falls back
    expect(bad.errors.some((e) => e.message.includes('theme must be light, dark or auto'))).toBe(
      true
    )
  })

  it('rejects invalid [ui] design values', () => {
    const result = parseDomino('[meta]\nname = X\n[ui]\nstyle = chunky\nradius = huge\n')
    expect(result.domino!.ui.style).toBe('soft') // falls back
    expect(result.domino!.ui.radius).toBeUndefined()
    expect(result.errors.some((e) => e.message.includes('style must be'))).toBe(true)
    expect(result.errors.some((e) => e.message.includes('radius must be'))).toBe(true)
  })
})

describe('condition DSL', () => {
  const ctx = (vars: Record<string, unknown>) => ({ vars })

  it('evaluates identifiers and not', () => {
    expect(evalCondition('logged_in', ctx({ logged_in: true }))).toBe(true)
    expect(evalCondition('logged_in', ctx({ logged_in: false }))).toBe(false)
    expect(evalCondition('not logged_in', ctx({ logged_in: false }))).toBe(true)
  })

  it('evaluates dotted paths and comparisons', () => {
    expect(evalCondition('param.plan == "pro"', ctx({ param: { plan: 'pro' } }))).toBe(true)
    expect(evalCondition('param.plan == "pro"', ctx({ param: { plan: 'free' } }))).toBe(false)
    expect(evalCondition('count > 3', ctx({ count: 5 }))).toBe(true)
    expect(evalCondition('error == null', ctx({ error: null }))).toBe(true)
  })

  it('evaluates and/or/parens', () => {
    expect(
      evalCondition('logged_in and plan == "pro"', ctx({ logged_in: true, plan: 'pro' }))
    ).toBe(true)
    expect(
      evalCondition('logged_in and plan == "pro"', ctx({ logged_in: true, plan: 'free' }))
    ).toBe(false)
    expect(evalCondition('a == 1 or b == 2', ctx({ a: 0, b: 2 }))).toBe(true)
    expect(evalCondition('(a == 1 or b == 2) and c', ctx({ a: 0, b: 2, c: false }))).toBe(false)
  })

  it('returns false on syntax errors instead of throwing', () => {
    expect(evalCondition('a ==== b', ctx({}))).toBe(false)
  })
})

describe('applyScript', () => {
  const domino = parseDomino(sample('example-crm.domino')).domino!

  it('routes to login when logged out', () => {
    const out = applyScript(domino, buildScriptContext({ loggedIn: false }))
    expect(out.goto).toBe('login')
  })

  it('routes to main when logged in', () => {
    const out = applyScript(domino, buildScriptContext({ loggedIn: true }))
    expect(out.goto).toBe('main')
  })

  it('fires on-event rules', () => {
    const out = applyScript(domino, buildScriptContext({ loggedIn: true }), 'auth_failed')
    expect(out.goto).toBe('login')
  })

  it('first matching goto wins', () => {
    const gate = parseDomino(sample('plan-gate.domino')).domino!
    const out = applyScript(gate, buildScriptContext({ loggedIn: false }))
    expect(out.goto).toBe('login')
    const out2 = applyScript(
      gate,
      buildScriptContext({ loggedIn: true, error: 'billing', vars: { plan: 'pro' } })
    )
    expect(out2.goto).toBe('upgrade')
  })
})

describe('[guide] and meta description', () => {
  it('keeps guide prose verbatim, including ; and # and blank lines', () => {
    const res = parseDomino(`[meta]
name = Shop
description = Small storefront admin

[guide]
Admin console for a small shop; staff only.

# Endpoints
GET /orders -> list of {id, total, status}
[api]
allow = /orders
`)
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.domino?.meta.description).toBe('Small storefront admin')
    expect(res.domino?.guide).toBe(
      'Admin console for a small shop; staff only.\n\n# Endpoints\nGET /orders -> list of {id, total, status}'
    )
    expect(res.domino?.api.allow).toEqual(['/orders'])
  })

  it('omits guide when the section is absent', () => {
    expect(parseDomino('[meta]\nname = A').domino?.guide).toBeUndefined()
  })
})

describe('hardening', () => {
  it('rejects __proto__-style sections and keys without polluting extras', () => {
    const res = parseDomino('[meta]\nname = X\n[__proto__]\npolluted = yes\n[ui]\n__proto__ = x\n')
    expect(res.ok).toBe(true)
    expect(res.errors.some((e) => e.message.includes('unknown section'))).toBe(true)
    expect(res.errors.some((e) => e.message.includes('unsafe key'))).toBe(true)
    // extras must not pick up the attacker's key through the prototype chain
    expect((res.domino!.extras as Record<string, unknown>).polluted).toBeUndefined()
    expect((res.domino!.extras as Record<string, unknown>).x).toBeUndefined()
  })

  it('ends [guide] on a section header that carries a comment', () => {
    const res = parseDomino(
      '[meta]\nname = X\n[guide]\nprose here\n[api] ; endpoints\nallow = /a\n'
    )
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.domino?.guide).toBe('prose here')
    expect(res.domino?.api.allow).toEqual(['/a'])
  })

  it('reports a missing [meta] section instead of an empty error list', () => {
    const res = parseDomino('[api]\nallow = /x\n')
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.errors[0].message).toContain('name is required')
  })

  it('strips one layer of surrounding quotes from values', () => {
    const res = parseDomino('[meta]\nname = "Shop"\n[ui]\nprimary = \'#ff0000\'\n')
    expect(res.domino?.meta.name).toBe('Shop')
    expect(res.domino?.ui.primary).toBe('#ff0000')
  })

  it('rejects a malformed [script] condition at load time', () => {
    const res = parseDomino('[meta]\nname = X\n[script]\nwhen a ==== b -> goto main\n')
    expect(res.errors.some((e) => e.message.includes('bad condition'))).toBe(true)
    expect(res.domino?.script).toHaveLength(0)
  })

  it('treats NaN as false and compares strings naturally, not by code units', () => {
    expect(evalCondition('count', { vars: { count: NaN } })).toBe(false)
    expect(evalCondition('name > "item9"', { vars: { name: 'item10' } })).toBe(true)
  })

  it('never lets file vars shadow the built-in logged_in', () => {
    const ctx = buildScriptContext({ loggedIn: false, vars: { logged_in: true } })
    expect(ctx.vars.logged_in).toBe(false)
  })

  it('drops [ui] colors that would inject CSS through setProperty', () => {
    // Quoted so stripComment keeps the `;` — the only way a breakout survives.
    const res = parseDomino(
      '[meta]\nname = X\n[ui]\nprimary = "red; background-image: url(https://evil.test/x)"\n' +
        'danger = url(https://evil.test/x)\nsuccess = rgb(10 20 30 / 50%)\nwarning = rebeccapurple\n'
    )
    expect(res.ok).toBe(true)
    expect(res.domino?.ui.primary).toBeUndefined()
    expect(res.domino?.ui.danger).toBeUndefined()
    expect(res.domino?.ui.success).toBe('rgb(10 20 30 / 50%)')
    expect(res.domino?.ui.warning).toBe('rebeccapurple')
    expect(res.errors.filter((e) => e.message.includes('plain CSS color'))).toHaveLength(2)
  })
})

describe('[data] and [actions] sections', () => {
  it('parses data sources with interpolation and an every-interval', () => {
    const res = parseDomino(
      '[meta]\nname = X\n[data]\nfeed = GET /feed?url={rssUrl} every 20s\nonce = POST /ping\n'
    )
    expect(res.errors).toEqual([])
    expect(res.domino?.data).toEqual([
      { key: 'feed', method: 'GET', path: '/feed?url={rssUrl}', everySec: 20 },
      { key: 'once', method: 'POST', path: '/ping' }
    ])
  })

  it('reports malformed data declarations without dropping the rest', () => {
    const res = parseDomino('[meta]\nname = X\n[data]\nbad = /no-method\ngood = GET /ok\n')
    expect(res.domino?.data).toEqual([{ key: 'good', method: 'GET', path: '/ok' }])
    expect(res.errors.some((e) => e.message.includes('[data] bad'))).toBe(true)
  })

  it('rejects non-identifier interpolations in a data path', () => {
    const res = parseDomino('[meta]\nname = X\n[data]\nfeed = GET /f?u={a b}\n')
    expect(res.domino?.data).toHaveLength(0)
    expect(res.errors.some((e) => e.message.includes('interpolation'))).toBe(true)
  })

  it('parses FEED sources: absolute URL, bare {stateKey}, @subscriptions', () => {
    const res = parseDomino(
      '[meta]\nname = X\n[data]\n' +
        'fixed = FEED https://example.com/rss.xml every 60s\n' +
        'typed = FEED {rssUrl}\n' +
        'subs = FEED @subscriptions every 30s\n'
    )
    expect(res.errors).toEqual([])
    expect(res.domino?.data).toEqual([
      { key: 'fixed', method: 'FEED', path: 'https://example.com/rss.xml', everySec: 60 },
      { key: 'typed', method: 'FEED', path: '{rssUrl}' },
      { key: 'subs', method: 'FEED', path: '@subscriptions', everySec: 30 }
    ])
  })

  it('rejects a FEED path that is neither a URL, a bare state key nor @subscriptions', () => {
    const res = parseDomino('[meta]\nname = X\n[data]\nfeed = FEED /relative/rss.xml\n')
    expect(res.domino?.data).toHaveLength(0)
    expect(res.errors.some((e) => e.message.includes('FEED needs'))).toBe(true)
  })

  it('rejects unknown methods with the FEED example in the message', () => {
    const res = parseDomino('[meta]\nname = X\n[data]\nfeed = HEAD /rss.xml\n')
    expect(res.errors.some((e) => e.message.includes('FEED <url>'))).toBe(true)
  })

  it('parses action rules as ordered steps keyed by node id', () => {
    const res = parseDomino(
      '[meta]\nname = X\n[data]\nfeed = GET /feed\n[actions]\n' +
        'add-feed-form = set rssUrl = form.url ; refresh feed ; goto feed\n' +
        'feed-refresh = refresh feed\n'
    )
    expect(res.errors).toEqual([])
    expect(res.domino?.actions).toEqual([
      {
        id: 'add-feed-form',
        steps: [
          { kind: 'set', stateKey: 'rssUrl', formField: 'url' },
          { kind: 'refresh', source: 'feed' },
          { kind: 'goto', page: 'feed' }
        ]
      },
      { id: 'feed-refresh', steps: [{ kind: 'refresh', source: 'feed' }] }
    ])
  })

  it('flags refresh steps naming an undeclared source', () => {
    const res = parseDomino('[meta]\nname = X\n[actions]\nrefresh-feed = refresh nope\n')
    expect(res.errors.some((e) => e.message.includes('no such [data] source'))).toBe(true)
  })

  it('flags a bad action step but keeps the valid ones', () => {
    const res = parseDomino(
      '[meta]\nname = X\n[actions]\nbad = explode everything\ngood = goto main\n'
    )
    expect(res.domino?.actions).toEqual([{ id: 'good', steps: [{ kind: 'goto', page: 'main' }] }])
    expect(res.errors.some((e) => e.message.includes('bad step'))).toBe(true)
  })
})

describe('[screens] embedded app export', () => {
  const spec = { version: 1, page: 'main', pages: [{ id: 'main', name: '메인', layout: [] }] }

  it('parses an embedded spec and action graph', () => {
    const file = [
      '[meta]',
      'name = X',
      '[screens]',
      `spec = ${JSON.stringify(spec)}`,
      `graph = ${JSON.stringify([
        { from: 'main', to: 'saved', action: 'go-saved', label: '저장함', kind: 'action' }
      ])}`,
      '[guide]',
      '가이드'
    ].join('\n')
    const res = parseDomino(file)
    expect(res.errors).toEqual([])
    expect(res.domino?.screens?.spec).toEqual(spec)
    expect(res.domino?.screens?.graph).toHaveLength(1)
    expect(res.domino?.guide).toBe('가이드')
  })

  it('rejects a broken spec JSON but keeps the rest of the file usable', () => {
    const res = parseDomino('[meta]\nname = X\n[screens]\nspec = {not-json')
    expect(res.ok).toBe(true)
    expect(res.domino?.screens).toBeUndefined()
    expect(res.errors.some((e) => e.message.includes('[screens] spec'))).toBe(true)
  })

  it('keeps JSON semicolons intact (raw collection, no comment stripping)', () => {
    const withSemi = { ...spec, pages: [{ id: 'a;b', name: 'x', layout: [] }] }
    const res = parseDomino(`[meta]\nname = X\n[screens]\nspec = ${JSON.stringify(withSemi)}`)
    expect(res.domino?.screens?.spec.pages[0].id).toBe('a;b')
  })
})
