import { describe, expect, it } from 'vitest'
import { isNewer } from './version'

describe('isNewer', () => {
  it('compares dotted versions numerically', () => {
    expect(isNewer('0.3.0', '0.2.9')).toBe(true)
    expect(isNewer('v0.10.0', '0.9.3')).toBe(true)
    expect(isNewer('1.0.0', '1.0')).toBe(false)
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
  })
  it('ignores pre-release suffixes', () => {
    expect(isNewer('0.3.0-beta.1', '0.2.0')).toBe(true)
    expect(isNewer('0.3.0-beta.1', '0.3.0')).toBe(false)
  })
})
