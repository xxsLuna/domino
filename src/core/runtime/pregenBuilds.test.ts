import { describe, expect, it } from 'vitest'
import type { UiSpec } from '../spec'
import { PregenBuilds, runPool, type BuildResult } from './pregenBuilds'

const spec = (page: string): UiSpec => ({
  version: 1,
  page,
  pages: [{ id: page, name: page, layout: [] }]
})

/** A controllable build: emit previews, then finish with a result. */
function controlled(): {
  run: (b: { controller: AbortController }, preview: (s: UiSpec) => void) => Promise<BuildResult>
  preview: (s: UiSpec) => void
  finish: (r: BuildResult) => void
} {
  let emit: (s: UiSpec) => void = () => {}
  let finish: (r: BuildResult) => void = () => {}
  return {
    run: (_b, preview) => {
      emit = preview
      return new Promise<BuildResult>((r) => (finish = r))
    },
    preview: (s) => emit(s),
    finish: (r) => finish(r)
  }
}

describe('PregenBuilds', () => {
  it('settles an unadopted build in the background', async () => {
    const builds = new PregenBuilds()
    const c = controlled()
    const seen: BuildResult[] = []
    const b = builds.start('page:a', 'page', 'a', c.run, (r) => (seen.push(r), true))
    expect(builds.has('page:a')).toBe(true)
    c.finish({ spec: spec('a'), deps: {} })
    await b.done
    expect(seen).toHaveLength(1)
    expect(builds.has('page:a')).toBe(false)
  })

  it('hands previews and the result to an adopter instead', async () => {
    const builds = new PregenBuilds()
    const c = controlled()
    const background: BuildResult[] = []
    const b = builds.start('page:a', 'page', 'a', c.run, (r) => (background.push(r), true))
    c.preview(spec('early'))
    expect(b.preview?.page).toBe('early')
    const previews: string[] = []
    const settled: BuildResult[] = []
    const adopted = builds.adopt('page:a', {
      onPreview: (s) => previews.push(s.page),
      onSettle: (r) => (settled.push(r), true)
    })
    expect(adopted).toBe(b)
    c.preview(spec('late'))
    c.finish({ spec: spec('a'), deps: { 'GET /x': 'h' } })
    await b.done
    expect(previews).toEqual(['late'])
    expect(settled).toHaveLength(1)
    expect(background).toHaveLength(0)
  })

  it('falls back to the background settle when the adopter declines or left', async () => {
    const builds = new PregenBuilds()
    const c1 = controlled()
    const bg: string[] = []
    const b1 = builds.start('page:a', 'page', 'a', c1.run, () => (bg.push('a'), true))
    builds.adopt('page:a', { onPreview: () => {}, onSettle: () => false })
    c1.finish({ spec: spec('a'), deps: {} })
    await b1.done

    const c2 = controlled()
    const b2 = builds.start('page:b', 'page', 'b', c2.run, () => (bg.push('b'), true))
    const adoption = { onPreview: () => {}, onSettle: () => true }
    builds.adopt('page:b', adoption)
    builds.release(b2, adoption)
    c2.finish({ spec: spec('b'), deps: {} })
    await b2.done
    expect(bg).toEqual(['a', 'b'])
  })

  it('returns the running build for a duplicate key and cancels all', async () => {
    const builds = new PregenBuilds()
    const c = controlled()
    const b = builds.start('page:a', 'page', 'a', c.run, () => true)
    expect(builds.start('page:a', 'page', 'a', controlled().run, () => true)).toBe(b)
    builds.cancelAll()
    expect(b.controller.signal.aborted).toBe(true)
    expect(builds.size).toBe(0)
    expect(builds.adopt('page:a', { onPreview: () => {}, onSettle: () => true })).toBeNull()
  })

  it('treats a throwing build as a null result', async () => {
    const builds = new PregenBuilds()
    const seen: BuildResult[] = []
    const b = builds.start(
      'page:a',
      'page',
      'a',
      () => Promise.reject(new Error('boom')),
      (r) => (seen.push(r), true)
    )
    await b.done
    expect(seen).toEqual([{ spec: null, deps: {} }])
  })
})

describe('runPool', () => {
  it('never exceeds the concurrency and runs every item', async () => {
    let active = 0
    let peak = 0
    const done: number[] = []
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      done.push(n)
      active--
    })
    expect(peak).toBe(2)
    expect(done.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('stops pulling once stop() is true and survives a failing item', async () => {
    const seen: number[] = []
    await runPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        seen.push(n)
        if (n === 1) throw new Error('x')
      },
      () => seen.length >= 2
    )
    expect(seen).toEqual([1, 2])
  })
})
