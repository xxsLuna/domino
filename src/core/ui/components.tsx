import { createContext, useContext, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { ActionEvent } from '../spec'

/**
 * Runtime context: components dispatch interaction events up to the agent loop.
 */
export interface Runtime {
  dispatch(event: Omit<ActionEvent, 'pageId' | 'nodeId' | 'nodeName'> & { nodeId?: string; nodeName?: string }): void
}

export const RuntimeContext = createContext<Runtime>({
  dispatch: () => {
    /* noop until an agent is attached */
  }
})

export const useRuntime = (): Runtime => useContext(RuntimeContext)

interface BaseProps {
  name?: string
  nodeName?: string
  children?: ReactNode
  nodeId?: string
}

const h = (level: 1 | 2 | 3 | 4 | 5 | 6, text: string): ReactNode => {
  const Tag = `h${level}` as 'h1'
  return <Tag>{text}</Tag>
}

/* ---------------------------------- Text ---------------------------------- */

export function Heading({ text, level = 2, align }: { text?: string; level?: 1 | 2 | 3 | 4 | 5 | 6; align?: 'left' | 'center' | 'right' }) {
  return <div style={{ textAlign: align ?? 'left' }}>{h(level, String(text ?? ''))}</div>
}

export function Paragraph({ text, muted }: { text?: string; muted?: boolean }) {
  return <p style={muted ? { opacity: 0.7 } : undefined}>{String(text ?? '')}</p>
}

export function Badge({ text, variant = 'neutral' }: { text?: string; variant?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }) {
  return <span className={`badge badge-${variant}`}>{String(text ?? '')}</span>
}

export function Link({ text, href }: { text?: string; href?: string }) {
  return (
    <a href={href ?? '#'} target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()}>
      {String(text ?? '')}
    </a>
  )
}

export function Divider() {
  return <hr className="divider" />
}

/* --------------------------------- Layout --------------------------------- */

export function Section({ title, children }: BaseProps & { title?: string }) {
  return (
    <section className="section">
      {title ? <h3 className="section-title">{title}</h3> : null}
      {children}
    </section>
  )
}

export function Columns({ children, cols = 2 }: BaseProps & { cols?: 2 | 3 | 4 }) {
  const kids = Array.isArray(children) ? children : [children]
  return (
    <div className="columns" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {kids.filter(Boolean).map((c, i) => (
        <div key={i} className="column-cell">
          {c}
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------- Form ---------------------------------- */

export function Input({ label, placeholder, type = 'text', value, name, readOnly }: { label?: string; placeholder?: string; type?: string; value?: string; name?: string; readOnly?: boolean }) {
  const id = useId()
  return (
    <label className="field" htmlFor={id}>
      {label ? <span className="field-label">{label}</span> : null}
      <input id={id} name={name} type={type} placeholder={placeholder} defaultValue={value} readOnly={readOnly} />
    </label>
  )
}

export function Textarea({ label, placeholder, name, rows = 4 }: { label?: string; placeholder?: string; name?: string; rows?: number }) {
  const id = useId()
  return (
    <label className="field" htmlFor={id}>
      {label ? <span className="field-label">{label}</span> : null}
      <textarea id={id} name={name} placeholder={placeholder} rows={rows} />
    </label>
  )
}

export function Select({ label, name, options }: { label?: string; name?: string; options?: Array<string | { label: string; value: string }> }) {
  const id = useId()
  const opts = (options ?? []).map((o) => (typeof o === 'string' ? { label: o, value: o } : o))
  return (
    <label className="field" htmlFor={id}>
      {label ? <span className="field-label">{label}</span> : null}
      <select id={id} name={name}>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Checkbox({ label, name, defaultChecked }: { label?: string; name?: string; defaultChecked?: boolean }) {
  return (
    <label className="field field-inline">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  )
}

export function Radio({ label, name, value, defaultChecked }: { label?: string; name?: string; value?: string; defaultChecked?: boolean }) {
  return (
    <label className="field field-inline">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  )
}

export function Switch({ label, name, defaultChecked }: { label?: string; name?: string; defaultChecked?: boolean }) {
  const id = useId()
  return (
    <label className="field field-inline switch" htmlFor={id}>
      <input id={id} type="checkbox" name={name} className="switch-input" defaultChecked={defaultChecked} />
      <span className="switch-track" aria-hidden />
      <span>{label}</span>
    </label>
  )
}

/** Marks that the nearest ancestor is a Form so Buttons become submit buttons. */
const InFormContext = createContext(false)

export function Button({
  text,
  variant = 'primary',
  type,
  nodeName,
  nodeId
}: {
  text?: string
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  type?: 'button' | 'submit'
  nodeName?: string
  nodeId?: string
}) {
  const runtime = useRuntime()
  const inForm = useContext(InFormContext)
  // Inside a form the primary purpose is submitting (login pattern etc.) —
  // the form's submit event carries the data, so don't also fire a click.
  const resolved = type ?? (inForm ? 'submit' : 'button')
  return (
    <button
      type={resolved}
      className={`btn btn-${variant}`}
      onClick={resolved === 'button' ? () => runtime.dispatch({ event: 'click', nodeName, nodeId }) : undefined}
    >
      {String(text ?? 'Button')}
    </button>
  )
}

export function Form({ children, nodeName, nodeId }: BaseProps) {
  const runtime = useRuntime()
  const id = useId()
  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const data: Record<string, unknown> = {}
    const fd = new FormData(e.currentTarget)
    for (const [k, v] of fd.entries()) data[k] = v
    // Checkbox/radio groups not in FormData when unchecked → collect manually.
    for (const el of e.currentTarget.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      if (el.name) data[el.name] = el.checked
    }
    runtime.dispatch({ event: 'submit', data, nodeName, nodeId })
  }
  return (
    <InFormContext.Provider value>
      <form id={id} className="form" onSubmit={handleSubmit}>
        {children}
      </form>
    </InFormContext.Provider>
  )
}

/* ---------------------------------- Data ---------------------------------- */

export function Table({ columns, rows }: { columns?: string[]; rows?: unknown[][] }) {
  const cols = columns ?? []
  const body = rows ?? []
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i}>{String(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{formatCell(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatCell(cell: unknown): ReactNode {
  if (cell === null || cell === undefined) return '—'
  if (typeof cell === 'object') return JSON.stringify(cell)
  return String(cell)
}

export function List({ items, ordered }: { items?: unknown[]; ordered?: boolean }) {
  const list = items ?? []
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag className="list">
      {list.map((item, i) => (
        <li key={i}>{formatCell(item)}</li>
      ))}
    </Tag>
  )
}

export function StatCard({ label, value, delta, deltaGood }: { label?: string; value?: string | number; delta?: string; deltaGood?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{String(label ?? '')}</div>
      <div className="stat-value">{String(value ?? '')}</div>
      {delta ? <div className={`stat-delta ${deltaGood === false ? 'bad' : 'good'}`}>{String(delta)}</div> : null}
    </div>
  )
}

/* ------------------------------- Feedback --------------------------------- */

export function Alert({ message, variant = 'info' }: { message?: string; variant?: 'info' | 'success' | 'warning' | 'danger' }) {
  return <div className={`alert alert-${variant}`}>{String(message ?? '')}</div>
}

export function Progress({ value, label }: { value?: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Number(value ?? 0)))
  return (
    <div className="progress">
      {label ? <div className="progress-label">{label}</div> : null}
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function Spinner({ text }: { text?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" />
      {text ? <span>{text}</span> : null}
    </div>
  )
}

/* --------------------------------- Media ---------------------------------- */

export function Image({ src, alt, width }: { src?: string; alt?: string; width?: number | string }) {
  const [failed, setFailed] = useState(false)
  if (failed || !src) {
    return <div className="image-fallback">{String(alt ?? 'image')}</div>
  }
  return <img className="image" src={src} alt={String(alt ?? '')} width={width} onError={() => setFailed(true)} />
}
