import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@heroui/react'
import { buildPageGraph, toMermaid, type GraphEdge } from '@core/pageGraph'
import type { DominoFile } from '@core/domino/types'
import type { NavItem, UiSpec } from '@core/spec'
import { Icon } from '@core/ui/icons'
import { useSystemTheme } from '../useSystemTheme'

/**
 * 페이지 관계도 — the developer-menu mermaid view of the app the agent has
 * built: every page, every action button on it, and where that action leads
 * (a page, an in-place data refresh, or the live-generation phantom for
 * buttons whose page doesn't exist yet).
 *
 * The canvas is a FIXED viewport over a transformed layer — a map/diagram
 * canvas, not a growing image: zoom scales the diagram inside the view
 * (mermaid's svg is vector, so text stays crisp with zero re-renders), pan is
 * drag/wheel, and pinch works on touch. The theme follows the app's light/
 * dark scheme; the toolbar offers ± zoom, percent-reset and the legend.
 */
let mermaidRef: (typeof import('mermaid'))['default'] | null = null

const MIN_ZOOM = 0.3
const MAX_ZOOM = 3
const ZOOM_STEP = 1.25
const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

interface View {
  z: number
  tx: number
  ty: number
}

interface PageGraphDialogProps {
  open: boolean
  onClose: () => void
  /** The known spec (currentSpec carries every delivered page). */
  spec: UiSpec | null
  nav: NavItem[]
  domino: DominoFile
  edges: GraphEdge[]
  /** Bumped whenever an edge is recorded — recomputes while open. */
  tick: number
}

/**
 * A dev panel must never take the runtime down with it: if the diagram (or
 * anything inside the dialog body) throws, show the failure in place.
 */
class GraphBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null }

  static getDerivedStateFromError(err: Error): { error: string } {
    return { error: err.message }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="text-sm text-warning" role="alert">
          관계도를 표시하지 못했습니다: {this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}

export function PageGraphDialog({
  open,
  onClose,
  spec,
  nav,
  domino,
  edges,
  tick
}: PageGraphDialogProps): React.JSX.Element {
  const model = useMemo(
    () => (spec ? buildPageGraph(spec, nav, domino, edges) : null),
    // tick: edges are recorded through a ref; the bump is the recompute signal
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, nav, domino, edges, tick]
  )
  const code = useMemo(() => (model ? toMermaid(model) : ''), [model])
  const unresolved = model?.actions.filter(
    (a) =>
      a.kind !== 'state' &&
      !a.bound &&
      !model.edges.some(
        (e) => e.action === a.id && e.from === a.page && e.to !== '' && e.kind !== 'data'
      )
  )

  // Same rule App.tsx applies to <html data-theme>: an explicit [ui] theme
  // wins, `auto` follows the OS — and it re-renders live when either flips.
  const systemTheme = useSystemTheme()
  const dark = (domino.ui.theme !== 'auto' ? domino.ui.theme : systemTheme) === 'dark'
  const accent = domino.ui.primary ?? '#6366f1'

  const viewportRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  /** Diagram size at 100% — measured once per fit, used by the clamps. */
  const fitRef = useRef({ w: 0, h: 0 })
  const viewRef = useRef<View>({ z: 1, tx: 0, ty: 0 })
  const [view, setView] = useState<View>(viewRef.current)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [panning, setPanning] = useState(false)

  const applyView = (next: View): void => {
    viewRef.current = next
    setView(next)
  }

  /** The viewport's content origin (client coords) and size — where 0,0 of
   *  the layer sits, independent of the current transform. */
  const viewportContent = (): { ox: number; oy: number; cw: number; ch: number } | null => {
    const vp = viewportRef.current
    if (!vp) return null
    const cs = getComputedStyle(vp)
    const r = vp.getBoundingClientRect()
    const pl = parseFloat(cs.paddingLeft || '0')
    const pt = parseFloat(cs.paddingTop || '0')
    return {
      ox: r.left + pl,
      oy: r.top + pt,
      cw: vp.clientWidth - pl - parseFloat(cs.paddingRight || '0'),
      ch: vp.clientHeight - pt - parseFloat(cs.paddingBottom || '0')
    }
  }

  /** Keep the diagram reachable: smaller than the viewport → centered (pan
   *  pinned), larger → the edges stay within the frame. */
  const clampView = (v: View): View => {
    const box = viewportContent()
    const { w, h } = fitRef.current
    if (!box || w <= 0) return v
    const W = w * v.z
    const H = h * v.z
    const fit = (span: number, viewport: number): [number, number] =>
      span <= viewport ? [(viewport - span) / 2, (viewport - span) / 2] : [-span + viewport, 0]
    const [txMin, txMax] = fit(W, box.cw)
    const [tyMin, tyMax] = fit(H, box.ch)
    return {
      z: v.z,
      tx: Math.min(txMax, Math.max(txMin, v.tx)),
      ty: Math.min(tyMax, Math.max(tyMin, v.ty))
    }
  }

  /** Zoom keeping the layer point under (fx, fy) pinned — the map-zoom feel. */
  const zoomAt = (fx: number, fy: number, z: number): void => {
    const box = viewportContent()
    if (!box) return
    const v = viewRef.current
    const z2 = clampZoom(z)
    const px = (fx - box.ox - v.tx) / v.z
    const py = (fy - box.oy - v.ty) / v.z
    applyView(clampView({ z: z2, tx: fx - box.ox - z2 * px, ty: fy - box.oy - z2 * py }))
  }

  const zoomBy = (factor: number): void => {
    const box = viewportContent()
    if (!box) return
    zoomAt(box.ox + box.cw / 2, box.oy + box.ch / 2, viewRef.current.z * factor)
  }

  const resetView = (): void => applyView(clampView({ z: 1, tx: 0, ty: 0 }))

  /** Size the (fixed-size) svg to the viewport content box at 100%. */
  const fitSvg = (): void => {
    const vp = viewportRef.current
    const svg = hostRef.current?.querySelector('svg')
    if (!vp || !svg) return
    const box = viewportContent()
    if (!box || box.cw <= 0) return
    const vb = svg.viewBox?.baseVal
    const ratio = vb && vb.width > 0 ? vb.height / vb.width : 0.6
    svg.style.maxWidth = 'none'
    svg.style.margin = '0'
    svg.style.width = `${Math.round(box.cw)}px`
    svg.style.height = `${Math.round(box.cw * ratio)}px`
    fitRef.current = { w: box.cw, h: Math.round(box.cw * ratio) }
    applyView(clampView(viewRef.current))
  }

  useEffect(() => {
    if (!open || !code) return
    let cancelled = false
    setRendering(true)
    setError(null)
    void (async () => {
      try {
        mermaidRef ??= (await import('mermaid')).default
        mermaidRef.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          // `base` + concrete variables keeps the diagram on the app's palette
          // in both schemes (accent borders from [ui] primary) — and flipping
          // light/dark re-runs this effect so the colors follow live.
          theme: 'base',
          fontFamily: 'inherit',
          themeVariables: dark
            ? {
                background: 'transparent',
                primaryColor: '#232833',
                primaryTextColor: '#e8eaed',
                primaryBorderColor: accent,
                lineColor: '#6b7482',
                textColor: '#d5d9e0',
                fontSize: '13px'
              }
            : {
                background: 'transparent',
                primaryColor: '#f2f4f8',
                primaryTextColor: '#171a1f',
                primaryBorderColor: accent,
                lineColor: '#9aa2ae',
                textColor: '#3b414b',
                fontSize: '13px'
              },
          flowchart: { padding: 18, nodeSpacing: 64, rankSpacing: 72, htmlLabels: true }
        })
        // The container arg stages the svg inside this dialog. The host div
        // must stay empty of React children (status text lives outside it):
        // mermaid clears the container itself, and any React node sharing
        // those children gets removed twice (NotFoundError removeChild → the
        // boundary above catches it if anything slips).
        const host = hostRef.current
        if (!host) return
        host.replaceChildren()
        const { svg } = await mermaidRef.render(`dg${Date.now().toString(36)}`, code, host)
        if (cancelled) return
        if (hostRef.current) hostRef.current.innerHTML = svg
        fitSvg()
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // fitSvg reads refs only; zoom/pan live in the transform, not in fit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, code, dark, accent])

  // Re-fit on viewport changes (dialog resize, phone rotation).
  useEffect(() => {
    if (!open) return
    const onResize = (): void => fitSvg()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Wheel over the canvas: ctrl/cmd+wheel (and trackpad pinch) zooms at the
  // cursor; a plain wheel pans the layer — the canvas never scrolls itself.
  useEffect(() => {
    const vp = viewportRef.current
    if (!open || !vp) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, viewRef.current.z * Math.exp(-e.deltaY * 0.002))
        return
      }
      const v = viewRef.current
      applyView(clampView({ z: v.z, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }))
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /* ------------------------- drag pan + pinch zoom ------------------------- */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const pinchRef = useRef<{
    dist: number
    mid: { x: number; y: number }
    z: number
    tx: number
    ty: number
  } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const v = viewRef.current
    if (pointersRef.current.size === 1) {
      panRef.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty }
      pinchRef.current = null
      setPanning(true)
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()]
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        z: v.z,
        tx: v.tx,
        ty: v.ty
      }
      panRef.current = null
      setPanning(false)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const box = viewportContent()
    if (!box) return

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()]
      const p = pinchRef.current
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (p.dist <= 0) return
      const z2 = clampZoom((p.z * dist) / p.dist)
      // The layer point that sat under mid at pinch start stays under mid.
      const px = (p.mid.x - box.ox - p.tx) / p.z
      const py = (p.mid.y - box.oy - p.ty) / p.z
      applyView(clampView({ z: z2, tx: mid.x - box.ox - z2 * px, ty: mid.y - box.oy - z2 * py }))
      return
    }
    const pan = panRef.current
    if (pan) {
      applyView(
        clampView({
          z: viewRef.current.z,
          tx: pan.tx + (e.clientX - pan.x),
          ty: pan.ty + (e.clientY - pan.y)
        })
      )
    }
  }

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size === 1) {
      // A pinch lifted to one finger: hand over to panning from here.
      const [a] = [...pointersRef.current.values()]
      panRef.current = { x: a.x, y: a.y, tx: viewRef.current.tx, ty: viewRef.current.ty }
      setPanning(true)
    } else if (pointersRef.current.size === 0) {
      panRef.current = null
      setPanning(false)
    }
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    resetView()
  }

  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      variant="blur"
    >
      <Modal.Container size="lg" placement="center" scroll="inside">
        <Modal.Dialog aria-label="페이지 관계도">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>페이지 관계도</Modal.Heading>
            <p className="text-sm text-muted">
              {model
                ? `페이지 ${model.pages.length}개 · 액션 ${model.actions.length}개` +
                  (unresolved && unresolved.length > 0
                    ? ` · 미연결 버튼 ${unresolved.length}개 (누르면 실시간 생성)`
                    : '')
                : '아직 만들어진 페이지가 없습니다.'}
            </p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            <GraphBoundary key={dark ? 'dark' : 'light'}>
              <div className="graph-toolbar">
                <ul className="graph-legend">
                  <li>
                    <span className="graph-chip graph-chip--page" /> 페이지
                  </li>
                  <li>
                    <span className="graph-chip graph-chip--action" /> 액션 버튼
                  </li>
                  <li>
                    <span className="graph-chip graph-chip--live" /> 실시간 생성 (공갈버튼)
                  </li>
                  <li>
                    <span className="graph-chip graph-chip--tabs" /> 탭 바
                  </li>
                </ul>
                <div className="graph-zoom" role="group" aria-label="확대 축소">
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label="축소"
                    isDisabled={view.z <= MIN_ZOOM + 0.001}
                    onPress={() => zoomBy(1 / ZOOM_STEP)}
                  >
                    <span aria-hidden>−</span>
                  </Button>
                  <button
                    type="button"
                    className="graph-zoom-level"
                    aria-label="확대 수준 초기화"
                    onClick={resetView}
                  >
                    {Math.round(view.z * 100)}%
                  </button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label="확대"
                    isDisabled={view.z >= MAX_ZOOM - 0.001}
                    onPress={() => zoomBy(ZOOM_STEP)}
                  >
                    <Icon name="plus" size={14} />
                  </Button>
                </div>
              </div>
              {/* Fixed viewport → transformed layer → mermaid host. The host
                holds ONLY mermaid's output (React renders no children there —
                shared children caused double removeChild before); pan/zoom
                move the layer, so the svg never re-lays out. */}
              <div
                className="graph-viewport"
                ref={viewportRef}
                data-panning={panning || undefined}
                data-dark={dark || undefined}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onDoubleClick={onDoubleClick}
              >
                <div
                  className="graph-layer"
                  style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})` }}
                >
                  <div className="graph-host" ref={hostRef} aria-busy={rendering} />
                </div>
              </div>
              {rendering ? <div className="graph-status">그리는 중…</div> : null}
              {error ? (
                <div className="text-sm text-warning" role="alert">
                  그래프를 그리지 못했습니다: {error}
                </div>
              ) : null}
              <details className="graph-source">
                <summary>머메이드 소스</summary>
                <pre>{code}</pre>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    void navigator.clipboard?.writeText(code).then(() => {
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    })
                  }}
                >
                  <Icon name="download" size={14} />
                  {copied ? '복사됨' : '복사'}
                </Button>
              </details>
            </GraphBoundary>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
