import { describe, expect, it } from 'vitest'
import { hasIcon } from './icons'

describe('hasIcon (names as models write them)', () => {
  it('knows the canonical names', () => {
    expect(hasIcon('home')).toBe(true)
    expect(hasIcon('login')).toBe(true)
  })
  it('maps lucide / material spellings onto the set', () => {
    for (const name of ['log-in', 'LogIn', 'trending-up', 'TrendingUp', 'dollar-sign', 'trash-2', 'mdi-account-outline', 'settings_outlined', 'check-circle'])
      expect(hasIcon(name), name).toBe(true)
  })
  it('falls back to the family base icon', () => {
    expect(hasIcon('calendar-days')).toBe(true)
    expect(hasIcon('shield-check')).toBe(true)
    expect(hasIcon('users-round')).toBe(true)
  })
  it('rejects what it cannot place', () => {
    expect(hasIcon('xyzzy')).toBe(false)
    expect(hasIcon(42)).toBe(false)
  })
})
