import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Button,
  Dropdown,
  Header,
  InputGroup,
  Label,
  Modal,
  Skeleton,
  Spinner,
  TextArea,
  TextField,
  Tooltip
} from '@heroui/react'
import { runAgentTurn } from '@core/agent/engine'
import { buildSystemPrompt } from '@core/agent/prompt'
import { resolveEndpoint } from '@core/agent/api'
import {
  bookFields,
  hashSchema,
  loadSchemaBook,
  rememberSchema,
  saveSchemaBook,
  type SchemaBook
} from '@core/agent/schema'
import { applyScript, buildScriptContext } from '@core/domino/script'
import type { DominoFile } from '@core/domino/types'
import { createAdapter, needsApiKey, type ChatMessage, type LLMConfig } from '@core/llm'
import { httpFetch, readTextCapped } from '@core/net'
import { hashContext, SessionStore } from '@core/session/session'
import { clearToken, extractToken, getToken, setToken } from '@core/session/prefs'
import { ScreenStore, type ScreenDeps } from '@core/session/screenStore'
import { BottomNav, SideNav } from '@core/ui/AppNav'
import { CardGrid } from '@core/ui/CardGrid'
import { streamView } from '@core/ui/streaming'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'
import { themeVars } from '@core/ui/theme'
import {
  findPage,
  isSignOutEvent,
  withKnownPages,
  type ActionEvent,
  type NavItem,
  type UiSpec
} from '@core/spec'
import type { LoadedDomino } from '../loadDomino'
import { useBackHandler } from '../backStack'
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
  /** Persisted per-domino API memory: endpoint → key/type shape of its responses. */
  const schemaBookRef = useRef<SchemaBook>({})
  /** Persistent screen cache — specs from earlier sessions, with their API deps. */
  const screensRef = useRef<ScreenStore | null>(null)
  /** Endpoints whose responses the current turn's final spec is built from. */
  const turnDepsRef = useRef<ScreenDeps>({})
  const schemaTimer = useRef<number | null>(null)

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
  // Live "change this screen" composer — the app-bar field and the phone modal
  // share the draft; submitting interrupts any streaming turn.
  const [editText, setEditText] = useState('')
  const [editOpen, setEditOpen] = useState(false)

  const session = sessionRef.current

  /** Current shape hash per endpoint — what persisted screens are validated against. */
  const schemaHashes = useCallback((): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [endpoint, remembered] of Object.entries(schemaBookRef.current)) {
      out[endpoint] = hashSchema(remembered.fields)
    }
    return out
  }, [])

  // Debounced: one round can remember several shapes and each save rewrites the
  // whole book, so writes coalesce.
  const scheduleSchemaSave = useCallback(() => {
    if (schemaTimer.current !== null) window.clearTimeout(schemaTimer.current)
    schemaTimer.current = window.setTimeout(() => {
      schemaTimer.current = null
      void saveSchemaBook(storage, domino.id, schemaBookRef.current)
    }, 800)
  }, [domino.id, storage])

  // Don't drop a pending save when the screen unmounts mid-debounce.
  useEffect(
    () => () => {
      if (schemaTimer.current !== null) {
        window.clearTimeout(schemaTimer.current)
        schemaTimer.current = null
        void saveSchemaBook(storage, domino.id, schemaBookRef.current)
      }
    },
    [domino.id, storage]
  )

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

  // Bumping turnSeq orphans the in-flight turn's finally guard, which then
  // skips its cleanup — so every invalidation site clears the streaming UI
  // here too, or the spinner sticks and the handleNav guard blocks taps.
  const interruptTurn = useCallback(() => {
    turnSeq.current++
    setStreaming(false)
    setPreviewSpec(null)
    setStatus('')
  }, [])

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
      const known = withKnownPages(spec, knownRef.current)
      knownRef.current = known
      setCurrentSpec(spec)
      setPreviewSpec(null)
      setPageName(spec.pages.find((p) => p.id === spec.page)?.name ?? spec.page)
      applyNav(spec)
      // Remember where the user was: reopening restores this screen as-is.
      void screensRef.current?.saveView(loggedInRef.current, { page: spec.page, known })
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
      turnDepsRef.current = {}
      setStreaming(true)
      setError(null)
      setStatus('생성 중…')

      try {
        const adapter = createAdapter(config)
        // One snapshot per turn: the engine diffs responses against it, the
        // prompt describes screens built from it.
        const knownSchemas = bookFields(schemaBookRef.current)
        const system = buildSystemPrompt(domino, {
          loggedIn: loggedInRef.current,
          knownSchemas
        })
        historyRef.current.push({ role: 'user', content: prompt })
        for await (const update of runAgentTurn({
          adapter,
          system,
          history: historyRef.current,
          api: apiRuntime(),
          knownSchemas
        })) {
          if (turnSeq.current !== myTurn) return // superseded by a newer turn
          switch (update.type) {
            case 'spec':
              if (update.final) {
                const merged = withKnownPages(update.spec, knownRef.current)
                finalizeSpec(merged, cacheKeyRef.current)
                // Persist the screen (and which responses it was built from)
                // so the next session restores it instead of regenerating.
                if (cacheKeyRef.current) {
                  void screensRef.current?.put(
                    cacheKeyRef.current,
                    merged,
                    turnDepsRef.current
                  )
                }
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
              if (update.schema) {
                schemaBookRef.current = rememberSchema(
                  schemaBookRef.current,
                  update.endpoint,
                  update.schema
                )
                turnDepsRef.current[update.endpoint] = hashSchema(update.schema)
                scheduleSchemaSave()
              }
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
    [apiRuntime, config, domino, finalizeSpec, scheduleSchemaSave]
  )

  /* ------------------------------ boot flow ------------------------------ */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const token = await getToken(storage, domino.id)
      sessionTokenRef.current = token
      loggedInRef.current = Boolean(token)

      schemaBookRef.current = await loadSchemaBook(storage, domino.id)
      const screens = await ScreenStore.open(storage, domino.id)
      screensRef.current = screens
      if (cancelled) return

      // Reopen lands exactly where the app was left — restored, not re-generated.
      const view = await screens.loadView(loggedInRef.current)
      if (cancelled) return
      if (view && findPage(view.known, view.page)) {
        finalizeSpec({ ...view.known, page: view.page }, null)
        return
      }

      const target = resolveInitialPage(domino, loggedInRef.current)
      const cacheKey = `init::${target}::auth:${loggedInRef.current}`
      const cached = session.cacheGet(cacheKey)
      if (cached && !cancelled) {
        finalizeSpec(cached, cacheKey)
        return
      }
      // A screen an earlier session persisted — same deps check as events.
      const stored = screens.get(cacheKey, schemaHashes())
      if (stored && !cancelled) {
        session.cacheSet(cacheKey, stored.spec)
        finalizeSpec(withKnownPages(stored.spec, knownRef.current), cacheKey)
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
      interruptTurn() // cancel any streaming turn
      showSpec(snap.spec)
      syncNav()
    }
  }, [interruptTurn, session, showSpec, syncNav])

  const goForward = useCallback(() => {
    const snap = session.forward()
    if (snap) {
      interruptTurn()
      showSpec(snap.spec)
      syncNav()
    }
  }, [interruptTurn, session, showSpec, syncNav])

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

  // Android back / browser back: earlier screen first, then close the domino.
  useBackHandler(true, () => {
    if (session.canBack) goBack()
    else onHome()
  })

  /* ----------------------------- interactions ---------------------------- */

  // Login responses are small JSON; cap the read so a hostile or broken
  // endpoint can't stream an unbounded body into memory.
  const handleLogin = useCallback(
    async (data: Record<string, unknown>): Promise<void> => {
      setStreaming(true)
      setStatus('로그인 중…')
      setError(null)
      try {
        const loginUrl = resolveEndpoint(domino.auth.loginEndpoint!, domino.api.baseUrl)
        if (!loginUrl) {
          throw new Error('로그인 엔드포인트를 확인할 수 없습니다 ([api] base_url을 확인해 주세요)')
        }
        const res = await httpFetch(loginUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(30_000)
        })
        let body: unknown = null
        const text = await readTextCapped(res, 256_000)
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
        interruptTurn()
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
      // Persisted across restarts — but only while every endpoint it embeds
      // still answers with the shape the screen was built on.
      const stored = screensRef.current?.get(cacheKey, schemaHashes())
      if (stored) {
        session.cacheSet(cacheKey, stored.spec)
        finalizeSpec(withKnownPages(stored.spec, knownRef.current), cacheKey)
        return
      }
      void runTurn(
        `The user acted on the current screen (see ACTION above). Compute and render the next screen.`,
        cacheKey
      )
    },
    [
      currentSpec,
      domino,
      finalizeSpec,
      handleLogin,
      interruptTurn,
      runTurn,
      schemaHashes,
      session,
      storage
    ]
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

  /**
   * "Change what I'm looking at": the instruction goes into history verbatim,
   * then one turn applies it. Its result becomes the page's canonical version
   * (session + persistent screen cache + view snapshot all update).
   */
  const submitEdit = useCallback(
    (raw: string): void => {
      const text = raw.trim()
      if (!text || !currentSpec) return
      const pageId = currentSpec.page
      setEditText('')
      setEditOpen(false)
      interruptTurn()
      historyRef.current.push({ role: 'user', content: `EDIT REQUEST (page "${pageId}"): ${text}` })
      if (historyRef.current.length > 60) historyRef.current.splice(0, 20)

      const cacheKey = `edit::${pageId}::${hashContext(text)}`
      const cached = session.cacheGet(cacheKey)
      if (cached) {
        finalizeSpec(cached, cacheKey)
        return
      }
      const stored = screensRef.current?.get(cacheKey, schemaHashes())
      if (stored) {
        session.cacheSet(cacheKey, stored.spec)
        finalizeSpec(withKnownPages(stored.spec, knownRef.current), cacheKey)
        return
      }
      void runTurn(
        `The user asked to change the current screen (EDIT REQUEST above). Apply only that change to page "${pageId}" and keep everything else — layout, ids, values, data and the other pages — as it is unless the change requires otherwise. Re-render the page.`,
        cacheKey
      )
    },
    [currentSpec, finalizeSpec, interruptTurn, runTurn, schemaHashes, session]
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
  const [scrolled, setScrolled] = useState<'up' | 'down'>('up')
  const lastScroll = useRef(0)
  useLayoutEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
    lastScroll.current = 0
    setScrolled('up')
  }, [shownPageId])
  // Hide the floating runtime button while reading down; bring it back on scroll up.
  const onBodyScroll = (e: React.UIEvent<HTMLElement>): void => {
    const y = e.currentTarget.scrollTop
    const delta = y - lastScroll.current
    if (Math.abs(delta) < 8) return
    lastScroll.current = y
    setScrolled(delta > 0 && y > 48 ? 'down' : 'up')
  }
  // A same-origin base URL ("/zen/…") goes through the dev proxy, which may add the key.
  const needsKey = needsApiKey(config)
  const shownPage = shown ? (shown.pages.find((p) => p.id === shown.page) ?? shown.pages[0]) : null
  // A screen still streaming already knows its name and navigation.
  const title = (previewSpec && shownPage?.name) || pageName
  const navItems = previewSpec?.nav?.length ? previewSpec.nav : nav
  const hasNav = navItems.length > 0

  // The floating action button sits above the bottom tab bar when there is one.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--bottom-nav-h', hasNav ? '64px' : '0px')
    return () => {
      root.style.removeProperty('--bottom-nav-h')
    }
  }, [hasNav])

  const menuAction = (key: React.Key): void => {
    if (key === 'back') goBack()
    else if (key === 'forward') goForward()
    else if (key === 'edit') setEditOpen(true)
    else if (key === 'inspect') setChrome(chrome === 'app' ? 'inspect' : 'app')
    else if (key === 'settings') onOpenSettings()
    else if (key === 'home') onHome()
  }

  return (
    <div
      className="runtime"
      data-density={domino.ui.density}
      data-style={domino.ui.style}
      data-scrolled={scrolled}
    >
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
        {/* Live "change this screen" composer: centered over the bar (opaque,
            so it may ride over the title while focused). */}
        <form
          className="app-bar-edit hide-phone"
          onSubmit={(e) => {
            e.preventDefault()
            submitEdit(editText)
          }}
        >
          <TextField
            value={editText}
            onChange={setEditText}
            aria-label="현재 화면 수정 요청"
            isDisabled={!currentSpec}
            variant="secondary"
          >
            <InputGroup variant="secondary" fullWidth>
              <InputGroup.Prefix>
                <Icon name="edit" className="text-muted" size={14} />
              </InputGroup.Prefix>
              <InputGroup.Input
                placeholder="이 화면 바꾸기… (예: 상태 컬럼 추가)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitEdit(editText)
                  }
                }}
              />
            </InputGroup>
          </TextField>
        </form>
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
        </div>
      </header>

      {/* Phones: the runtime controls shrink to one floating button. */}
      <div className="runtime-pill phone-only">
        <Dropdown>
          <Button isIconOnly variant="secondary" aria-label="Domino UI 메뉴">
            {streaming ? <Spinner size="sm" /> : <Icon name="more" size={18} />}
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label="Runtime menu"
              onAction={menuAction}
              disabledKeys={[
                ...(canBack ? [] : ['back']),
                ...(canForward ? [] : ['forward']),
                ...(currentSpec ? [] : ['edit'])
              ]}
            >
              <Dropdown.Section>
                <Header className="px-2 pb-1 text-xs text-muted">
                  {domino.meta.name}
                  {title ? ` · ${title}` : ''}
                  {streaming ? ` · ${status || '생성 중…'}` : ''}
                </Header>
                <Dropdown.Item id="edit" textValue="화면 수정">
                  <Icon name="edit" />
                  <Label>화면 수정</Label>
                </Dropdown.Item>
                <Dropdown.Item id="back" textValue="이전 화면">
                  <Icon name="back" />
                  <Label>이전 화면</Label>
                </Dropdown.Item>
                <Dropdown.Item id="forward" textValue="다음 화면">
                  <Icon name="arrow-right" />
                  <Label>다음 화면</Label>
                </Dropdown.Item>
              </Dropdown.Section>
              <Dropdown.Item id="inspect" textValue="구조 보기">
                <Icon name="layers" />
                <Label>{chrome === 'app' ? '구조 보기' : '앱처럼 보기'}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="settings" textValue="설정">
                <Icon name={needsKey ? 'key' : 'settings'} />
                <Label>{needsKey ? '설정 (BYOK 미설정)' : '설정'}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="home" textValue="domino 닫기">
                <Icon name="close" />
                <Label>domino 닫기</Label>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>

      {/* Phone: the same composer as a modal, opened from the pill menu. */}
      <Modal.Backdrop
        isOpen={editOpen}
        onOpenChange={(open) => {
          if (!open) setEditOpen(false)
        }}
        variant="blur"
      >
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog aria-label="화면 수정">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>화면 수정</Modal.Heading>
              <p className="text-sm text-muted">
                지금 보고 있는 화면에서 바뀌었으면 하는 것만 말해 주세요.
              </p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <TextField
                value={editText}
                onChange={setEditText}
                aria-label="화면 수정 요청"
                isDisabled={!currentSpec}
                variant="secondary"
                fullWidth
              >
                <TextArea
                  rows={4}
                  placeholder="예) 거래 상태 컬럼을 맨 앞에 추가하고, 금액은 천 단위 구분자로 표시해줘"
                />
              </TextField>
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" onPress={() => setEditOpen(false)}>
                취소
              </Button>
              <Button
                isDisabled={!currentSpec || !editText.trim()}
                onPress={() => submitEdit(editText)}
              >
                수정 요청
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <div className="runtime-main">
        {hasNav ? <SideNav items={navItems} activeId={activeNav} onSelect={handleNav} /> : null}
        <main className="runtime-body" ref={bodyRef} onScroll={onBodyScroll}>
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

// Deep: form data nests (data.user.password) and secret keys come in more
// spellings than the top level alone (pwd, pin, credential…). Depth-capped so
// a pathological payload can't blow the stack; over-redacting is safe.
const REDACT_KEY = /pass|pwd|secret|token|key|pin|credential|auth/i

function redactValue(v: unknown, depth: number): unknown {
  if (depth > 6) return '…'
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '••••••' : redactValue(val, depth + 1)
    }
    return out
  }
  return v
}

function redact(data: Record<string, unknown>): Record<string, unknown> {
  return redactValue(data, 0) as Record<string, unknown>
}
