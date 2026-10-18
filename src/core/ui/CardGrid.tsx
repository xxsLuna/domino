import { RuntimeContext, type Runtime } from './components'
import { getComponent } from './registry'
import type { ActionEvent, CardNode, PageSpec, UiSpec } from '../spec'

/**
 * CardGrid — renders a PageSpec as automatically-placed cards on a
 * 12-column grid. Missing `grid` falls back to auto-flow.
 */

interface CardGridProps {
  page: PageSpec
  spec: UiSpec
  onEvent: (event: ActionEvent) => void
  /** Optional per-node renderer override (e.g. streaming placeholders). */
  streaming?: boolean
}

export function CardGrid({ page, spec, onEvent, streaming }: CardGridProps): React.JSX.Element {
  const runtime: Runtime = {
    dispatch: (e) => {
      onEvent({
        pageId: spec.page,
        nodeId: e.nodeId ?? e.nodeName ?? 'unknown',
        nodeName: e.nodeName ?? 'unknown',
        event: e.event,
        data: e.data
      })
    }
  }

  return (
    <RuntimeContext.Provider value={runtime}>
      <div className="card-grid" data-streaming={streaming ? 'true' : undefined}>
        {page.layout.map((node, i) => (
          <CardSlot key={node.id ?? `${node.name}-${i}`} node={node} />
        ))}
      </div>
    </RuntimeContext.Provider>
  )
}

function CardSlot({ node }: { node: CardNode }): React.JSX.Element {
  const def = getComponent(node.name)
  const style: React.CSSProperties = {}

  if (node.grid) {
    style.gridColumn = `${node.grid.x + 1} / span ${Math.min(node.grid.w, 12 - node.grid.x)}`
    style.gridRow = `span ${node.grid.h}`
  }

  if (!def) {
    return (
      <div className="card card-unknown" style={style}>
        <div className="card-head">
          <span className="card-name">{node.name}</span>
          <span className="card-badge">unknown component</span>
        </div>
        <div className="card-body">
          <p>This component is not in the registry.</p>
        </div>
      </div>
    )
  }

  const rest: Record<string, unknown> = { ...(node.props ?? {}) }
  const children = node.children
  const id = node.id
  const name = node.name

  const Comp = def.component
  const rendered = (
    <Comp {...rest} nodeId={id} nodeName={name}>
      {children ? <ChildNodes nodes={children} /> : null}
    </Comp>
  )

  return (
    <div className="card" style={style}>
      <div className="card-head">
        <span className="card-name">{name}</span>
        <span className="card-category">{def.category}</span>
      </div>
      <div className="card-body">{rendered}</div>
    </div>
  )
}

function ChildNodes({ nodes }: { nodes: CardNode[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((node, i) => {
        const def = getComponent(node.name)
        const Comp = def?.component
        const rest = (node.props ?? {}) as Record<string, unknown>
        if (!Comp) {
          return (
            <div key={node.id ?? i} className="unknown-inline">
              Unknown component: {node.name}
            </div>
          )
        }
        return (
          <Comp key={node.id ?? `${node.name}-${i}`} {...rest} nodeId={node.id} nodeName={node.name}>
            {node.children ? <ChildNodes nodes={node.children} /> : null}
          </Comp>
        )
      })}
    </>
  )
}
