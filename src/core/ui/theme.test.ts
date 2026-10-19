import { describe, expect, it } from 'vitest'
import type { UiSection } from '../domino/types'
import { isSafeCssColor, themeVars } from './theme'

describe('isSafeCssColor', () => {
  it('accepts hex, keywords and color functions', () => {
    for (const v of [
      '#fff',
      '#ffffff',
      '#4f46e5',
      '#00000000',
      'red',
      'rebeccapurple',
      'transparent',
      'rgb(10 20 30 / 50%)',
      'rgba(0,0,0,0.5)',
      'hsl(210 50% 40%)',
      'oklch(0.7 0.1 210)',
      'color-mix(in oklab, red, blue)',
      'var(--brand, #fff)'
    ]) {
      expect(isSafeCssColor(v), v).toBe(true)
    }
  })

  it('rejects declaration breakouts, url() and oversized values', () => {
    for (const v of [
      'red; background-image: url(https://evil.test/x)',
      'red} body { display: none',
      'url(https://evil.test/x)',
      'URL(https://evil.test/x)',
      'expression(alert(1))',
      'javascript:alert(1)',
      '"red; --x: 1"',
      'red; --stolen: attr(data-secret)',
      'calc(1px + 2)',
      '',
      '  ' + 'x'.repeat(101)
    ]) {
      expect(isSafeCssColor(v), v).toBe(false)
    }
  })
})

describe('themeVars', () => {
  const ui = (patch: Partial<UiSection>): UiSection => ({
    theme: 'auto',
    style: 'soft',
    density: 'comfortable',
    ...patch
  })

  it('maps safe colors onto tokens and derives the foreground', () => {
    const vars = themeVars(ui({ primary: '#ffffff', success: 'green' }))
    expect(vars['--accent']).toBe('#ffffff')
    expect(vars['--accent-foreground']).toBe('var(--eclipse)') // white bg → dark text
    expect(vars['--success']).toBe('green')
  })

  it('never writes an unsafe color or a non-finite radius into CSSOM', () => {
    const vars = themeVars(
      ui({
        primary: 'red; --stolen: 1',
        danger: 'url(https://evil.test/x)',
        radius: Number.NaN
      })
    )
    expect(vars['--accent']).toBeUndefined()
    expect(vars['--danger']).toBeUndefined()
    expect(Object.keys(vars)).toEqual([])
  })
})
