import { describe, expect, it } from 'vitest'
import { parseDomino } from './domino/parse'
import type { DominoFile } from './domino/types'
import type { UiSpec } from './spec'
import {
  observedDests,
  pageMapLines,
  buildPageGraph,
  collectActions,
  loadPageGraph,
  pruneEdgesForPage,
  savePageGraph,
  toMermaid,
  upsertAnswerEdge,
  upsertEdge,
  type GraphEdge
} from './pageGraph'

const dominoOf = (source: string): DominoFile => parseDomino(source).domino!

const specOf = (pages: Array<{ id: string; name: string; layout: unknown[] }>): UiSpec =>
  ({ version: 1, page: pages[0].id, pages }) as UiSpec

describe('collectActions', () => {
  it('finds buttons, forms and row tables with labels', () => {
    const spec = specOf([
      {
        id: 'main',
        name: '메인',
        layout: [
          { name: 'Button', id: 'go-saved', props: { text: '저장함' } },
          { name: 'Form', id: 'add-feed-form', props: { title: '구독 추가' } },
          { name: 'Table', id: 't', props: { rowAction: true } },
          { name: 'Button', id: 'n1', props: { text: '+', stateKey: 'count', delta: 1 } },
          { name: 'Paragraph', id: 'p', props: { text: '버튼 아님' } }
        ]
      }
    ])
    const domino = dominoOf('[meta]\nname = X\n')
    const actions = collectActions(spec, domino)
    expect(actions.map((a) => [a.id, a.kind])).toEqual([
      ['go-saved', 'button'],
      ['add-feed-form', 'form'],
      ['t', 'row'],
      ['n1', 'state']
    ])
    expect(actions[1].label).toBe('구독 추가 제출')
  })

  it('marks widgets whose id has an [actions] rule as runtime-bound', () => {
    const spec = specOf([
      {
        id: 'feed',
        name: '피드',
        layout: [{ name: 'Button', id: 'feed-refresh', props: { text: '새로고침' } }]
      }
    ])
    const domino = dominoOf('[meta]\nname = X\n[actions]\nfeed-refresh = refresh feed\n')
    const actions = collectActions(spec, domino)
    expect(actions[0].bound).toBe(true)
  })
})

describe('buildPageGraph', () => {
  const domino = dominoOf(
    '[meta]\nname = X\n[data]\nfeed = GET /feed\n[actions]\nfeed-refresh = refresh feed\nadd-feed-form = set url = form.url ; refresh feed ; goto feed\n'
  )
  const spec = specOf([
    {
      id: 'main',
      name: '메인',
      layout: [
        { name: 'Form', id: 'add-feed-form', props: { title: '구독 추가' } },
        { name: 'Button', id: 'go-saved', props: { text: '저장함 보기' } }
      ]
    },
    {
      id: 'feed',
      name: '피드',
      layout: [{ name: 'Button', id: 'feed-refresh', props: { text: '새로고침' } }]
    },
    { id: 'saved', name: '저장함', layout: [] }
  ])
  const nav = [
    { id: 'main', label: '홈' },
    { id: 'feed', label: '피드' },
    { id: 'saved', label: '저장함' }
  ]

  it('derives nav edges, bound destinations and live-gen placeholders', () => {
    const graph = buildPageGraph(spec, nav, domino, [])
    // 탭 바 → pages (resolved), bound refresh → self data edge,
    // bound goto → feed, unbound button → '' (공갈).
    const navTargets = graph.edges
      .filter((e) => e.kind === 'nav')
      .map((e) => e.to)
      .sort()
    expect(navTargets).toEqual(['feed', 'main', 'saved'])
    const refresh = graph.edges.find((e) => e.action === 'feed-refresh')!
    expect(refresh.kind).toBe('data')
    expect(refresh.to).toBe('feed')
    const addFeed = graph.edges.find((e) => e.action === 'add-feed-form')!
    expect(addFeed.to).toBe('feed')
    const saved = graph.edges.find((e) => e.action === 'go-saved')!
    expect(saved.to).toBe('') // not built/pressed yet → 실시간 생성
  })

  it('observed edges beat the placeholder destination', () => {
    const observed: GraphEdge[] = [
      { from: 'main', to: 'saved', action: 'go-saved', label: '저장함 보기', kind: 'action' }
    ]
    const graph = buildPageGraph(spec, nav, domino, observed)
    const saved = graph.edges.find((e) => e.action === 'go-saved')!
    expect(saved.to).toBe('saved')
  })

  it('mermaid output keeps unknown actions wired to the live-gen phantom', () => {
    const graph = buildPageGraph(spec, nav, domino, [])
    const code = toMermaid(graph)
    expect(code).toContain('flowchart TD')
    expect(code).toContain('실시간 생성')
    expect(code).toContain('피드 (feed)')
    // The 공갈 button must not dead-end: it links to the phantom node.
    expect(code).toMatch(/a_main_go_saved.*실시간 생성/s)
  })

  it('upsertEdge dedupes by page+action+kind, newest destination wins', () => {
    const a: GraphEdge = { from: 'main', to: 'a', action: 'x', label: 'X', kind: 'action' }
    const b: GraphEdge = { from: 'main', to: 'b', action: 'x', label: 'X', kind: 'action' }
    const edges = upsertEdge(upsertEdge([], a), b)
    expect(edges).toHaveLength(1)
    expect(edges[0].to).toBe('b')
  })
})

describe('pageMapLines (the model-facing app map)', () => {
  it('lists pages, connected actions and unconnected buttons', () => {
    const spec = specOf([
      {
        id: 'main',
        name: '메인',
        layout: [
          { name: 'Form', id: 'add', props: { title: '구독' } },
          { name: 'Button', id: 'go-saved', props: { text: '저장함' } }
        ]
      },
      { id: 'saved', name: '저장함', layout: [] }
    ])
    const domino = dominoOf('[meta]\nname = X\n')
    const observed: GraphEdge[] = [
      { from: 'main', to: 'saved', action: 'go-saved', label: '저장함', kind: 'action' }
    ]
    const lines = pageMapLines(spec, [], domino, observed)
    expect(lines[0]).toContain('main: 메인')
    expect(lines[0]).toContain('saved: 저장함')
    expect(lines.some((l) => l.includes('저장함 → saved'))).toBe(true)
    expect(lines.some((l) => l.includes('구독 제출'))).toBe(true) // unconnected form
  })
})

describe('observedDests (pre-gen targets from the observed graph)', () => {
  const edge = (over: Partial<GraphEdge>): GraphEdge => ({
    from: 'main',
    to: 'saved',
    action: 'go',
    label: 'Go',
    kind: 'action',
    ...over
  })

  it('collects unique destinations of action edges, in first-seen order', () => {
    const edges = [
      edge({ to: 'saved' }),
      edge({ to: 'detail' }),
      edge({ to: 'saved' }) // duplicate destination
    ]
    expect(observedDests(edges)).toEqual(['saved', 'detail'])
  })

  it('ignores empty destinations and non-action edges', () => {
    const edges = [
      edge({ to: '' }), // live-generating press: no destination yet
      edge({ kind: 'nav' }),
      edge({ kind: 'data' }),
      edge({ kind: 'form' }),
      edge({ kind: 'state' }),
      edge({ to: 'settings' })
    ]
    expect(observedDests(edges)).toEqual(['settings'])
  })

  it('is empty for an empty graph', () => {
    expect(observedDests([])).toEqual([])
  })
})

describe('self-loops and data actions', () => {
  const spec = specOf([
    {
      id: 'list',
      name: '목록',
      layout: [
        { name: 'Table', id: 'rows', props: { rowAction: true } },
        { name: 'Button', id: 'refresh-list', props: { text: '새로고침' } },
        { name: 'Button', id: 'go-new', props: { text: '새 항목' } }
      ]
    },
    { id: 'detail', name: '상세', layout: [] },
    { id: 'new', name: '새 항목', layout: [] }
  ])
  const domino = dominoOf('[meta]\nname = X\n')

  it('keeps in-place updates off the map and lists data actions on their own line', () => {
    const observed: GraphEdge[] = [
      { from: 'list', to: 'list', action: 'refresh-list', label: '새로고침', kind: 'action' },
      { from: 'list', to: 'detail', action: 'rows', label: '행 선택', kind: 'action' },
      { from: 'list', to: 'new', action: 'go-new', label: '새 항목', kind: 'action' }
    ]
    const lines = pageMapLines(spec, [], domino, observed)
    const connected = lines.find((l) => l.startsWith('Connected actions'))!
    const data = lines.find((l) => l.startsWith('Data actions'))!
    expect(connected).toContain('list/새 항목 → new')
    expect(connected).not.toContain('새로고침')
    expect(connected).not.toContain('detail')
    expect(data).toContain('list/행 선택 → detail')
  })

  it('observedDests skips self-loops', () => {
    expect(
      observedDests([
        { from: 'list', to: 'list', action: 'x', label: 'X', kind: 'action' },
        { from: 'list', to: 'new', action: 'y', label: 'Y', kind: 'action' }
      ])
    ).toEqual(['new'])
  })

  it('loadPageGraph drops persisted self-loop action edges', async () => {
    const store = new Map<string, string>()
    const storage = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      remove: async (k: string) => void store.delete(k)
    }
    await savePageGraph(storage, 'd', [
      { from: 'list', to: 'list', action: 'del', label: 'Delete', kind: 'action' },
      { from: 'list', to: 'list', action: 'ref', label: 'Refresh', kind: 'data' },
      { from: 'list', to: 'new', action: 'go-new', label: 'New', kind: 'action' }
    ])
    const edges = await loadPageGraph(storage, 'd')
    expect(edges.map((e) => e.action)).toEqual(['ref', 'go-new'])
  })

  it('upsertAnswerEdge keeps one answer per page+action across action/form kinds', () => {
    const link: GraphEdge = { from: 'p', to: 'a', action: 'x', label: 'X', kind: 'action' }
    const write: GraphEdge = { from: 'p', to: 'b', action: 'x', label: 'X', kind: 'form' }
    const nav: GraphEdge = { from: 'p', to: 'c', action: 'x', label: 'X', kind: 'nav' }
    const edges = upsertAnswerEdge(upsertAnswerEdge([link, nav], write), write)
    expect(edges).toEqual([nav, write])
  })

  it('pruneEdgesForPage drops edges whose widget left the edited page', () => {
    const edges: GraphEdge[] = [
      { from: 'list', to: 'new', action: 'go-new', label: 'New', kind: 'action' },
      { from: 'list', to: 'old', action: 'gone', label: 'Gone', kind: 'action' },
      { from: 'other', to: 'old', action: 'gone', label: 'Gone', kind: 'action' }
    ]
    const page = { id: 'list', layout: [{ name: 'Button', id: 'go-new' }] }
    expect(pruneEdgesForPage(edges, page).map((e) => `${e.from}/${e.action}`)).toEqual([
      'list/go-new',
      'other/gone'
    ])
    const untouched = edges.slice(0, 1)
    expect(pruneEdgesForPage(untouched, page)).toBe(untouched)
  })
})
