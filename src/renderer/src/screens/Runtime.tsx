import { useCallback, useEffect, useRef, useState } from 'react'
import { runAgentTurn } from '@core/agent/engine'
import { buildSystemPrompt } from '@core/agent/prompt'
import { resolveEndpoint } from '@core/agent/api'
import { applyScript, buildScriptContext } from '@core/domino/script'
import type { DominoFile } from '@core/domino/types'
import { createAdapter, type ChatMessage, type LLMConfig } from '@core/llm'
import { hashContext, SessionStore } from '@core/session/session'
import {
  extractToken,
  getToken,
  setToken
} from '@core/session/prefs'
import { CardGrid } from '@core/ui/CardGrid'
import type { ActionEvent, UiSpec } from '@core/spec'
import type { LoadedDomino } from '../loadDomino'
import { getStorage } from '../platform'

interface RuntimeProps {
  loaded: LoadedDomino
  config: LLMConfig
  onHome: () => void
  onOpenSettings: () => void
}

export function Runtime({ loaded, config, onHome, onOpenSettings }: RuntimeProps): React.JSX.Element {
  const { domino } = loaded
  const storage = getStorage()

  const sessionRef = useRef(new SessionStore())
  const historyRef = useRef<ChatMessage[]>([])
  const turnSeq = useRef(0)
  const cacheKeyRef = useRef<string | null>(null)
  const loggedInRef = useRef(false)
  // Token kept in a ref so API calls inside async turns see fresh values.
  const sessionTokenRef = useRef<string | null>(null)

  const [currentSpec, setCurrentSpec] = useState<UiSpec | null>(null)
  const [previewSpec, setPreviewSpec] = useState<UiSpec | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [pageName, setPageName] = useState('')

  const session = sessionRef.current

  const syncNav = useCallback(() => {
    setCanBack(session.canBack)
    setCanForward(session.canForward)
  }, [session])

  const finalizeSpec = useCallback(
    (spec: UiSpec, cacheKey: string | null) => {
      session.push(spec)
      if (cacheKey) session.cacheSet(cacheKey, spec)
      setCurrentSpec(spec)
      setPreviewSpec(null)
      setPageName(spec.pages.find((p) => p.id === spec.page)?.name ?? spec.page)
      syncNav()
    },
    [session, syncNav]
  )

  const apiRuntime = useCallback(
    () => ({
      baseUrl: domino.api.baseUrl,
      allow: domino.api.allow,
      token: loggedInRef.current ? sessionTokenRef.current : null
    }),
    [domino]
  )

  const runTurn = useCallback(
    async (prompt: string, cacheKey: string | null): Promise<void> => {
      const myTurn = ++turnSeq.current
      cacheKeyRef.current = cacheKey
      setStreaming(true)
      setError(null)
      setStatus('생성 중…')

      try {
        const adapter = createAdapter(config)
        const system = buildSystemPrompt(domino, { loggedIn: loggedInRef.current })
        historyRef.current.push({ role: 'user', content: prompt })
        for await (const update of runAgentTurn({
          adapter,
          system,
          history: historyRef.current,
          api: apiRuntime()
        })) {
          if (turnSeq.current !== myTurn) return // superseded by a newer turn
          switch (update.type) {
            case 'spec':
              if (update.final) {
                finalizeSpec(update.spec, cacheKeyRef.current)
                setStatus('')
              } else {
                setPreviewSpec(update.spec)
              }
              break
            case 'text':
              setStatus(update.text.trim().slice(-160))
              break
            case 'api_result':
              setStatus(`API ${update.result.status} · ${update.result.path}`)
              break
            case 'navigated':
              break
            case 'error':
              setError(update.message)
              break
            case 'done':
              break
          }
        }
      } catch (err) {
        if (turnSeq.current === myTurn) setError((err as Error).message)
      } finally {
        if (turnSeq.current === myTurn) {
          setStreaming(false)
          setPreviewSpec(null)
          setStatus('')
        }
      }
    },
    [apiRuntime, config, domino, finalizeSpec]
  )

  /* ------------------------------ boot flow ------------------------------ */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const token = await getToken(storage, domino.id)
      sessionTokenRef.current = token
      loggedInRef.current = Boolean(token)

      const target = resolveInitialPage(domino, loggedInRef.current)
      const cacheKey = `init::${target}::auth:${loggedInRef.current}`
      const cached = session.cacheGet(cacheKey)
      if (cached && !cancelled) {
        finalizeSpec(cached, cacheKey)
        return
      }
      if (cancelled) return
      await runTurn(
        `INITIAL SCREEN. Logged in: ${loggedInRef.current ? 'yes' : 'no'}. ` +
          `Show the "${target}" page following the screen patterns.`,
        cacheKey
      )
    })()
    return () => {
      cancelled = true
      turnSeq.current++ // invalidate in-flight turns
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------- back / forward keys ------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '[') {
        e.preventDefault()
        goBack()
      } else if (e.key === ']') {
        e.preventDefault()
        goForward()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const goBack = useCallback(() => {
    const snap = session.back()
    if (snap) {
      turnSeq.current++ // cancel any streaming turn
      setCurrentSpec(snap.spec)
      setPreviewSpec(null)
      setPageName(snap.spec.pages.find((p) => p.id === snap.spec.page)?.name ?? '')
      syncNav()
    }
  }, [session, syncNav])

  const goForward = useCallback(() => {
    const snap = session.forward()
    if (snap) {
      turnSeq.current++
      setCurrentSpec(snap.spec)
      setPreviewSpec(null)
      setPageName(snap.spec.pages.find((p) => p.id === snap.spec.page)?.name ?? '')
      syncNav()
    }
  }, [session, syncNav])

  /* ----------------------------- interactions ---------------------------- */

  const handleLogin = useCallback(
    async (data: Record<string, unknown>): Promise<void> => {
      setStreaming(true)
      setStatus('로그인 중…')
      setError(null)
      try {
        const res = await fetch(resolveEndpoint(domino.auth.loginEndpoint!, domino.api.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data)
        })
        let body: unknown = null
        const text = await res.text()
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = { raw: text }
        }
        const token = extractToken(body, domino.auth.tokenKey)
        if (res.ok && token) {
          await setToken(storage, domino.id, token)
          sessionTokenRef.current = token
          loggedInRef.current = true
          historyRef.current.push({
            role: 'user',
            content: `ACTION submit from login/login data ${JSON.stringify(redact(data))}`
          })
          setStreaming(false)
          const target = resolveInitialPage(domino, true)
          await runTurn(
            `Authentication SUCCEEDED (token stored). Render the "${target}" page now.`,
            `auth-ok::${target}`
          )
        } else {
          const msg =
            (body as { error?: string; message?: string } | null)?.error ??
            (body as { message?: string } | null)?.message ??
            `HTTP ${res.status}`
          historyRef.current.push({
            role: 'user',
            content: `ACTION submit from login/login → AUTH FAILED: ${msg}`
          })
          setStreaming(false)
          await runTurn(
            `Login attempt FAILED (${msg}). Re-render the login page with an Alert explaining the failure (variant "danger"), preserving entered values where sensible.`,
            null
          )
        }
      } catch (err) {
        setStreaming(false)
        setError(`로그인 요청 실패: ${(err as Error).message}`)
      }
    },
    [config, domino, runTurn, storage]
  )

  const handleEvent = useCallback(
    (e: ActionEvent): void => {
      const pageId = currentSpec?.page ?? e.pageId
      const hasPassword = Boolean(e.data && 'password' in e.data)
      if (e.event === 'submit' && hasPassword && domino.auth.loginEndpoint) {
        void handleLogin(e.data ?? {})
        return
      }

      historyRef.current.push({
        role: 'user',
        content: `ACTION ${e.event} from ${e.nodeName}/${e.nodeId}${
          e.data ? ` data ${JSON.stringify(redact(e.data))}` : ''
        } (page "${pageId}")`
      })
      // Trim conversation so long sessions don't blow the context window.
      if (historyRef.current.length > 60) historyRef.current.splice(0, 20)

      const cacheKey = `${pageId}::${hashContext({ id: e.nodeId, ev: e.event, d: e.data })}`
      const cached = session.cacheGet(cacheKey)
      if (cached) {
        finalizeSpec(cached, cacheKey)
        return
      }
      void runTurn(
        `The user acted on the current screen (see ACTION above). Compute and render the next screen.`,
        cacheKey
      )
    },
    [currentSpec, domino, finalizeSpec, handleLogin, runTurn, session]
  )

  /* -------------------------------- render -------------------------------- */
  const shown = previewSpec ?? currentSpec
  const needsKey = !config.apiKey && !/localhost|127\.0\.0\.1/.test(config.baseUrl ?? '')

  return (
    <div
      className="runtime"
      data-theme={domino.ui.theme}
      data-style={domino.ui.style}
      data-density={domino.ui.density}
      style={themeVars(domino.ui)}
    >
      <header className="toolbar">
        <div className="toolbar-left">
          <button className="icon-btn" onClick={onHome} title="홈으로" disabled={streaming}>
            ⌂
          </button>
          <button className="icon-btn" onClick={goBack} title="이전 페이지 (⌘[)" disabled={!canBack}>
            ←
          </button>
          <button
            className="icon-btn"
            onClick={goForward}
            title="다음 페이지 (⌘])"
            disabled={!canForward}
          >
            →
          </button>
          <span className="app-badge">
            {domino.meta.logo ? (
              <img
                src={domino.meta.logo}
                alt=""
                className="app-logo"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            ) : (
              <span className="app-initial">{domino.meta.name.slice(0, 1).toUpperCase()}</span>
            )}
            <span className="app-name">{domino.meta.name}</span>
          </span>
          <span className="page-pill">{pageName || '—'}</span>
        </div>
        <div className="toolbar-right">
          {streaming ? (
            <span className="status-pill busy">
              <span className="spinner small" /> {status || '생성 중…'}
            </span>
          ) : status ? (
            <span className="status-pill">{status}</span>
          ) : null}
          {needsKey ? (
            <button className="ghost-btn warn" onClick={onOpenSettings}>
              BYOK 미설정
            </button>
          ) : null}
          <button className="icon-btn" onClick={onOpenSettings} title="설정">
            ⚙
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-banner">
          <span>{error}</span>
          <button className="ghost-btn" onClick={() => setError(null)}>
            닫기
          </button>
        </div>
      ) : null}

      <main className="runtime-body">
        {shown ? (
          <CardGrid
            page={shown.pages.find((p) => p.id === shown.page) ?? shown.pages[0]}
            spec={shown}
            onEvent={handleEvent}
            streaming={Boolean(previewSpec)}
          />
        ) : (
          <div className="center-state">
            <span className="spinner" />
            <p>{error ? '오류가 발생했습니다' : '앱을 구성하는 중…'}</p>
            {streaming ? <p className="muted">{status}</p> : null}
          </div>
        )}
      </main>
    </div>
  )
}

/** Map [ui] section values onto the runtime's CSS custom properties. */
function themeVars(ui: DominoFile['ui']): Record<string, string> {
  const vars: Record<string, string> = {}
  if (ui.primary) vars['--primary'] = ui.primary
  if (ui.success) vars['--ok'] = ui.success
  if (ui.warning) vars['--warn'] = ui.warning
  if (ui.danger) vars['--danger'] = ui.danger
  const radius = ui.radius ?? (ui.style === 'sharp' ? 0 : undefined)
  if (radius !== undefined) {
    vars['--radius'] = `${radius}px`
    // Inner controls track the card corners so the whole UI reads as one style.
    vars['--radius-sm'] = `${Math.min(radius, 6)}px`
  }
  return vars
}

function resolveInitialPage(domino: DominoFile, loggedIn: boolean): string {
  const outcome = applyScript(domino, buildScriptContext({ loggedIn }))
  const scripted = outcome.goto ?? outcome.render
  if (scripted) return scripted
  if (domino.auth.required && !loggedIn) return 'login'
  return domino.meta.home
}

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = /pass|secret|token|key/i.test(k) ? '••••••' : v
  }
  return out
}
