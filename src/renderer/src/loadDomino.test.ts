import { describe, expect, it, vi } from 'vitest'

// The loader's platform/i18n edges need a browser; the parsing contract
// under test doesn't.
vi.mock('./platform', () => {
  const store = new Map<string, string>()
  return {
    isElectron: () => false,
    getStorage: () => ({
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      remove: async (k: string) => void store.delete(k)
    })
  }
})
vi.mock('./i18n', () => ({ t: (key: string) => key }))

const { DominoLoadError, loadAndParse, parseLoaded } = await import('./loadDomino')

const FILE = [
  '[meta]',
  'name = Shop',
  'home = main',
  'colour = red',
  '[pages]',
  'main = Main | | nav',
  '[data]',
  'orders = POST /orders',
  '[actions]',
  'go = goto checkout'
].join('\n')

describe('loadDomino warnings', () => {
  it('surfaces non-fatal parse warnings on the loaded result', async () => {
    const loaded = await loadAndParse({ type: 'text', text: FILE })
    expect(loaded.name).toBe('Shop')
    const msgs = loaded.warnings.map((w) => `${w.line}: ${w.message}`)
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toMatch(/^4: \[meta\] unknown key "colour"/)
    expect(msgs[1]).toMatch(/^8: \[data\] orders: POST is not allowed/)
    expect(msgs[2]).toMatch(/^10: \[actions\] go: goto "checkout" is not a page in \[pages\]/)
  })

  it('parseLoaded matches loadAndParse and returns null for a fatal file', () => {
    expect(parseLoaded(FILE, { type: 'text', text: FILE })?.warnings).toHaveLength(3)
    // The exact text it was parsed from travels along (export/share use it).
    expect(parseLoaded(FILE, { type: 'text', text: FILE })?.text).toBe(FILE)
    expect(parseLoaded('[meta]\nhome = x\n', { type: 'text', text: '' })).toBeNull()
  })

  it('still fails with diagnostics when the file cannot open', async () => {
    await expect(loadAndParse({ type: 'text', text: '[api]\n' })).rejects.toBeInstanceOf(
      DominoLoadError
    )
  })
})
