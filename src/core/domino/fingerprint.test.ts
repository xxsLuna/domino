import { describe, expect, it } from 'vitest'
import { parseDomino } from './parse'
import { dominoFingerprint } from './fingerprint'

const BASE = [
  '[meta]',
  'name = X',
  'home = main',
  '[api]',
  'base_url = https://api.test',
  'allow = /a, /b',
  '[ui]',
  'theme = dark',
  '[pages]',
  'main = Main | | nav',
  '[data]',
  'a = GET /a',
  'b = GET /b',
  '[guide]',
  'Brief.'
].join('\n')

const fp = (text: string): string => dominoFingerprint(parseDomino(text).domino!)

const EMBED =
  '[screens]\nspec = {"version":1,"page":"main","pages":[{"id":"main","name":"M","layout":[]}]}'

describe('dominoFingerprint', () => {
  it('is stable across ui, comments, whitespace, set order and the [screens] embed', () => {
    const base = fp(BASE)
    expect(base).toMatch(/^d1-[0-9a-z]+$/)
    expect(fp(BASE.replace('theme = dark', 'theme = light\nprimary = #ff0000'))).toBe(base)
    expect(fp(BASE.replace('allow = /a, /b', 'allow = /b, /a ; reordered'))).toBe(base)
    expect(fp(BASE.replace('a = GET /a\nb = GET /b', 'b = GET /b\na = GET /a'))).toBe(base)
    expect(fp(BASE.replace('Brief.', 'Brief.   \n\n\n'))).toBe(base)
    expect(fp(`${BASE.replace('[guide]', `${EMBED}\n[guide]`)}`)).toBe(base)
  })

  it('changes with anything a built screen depends on', () => {
    const base = fp(BASE)
    const variants = [
      BASE.replace('home = main', 'home = other'),
      BASE.replace('allow = /a, /b', 'allow = /a, /b, /c'),
      BASE.replace('main = Main | | nav', 'main = Main | | nav\nmore = More'),
      BASE.replace('main = Main | | nav', 'main = Main'),
      BASE.replace('a = GET /a', 'a = GET /a every 10s'),
      BASE.replace('Brief.', 'Another brief.'),
      BASE.replace('[guide]', '[actions]\ngo = goto main\n[guide]'),
      BASE.replace('[ui]', '[auth]\nrequired = true\nlogin_endpoint = /login\n[ui]')
    ]
    for (const v of variants) expect(fp(v), v).not.toBe(base)
  })
})
