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
