import { Component, type ReactNode } from 'react'

/**
 * Last line of defense against the white screen.
 *
 * A component that throws while rendering used to take the WHOLE app down —
 * React unmounts the tree and nothing is left to click (verified: one deeply
 * nested prop value → RangeError → dead page). Boundaries keep the blast
 * radius where it belongs: one page shows an apology, the rest of the app —
 * navigation, sidebar, edit — stays alive.
 *
 * The boundary is keyed by page version by its users: navigating or editing
 * remounts it, so a fixed screen comes back without a reload. Text is
 * hardcoded (this component must not depend on anything that can crash).
 */

interface Props {
  children: ReactNode
  /** Shown above the message — which part of the app caught the error. */
  label?: string
  /** Called on every caught error (console + the app's own diagnostics). */
  onCrash?: (error: Error) => void
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[domino] caught a render error:', error)
    this.props.onCrash?.(error)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const detail = `${error.name}: ${String(error.message ?? '')}`.slice(0, 240)
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: '48px 20px',
          textAlign: 'center'
        }}
      >
        {this.props.label ? (
          <div style={{ fontWeight: 700, fontSize: 15 }}>{this.props.label}</div>
        ) : null}
        <div style={{ fontSize: 14, opacity: 0.9 }}>
          이 화면을 그리는 중 문제가 발생했습니다
          <br />
          <span style={{ opacity: 0.7 }}>This screen failed to render — the rest of the app still works.</span>
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: 'ui-monospace, monospace',
            opacity: 0.55,
            maxWidth: 420,
            wordBreak: 'break-word'
          }}
        >
          {detail}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}
          >
            다시 시도
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}
          >
            앱 새로 고침
          </button>
        </div>
      </div>
    )
  }
}
