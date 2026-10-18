import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Button, Dropdown, Label, Skeleton, Spinner, Tooltip } from '@heroui/react'
import { runAgentTurn } from '@core/agent/engine'
import { buildSystemPrompt } from '@core/agent/prompt'
import { resolveEndpoint } from '@core/agent/api'
import { applyScript, buildScriptContext } from '@core/domino/script'
import type { DominoFile } from '@core/domino/types'
import { createAdapter, type ChatMessage, type LLMConfig } from '@core/llm'
import { hashContext, SessionStore } from '@core/session/session'
import { clearToken, extractToken, getToken, setToken } from '@core/session/prefs'
import { BottomNav, SideNav } from '@core/ui/AppNav'
import { CardGrid } from '@core/ui/CardGrid'
import { streamView } from '@core/ui/streaming'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'
import { themeVars } from '@core/ui/theme'
import { isSignOutEvent, withKnownPages, type ActionEvent, type NavItem, type UiSpec } from '@core/spec'
import type { LoadedDomino } from '../loadDomino'
import { getStorage } from '../platform'

interface RuntimeProps {
  loaded: LoadedDomino
  config: LLMConfig
  onHome: () => void
  onOpenSettings: () => void
}

export function Runtime({
  loaded,
  config,
  onHome,
  onOpenSettings
}: RuntimeProps): React.JSX.Element {
  const { domino } = loaded
  const storage = getStorage()

  const sessionRef = useRef(new SessionStore())
  const historyRef = useRef<ChatMessage[]>([])
  const turnSeq = useRef(0)
  const cacheKeyRef = useRef<string | null>(null)
  const loggedInRef = useRef(false)
  // Token kept in a ref so API calls inside async turns see fresh values.
  const sessionTokenRef = useRef<string | null>(null)
  // Last navigation the agent gave us; screens that omit `nav` keep it.
  const navRef = useRef<NavItem[]>([])
  /** Latest shown spec, including pages from earlier turns (see withKnownPages). */
  const knownRef = useRef<UiSpec | null>(null)

  const [currentSpec, setCurrentSpec] = useState<UiSpec | null>(null)
  const [previewSpec, setPreviewSpec] = useState<UiSpec | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [pageName, setPageName] = useState('')
  const [nav, setNav] = useState<NavItem[]>([])
  const [activeNav, setActiveNav] = useState<string | null>(null)
  // "app" renders like a real app; "inspect" reveals per-component cards.
  const [chrome, setChrome] = useState<'app' | 'inspect'>('app')

  const session = sessionRef.current

  // Overlays (menus, dialogs) portal to <body>, so the domino theme tokens
  // go on the root element where HeroUI declares its own.
  useLayoutEffect(() => {
    const root = document.documentElement
    const vars = themeVars(domino.ui)
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    root.dataset.density = domino.ui.density
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k)
      delete root.dataset.density
    }
  }, [domino])

  const syncNav = useCallback(() => {
    setCanBack(session.canBack)
    setCanForward(session.canForward)
  }, [session])

  /** Apply a spec's navigation: explicit `nav` wins, login screens never show it. */
  const applyNav = useCallback((spec: UiSpec) => {
    let items = navRef.current
    if (spec.nav !== undefined) items = spec.nav
    else if (spec.page === 'login') items = []
    navRef.current = items
    setNav(items)
    if (items.some((i) => i.id === spec.page)) setActiveNav(spec.page)
  }, [])

  const showSpec = useCallback(
    (spec: UiSpec) => {
      // Back/forward snapshots may predate pages delivered since; keep those too.
      knownRef.current = withKnownPages(spec, knownRef.current)
      setCurrentSpec(spec)
      setPreviewSpec(null)
      setPageName(spec.pages.find((p) => p.id === spec.page)?.name ?? spec.page)
      applyNav(spec)
    },
    [applyNav]
  )

  const finalizeSpec = useCallback(
    (spec: UiSpec, cacheKey: string | null) => {
      session.push(spec)
      if (cacheKey) session.cacheSet(cacheKey, spec)
      showSpec(spec)
      syncNav()
    },
    [session, showSpec, syncNav]
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
                finalizeSpec(withKnownPages(update.spec, knownRef.current), cacheKeyRef.current)
                setStatus('')
              } else {
                // Previews are interruptible: typing/scrolling stays responsive
                // while the screen assembles, and stale previews get skipped.
                startTransition(() => setPreviewSpec(update.spec))
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
      // "Logged in: no" on an app without sign-in nudges models into a login page.
      const auth = domino.auth.required ? ` Logged in: ${loggedInRef.current ? 'yes' : 'no'}.` : ''
      await runTurn(
        `INITIAL SCREEN.${auth} Show the "${target}" page following the screen patterns.`,
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
  const goBack = useCallback(() => {
    const snap = session.back()
    if (snap) {
      turnSeq.current++ // cancel any streaming turn
      showSpec(snap.spec)
      syncNav()
    }
  }, [session, showSpec, syncNav])

  const goForward = useCallback(() => {
    const snap = session.forward()
    if (snap) {
      turnSeq.current++
      showSpec(snap.spec)
      syncNav()
    }
  }, [session, showSpec, syncNav])

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
  }, [goBack, goForward])

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
          knownRef.current = null // the signed-out pages (login) don't carry over
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
    [domino, runTurn, storage]
  )

  const handleEvent = useCallback(
    (e: ActionEvent): void => {
      const pageId = currentSpec?.page ?? e.pageId
      const hasPassword = Boolean(e.data && 'password' in e.data)
      if (e.event === 'submit' && hasPassword && domino.auth.loginEndpoint) {
        void handleLogin(e.data ?? {})
        return
      }

      // Sign-out convention: the runtime owns the token, so it clears it itself.
      if (isSignOutEvent(e) && loggedInRef.current) {
        void (async () => {
          await clearToken(storage, domino.id)
          sessionTokenRef.current = null
          loggedInRef.current = false
          navRef.current = []
          knownRef.current = null // signed-in pages must not outlive the session
          historyRef.current.push({
            role: 'user',
            content: 'ACTION click from Button/logout → SIGNED OUT (token cleared)'
          })
          const target = resolveInitialPage(domino, false)
          await runTurn(
            `The user signed out. Render the "${target}" page.`,
            `signed-out::${target}`
          )
        })()
        return
      }

      // Pages the agent already delivered switch instantly, like a real app.
      const target = e.event === 'navigate' ? String(e.data?.page ?? e.nodeId) : null
      if (
        target &&
        currentSpec &&
        target !== currentSpec.page &&
        currentSpec.pages.some((p) => p.id === target)
      ) {
        turnSeq.current++
        finalizeSpec({ ...currentSpec, page: target }, null)
        return
      }
      if (target && navRef.current.some((i) => i.id === target)) setActiveNav(target)

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
    [currentSpec, domino, finalizeSpec, handleLogin, runTurn, session, storage]
  )

  const handleNav = useCallback(
    (item: NavItem): void => {
      if (streaming && activeNav === item.id) return
      handleEvent({
        pageId: currentSpec?.page ?? '',
        nodeId: item.id,
        nodeName: 'nav',
        event: 'navigate',
        data: { page: item.id }
      })
    },
    [activeNav, currentSpec, handleEvent, streaming]
  )

  /* -------------------------------- render -------------------------------- */
  const view = useMemo(
    () => (previewSpec ? streamView(currentSpec, previewSpec) : null),
    [currentSpec, previewSpec]
  )
  const shown = view?.spec ?? currentSpec
  const shownPageId = shown?.page
  // A new screen starts at the top, like navigating in any app.
  const bodyRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [shownPageId])
  // A same-origin base URL ("/zen/…") goes through the dev proxy, which may add the key.
  const needsKey =
    !config.apiKey && !/^\/|localhost|127\.0\.0\.1/.test(config.baseUrl ?? '')
  const shownPage = shown ? (shown.pages.find((p) => p.id === shown.page) ?? shown.pages[0]) : null
  // A screen still streaming already knows its name and navigation.
  const title = (previewSpec && shownPage?.name) || pageName
  const navItems = previewSpec?.nav?.length ? previewSpec.nav : nav
  const hasNav = navItems.length > 0

  const menuAction = (key: React.Key): void => {
    if (key === 'forward') goForward()
    else if (key === 'inspect') setChrome(chrome === 'app' ? 'inspect' : 'app')
    else if (key === 'settings') onOpenSettings()
    else if (key === 'home') onHome()
  }

  return (
    <div className="runtime" data-density={domino.ui.density} data-style={domino.ui.style}>
      <header className="app-bar">
        <BarButton label="이전 화면 (⌘[)" icon="back" onPress={goBack} isDisabled={!canBack} />
        <BarButton
          label="다음 화면 (⌘])"
          icon="arrow-right"
          onPress={goForward}
          isDisabled={!canForward}
          className="hide-phone"
        />
        <div className="app-bar-title">
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
          <span className="app-name hide-phone">{domino.meta.name}</span>
          {title ? (
            <>
              <span className="crumb-sep hide-phone">/</span>
              <span className="page-name">{title}</span>
            </>
          ) : null}
        </div>
        <div className="app-bar-actions">
          {streaming ? (
            <span
              className="flex items-center gap-2 text-xs text-muted"
              role="status"
              aria-live="polite"
            >
              <Spinner size="sm" />
              <span className="status-text hide-phone">{status || '생성 중…'}</span>
            </span>
          ) : null}
          {needsKey ? (
            <Button size="sm" variant="outline" className="text-warning" onPress={onOpenSettings}>
              <Icon name="key" />
              <span className="hide-phone">BYOK 미설정</span>
            </Button>
          ) : null}
          <BarButton
            label={chrome === 'app' ? '구조 보기 (컴포넌트 카드)' : '앱처럼 보기'}
            icon="layers"
            onPress={() => setChrome(chrome === 'app' ? 'inspect' : 'app')}
            active={chrome === 'inspect'}
            className="hide-phone"
          />
          <BarButton label="설정" icon="settings" onPress={onOpenSettings} className="hide-phone" />
          <BarButton label="domino 닫기" icon="close" onPress={onHome} className="hide-phone" />
          <Dropdown>
            <Button isIconOnly variant="ghost" size="sm" aria-label="메뉴" className="phone-only">
              <Icon name="more" size={18} />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label="Runtime menu"
                onAction={menuAction}
                disabledKeys={canForward ? [] : ['forward']}
              >
                <Dropdown.Item id="forward" textValue="다음 화면">
                  <Icon name="arrow-right" />
                  <Label>다음 화면</Label>
                </Dropdown.Item>
                <Dropdown.Item id="inspect" textValue="구조 보기">
                  <Icon name="layers" />
                  <Label>{chrome === 'app' ? '구조 보기' : '앱처럼 보기'}</Label>
                </Dropdown.Item>
                <Dropdown.Item id="settings" textValue="설정">
                  <Icon name="settings" />
                  <Label>설정</Label>
                </Dropdown.Item>
                <Dropdown.Item id="home" textValue="domino 닫기">
                  <Icon name="close" />
                  <Label>domino 닫기</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </header>

      <div className="runtime-main">
        {hasNav ? <SideNav items={navItems} activeId={activeNav} onSelect={handleNav} /> : null}
        <main className="runtime-body" ref={bodyRef}>
          {streaming ? <div className="stream-bar" aria-hidden /> : null}
          {error ? (
            <div className="runtime-banner">
              <Alert
                variant="danger"
                title="화면을 만들지 못했습니다"
                message={error}
                onClose={() => setError(null)}
              />
            </div>
          ) : null}
          {shown && shownPage ? (
            <CardGrid
              page={shownPage}
              spec={shown}
              onEvent={handleEvent}
              streaming={Boolean(previewSpec)}
              pending={view?.pending}
              hidden={view?.hidden}
              chrome={chrome}
              density={domino.ui.density}
            />
          ) : error ? null : (
            <LoadingScreen />
          )}
        </main>
      </div>
      {hasNav ? <BottomNav items={navItems} activeId={activeNav} onSelect={handleNav} /> : null}
    </div>
  )
}

function BarButton({
  label,
  icon,
  onPress,
  isDisabled,
  active,
  className
}: {
  label: string
  icon: string
  onPress: () => void
  isDisabled?: boolean
  active?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <Tooltip delay={600}>
      <Button
        isIconOnly
        size="sm"
        variant={active ? 'secondary' : 'ghost'}
        aria-label={label}
        onPress={onPress}
        isDisabled={isDisabled}
        className={className}
      >
        <Icon name={icon} size={18} />
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  )
}

/** First-render placeholder shaped like a typical app screen. */
function LoadingScreen(): React.JSX.Element {
  return (
    <div
      className="mx-auto flex max-w-[1360px] flex-col gap-4 p-4 sm:p-6"
      aria-busy="true"
      aria-label="앱을 구성하는 중"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56 rounded-lg" />
        <Skeleton className="h-4 w-80 max-w-full rounded-lg" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-3xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-3xl" />
    </div>
  )
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
