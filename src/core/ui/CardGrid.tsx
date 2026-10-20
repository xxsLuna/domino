import { Component, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Skeleton } from '@heroui/react'
import { CellContext, LayoutContext, RuntimeContext, type Runtime } from './context'
import { breakpointFor, placeNodes, type Breakpoint, type Placement } from './layout'
import { getComponent } from './registry'
import type { ActionEvent, CardNode, PageSpec, UiSpec } from '../spec'

/**
 * CardGrid — renders a PageSpec on the 12-column grid. Placement is derived
 * per breakpoint (see layout.ts) from the grid's own width, so the same spec
 * reads as a desktop dashboard, a tablet layout, and a phone column.
 */

interface CardGridProps {
  page: PageSpec
  spec: UiSpec
  onEvent: (event: ActionEvent) => void
  /** True while the spec is still streaming in (progressive preview). */
  streaming?: boolean
  /**
   * The node still being written (see streaming.ts). Rendering it for real on
   * every delta would rebuild it — a Table's whole collection — dozens of
   * times; a placeholder holds its slot until it is complete, so every node
   * mounts exactly once.
   */
  pending?: CardNode
  /** A streaming node with no position yet: left out until its `grid` arrives. */
  hidden?: CardNode
  /**
   * "app" (default) renders like a real app — no inspector chrome.
   * "inspect" wraps every node in a labeled card (useful while debugging specs).
   */
  chrome?: 'app' | 'inspect'
  density?: 'comfortable' | 'compact'
  /** Top-level cell keys that changed since the last edit (see streaming.ts). */
  changed?: ReadonlySet<string>
}

export function CardGrid({
  page,
  spec,
  onEvent,
  streaming,
  pending,
  hidden,
  chrome = 'app',
  density = 'comfortable',
  changed
}: CardGridProps): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)
  const bp = useContainerBreakpoint(gridRef)

  // Keep the dispatcher identity stable so memoized cells don't re-render
  // just because the parent re-created its handler.
  const eventRef = useRef(onEvent)
  eventRef.current = onEvent
  const pageRef = useRef(spec.page)
  pageRef.current = spec.page
  const runtime = useMemo<Runtime>(
    () => ({
      dispatch: (e) =>
        eventRef.current({
          pageId: pageRef.current,
          nodeId: e.nodeId ?? e.nodeName ?? 'unknown',
          nodeName: e.nodeName ?? 'unknown',
          event: e.event,
          data: e.data
        })
    }),
    []
  )
  const layout = useMemo(() => ({ bp, density }), [bp, density])
  const nodes = useMemo(
    () => (hidden ? page.layout.filter((n) => n !== hidden) : page.layout),
    [page.layout, hidden]
  )
  const placed = useMemo(() => placeNodes(nodes, bp), [nodes, bp])
  // Last cell of the first row: on phones it makes room for the floating menu button.
  const topRight = useMemo(() => {
    const y = placed[0]?.node.grid?.y
    const end = placed.findIndex((p, i) => i > 0 && (y === undefined || p.node.grid?.y !== y))
    return (end === -1 ? placed.length : end) - 1
  }, [placed])

  return (
    <RuntimeContext.Provider value={runtime}>
      <LayoutContext.Provider value={layout}>
        <div
          ref={gridRef}
          className="card-grid"
          data-bp={bp}
          data-chrome={chrome}
          data-streaming={streaming ? 'true' : undefined}
        >
          {placed.map(({ node, index, placement }, i) => {
            const key = node.id ?? `${node.name}-${index}`
            return (
              <GridCell
                topRight={i === topRight}
                key={key}
                node={node}
                signature={node === pending ? `pending:${node.name}` : signatureOf(node)}
                placement={placement}
                chrome={chrome}
                pending={node === pending}
                changed={changed?.has(key)}
              />
            )
          })}
        </div>
      </LayoutContext.Provider>
    </RuntimeContext.Provider>
  )
}

/** Track the grid's own width and map it to a layout breakpoint. */
function useContainerBreakpoint(ref: React.RefObject<HTMLDivElement | null>): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() =>
    breakpointFor(typeof window === 'undefined' ? 1280 : window.innerWidth)
  )
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setBp(breakpointFor(el.getBoundingClientRect().width))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return bp
}

const signatures = new WeakMap<CardNode, string>()
function signatureOf(node: CardNode): string {
  let sig = signatures.get(node)
  if (sig === undefined) {
    sig = JSON.stringify(node)
    signatures.set(node, sig)
  }
  return sig
}

interface GridCellProps {
  node: CardNode
  /** Serialized node — while a spec streams in, unchanged nodes skip re-rendering. */
  signature: string
  placement: Placement
  chrome: 'app' | 'inspect'
  /** Still streaming: show a placeholder instead of rendering partial props. */
  pending?: boolean
  topRight?: boolean
  /** Changed since the edit baseline: glow the cell (fades out on its own). */
  changed?: boolean
}

const GridCell = memo(
  function GridCell({
    node,
    signature,
    placement,
    chrome,
    pending,
    topRight,
    changed
  }: GridCellProps): React.JSX.Element {
    const style: React.CSSProperties = {
      gridColumn: placement.column,
      gridRow: placement.row,
      alignSelf: placement.alignSelf,
      justifySelf: placement.justifySelf,
      maxWidth: placement.maxWidth,
      width: placement.maxWidth ? '100%' : undefined
    }
    const cell = useMemo(() => ({ fill: Boolean(placement.fill) }), [placement.fill])
    const body = pending ? (
      <PendingNode name={node.name} />
    ) : (
      <CellBoundary resetKey={signature} name={node.name}>
        <NodeView node={node} />
      </CellBoundary>
    )

    if (chrome === 'app') {
      return (
        <CellContext.Provider value={cell}>
          <div
            className="grid-cell"
            style={style}
            data-node={node.name}
            data-top-right={topRight || undefined}
            data-changed={changed || undefined}
          >
            {body}
          </div>
        </CellContext.Provider>
      )
    }

    const def = getComponent(node.name)
    return (
      <CellContext.Provider value={cell}>
        <div
          className="grid-cell inspect-card"
          style={{ ...style, maxWidth: undefined }}
          data-changed={changed || undefined}
        >
          <div className="inspect-head">
            <span className="inspect-name">{node.name}</span>
            <span className="inspect-meta">
              {def ? def.category : 'unknown'}
              {node.id ? ` · #${node.id}` : ''}
            </span>
          </div>
          <div className="inspect-body">{body}</div>
        </div>
      </CellContext.Provider>
    )
  },
  (a, b) =>
    a.signature === b.signature &&
    a.pending === b.pending &&
    a.topRight === b.topRight &&
    a.changed === b.changed &&
    a.chrome === b.chrome &&
    a.placement.column === b.placement.column &&
    a.placement.row === b.placement.row &&
    a.placement.alignSelf === b.placement.alignSelf &&
    a.placement.justifySelf === b.placement.justifySelf &&
    a.placement.maxWidth === b.placement.maxWidth &&
    a.placement.fill === b.placement.fill
)

/** Rough placeholder heights so the page doesn't jump when the real node lands. */
const PENDING_HEIGHT: Record<string, string> = {
  PageHeader: 'h-14',
  Heading: 'h-9',
  Paragraph: 'h-5',
  Breadcrumbs: 'h-5',
  Button: 'h-10 w-28',
  Badge: 'h-6 w-16',
  Chip: 'h-6 w-16',
  Link: 'h-5 w-24',
  Avatar: 'h-10',
  Alert: 'h-14',
  StatCard: 'h-28',
  SearchField: 'h-10',
  Select: 'h-10',
  Input: 'h-16',
  Pagination: 'h-9',
  Divider: 'h-px',
  Table: 'h-72',
  Form: 'h-80'
}

function PendingNode({ name }: { name: string }): React.JSX.Element {
  return <Skeleton className={`${PENDING_HEIGHT[name] ?? 'h-40'} rounded-3xl`} aria-hidden />
}

/** Render one spec node (and its children) through the registry. */
export function NodeView({ node }: { node: CardNode }): React.JSX.Element {
  const def = getComponent(node.name)
  if (!def) {
    return (
      <div className="unknown-node" role="note">
        <strong>{node.name}</strong> is not a registered component.
      </div>
    )
  }
  const Comp = def.component
  const children = node.children?.length
    ? node.children.map((child, i) => (
        <NodeView key={child.id ?? `${child.name}-${i}`} node={child} />
      ))
    : null
  return (
    <Comp {...(node.props ?? {})} nodeId={node.id} nodeName={node.name} childNodes={node.children}>
      {children}
    </Comp>
  )
}

/**
 * LLM output is validated structurally, but props are free-form; a component
 * that chokes on odd props must not take the whole screen down with it.
 */
class CellBoundary extends Component<
  { resetKey: string; name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidUpdate(prev: { resetKey: string }): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="unknown-node" role="note">
          <strong>{this.props.name}</strong> could not be displayed.
        </div>
      )
    }
    return this.props.children
  }
}
