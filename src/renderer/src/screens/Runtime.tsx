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
  AlertDialog,
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
import { mergeKnownPage, pregenTargets } from '@core/agent/pregen'
import { nextSpecChars, renderProgress } from '@core/agent/progress'
import { applyScript, buildScriptContext } from '@core/domino/script'
import type { DominoFile } from '@core/domino/types'
import { createAdapter, needsApiKey, type ChatMessage, type LLMConfig } from '@core/llm'
import { httpFetch, readTextCapped } from '@core/net'
import { hashContext, SessionStore } from '@core/session/session'
import { clearToken, extractToken, getToken, setToken } from '@core/session/prefs'
import { ScreenStore, type ScreenDeps } from '@core/session/screenStore'
import { BottomNav, SideNav } from '@core/ui/AppNav'
import { CardGrid } from '@core/ui/CardGrid'
import { changedNodeIds, streamView } from '@core/ui/streaming'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'
import { themeVars } from '@core/ui/theme'
import {
  findNode,
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

/** How a turn ended: applied to a screen, failed, or taken over by a newer turn. */
type TurnOutcome = 'applied' | 'failed' | 'superseded'

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
  /** Bumped when history is wiped (rebuild): an orphaned turn must not append back. */
  const historyEpochRef = useRef(0)
  const turnSeq = useRef(0)
  /** Which kind of turn owns the lane — navigation spares background edits. */
  const turnKindRef = useRef<'user' | 'edit' | null>(null)
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
  /** Rendering gauge: turn start, streamed chars, EMA of finished spec sizes. */
  const progressStart = useRef(0)
  const progressChars = useRef(0)
  const specCharsEma = useRef(0)
  const progressTimer = useRef<number | null>(null)
  const progressFade = useRef<number | null>(null)
  /** Background pre-generation: bumped to cancel (user turn, unmount, logout). */
  const pregenSeq = useRef(0)
  const pregenScheduled = useRef(false)
  /** Late-bound so the early finalize hook can reach the runner declared below. */
  const pregenRunnerRef = useRef<((seq: number) => Promise<void>) | null>(null)

  const [currentSpec, setCurrentSpec] = useState<UiSpec | null>(null)
  /** Mirror of currentSpec for async turns deciding "is my page on screen". */
  const currentSpecRef = useRef<UiSpec | null>(null)
  useEffect(() => {
    currentSpecRef.current = currentSpec
  }, [currentSpec])
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
  // share the draft; submitting queues the request and drains it sequentially.
  const [editText, setEditText] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  /** "Rebuild from scratch" confirmation — carries the token-consumption warning. */
  const [rebuildOpen, setRebuildOpen] = useState(false)
  /** Queued edit requests ({text, pageId}), applied one at a time. */
  const editQueueRef = useRef<Array<{ text: string; pageId: string }>>([])
  const editDraining = useRef(false)
  const editFadeTimer = useRef<number | null>(null)
  /** True while ANY turn runs (edits wait on it; its finally re-drains). */
  const turnActiveRef = useRef(false)
  /** Late-bound so a turn's finally can drain without a stale closure. */
  const editDrainRef = useRef<(() => void) | null>(null)
  /** Requests queued + running — drives the toast count. */
  const [editCount, setEditCount] = useState(0)
  /** Spec the current highlight diffs against; null = no highlight. */
  const [editBase, setEditBase] = useState<UiSpec | null>(null)
  /** Live client-side screen state (spec.state) — applied without the model. */
  const stateRef = useRef<Record<string, unknown>>({})
  /** Local writes made while a turn was streaming; merged when it lands. */
  const pendingStateWrites = useRef<Record<string, unknown>>({})
  /** Top gauge fill 0–100; null hides it (fades out after a completed turn). */
  const [progress, setProgress] = useState<number | null>(null)

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

  /* ----------------------------- rendering gauge ---------------------------- */

  /** Show the top gauge at 0% and tick it: elapsed-time creep while the model
   *  thinks, then (once chars arrive) the measured argument stream. */
  const startGauge = useCallback(() => {
    if (progressTimer.current !== null) window.clearInterval(progressTimer.current)
    if (progressFade.current !== null) {
      window.clearTimeout(progressFade.current)
      progressFade.current = null
    }
    progressStart.current = Date.now()
    progressChars.current = 0
    setProgress(0)
    progressTimer.current = window.setInterval(() => {
      setProgress(
        renderProgress({
          elapsed: Date.now() - progressStart.current,
          chars: progressChars.current,
          specChars: specCharsEma.current
        })
      )
    }, 150)
  }, [])

  /** Final spec arrived: complete the bar, then fade it out after 400ms. */
  const finishGauge = useCallback(() => {
    if (progressTimer.current !== null) {
      window.clearInterval(progressTimer.current)
      progressTimer.current = null
    }
    setProgress(100)
    progressFade.current = window.setTimeout(() => {
      progressFade.current = null
      setProgress(null)
    }, 400)
  }, [])

  /** No finished screen (error/interrupt): drop the bar immediately. */
  const cancelGauge = useCallback(() => {
    if (progressTimer.current !== null) {
      window.clearInterval(progressTimer.current)
      progressTimer.current = null
    }
    if (progressFade.current !== null) {
      window.clearTimeout(progressFade.current)
      progressFade.current = null
    }
    setProgress(null)
  }, [])

  // Unmounting mid-turn must not leave the interval ticking into a dead tree.
  useEffect(
    () => () => {
      if (progressTimer.current !== null) window.clearInterval(progressTimer.current)
      if (progressFade.current !== null) window.clearTimeout(progressFade.current)
    },
    []
  )

  /** Drop the changed-cell highlight immediately (and any pending fade). */
  const clearEditHighlight = useCallback(() => {
    if (editFadeTimer.current !== null) {
      window.clearTimeout(editFadeTimer.current)
      editFadeTimer.current = null
    }
    setEditBase(null)
  }, [])

  /** After the last edit lands, keep the glow ~2s then let it fade out. */
  const armEditFade = useCallback(() => {
    if (editFadeTimer.current !== null) window.clearTimeout(editFadeTimer.current)
    editFadeTimer.current = window.setTimeout(() => {
      editFadeTimer.current = null
      setEditBase(null)
    }, 2000)
  }, [])

  // Bumping turnSeq orphans the in-flight turn's finally guard, which then
  // skips its cleanup — so every invalidation site clears the streaming UI
  // here too, or the spinner sticks and the handleNav guard blocks taps.
  //
  // Navigation interrupts the streaming USER turn only. A background edit
  // keeps its lane: its result lands on its own page wherever the user has
  // browsed to (landEdit), and the toast/gauge stay up while it runs.
  const interruptTurn = useCallback(() => {
    if (turnKindRef.current === 'edit') return
    turnSeq.current++
    turnActiveRef.current = false
    setStreaming(false)
    setPreviewSpec(null)
    setStatus('')
    cancelGauge()
    // The interrupted turn's finally is now orphaned (guard skips it), so a
    // queued edit that was waiting on this lane must be drained from here.
    editDrainRef.current?.()
  }, [cancelGauge])

  /** Apply a spec's navigation: explicit `nav` wins, login screens never show it. */
  const applyNav = useCallback((spec: UiSpec) => {
    let items = navRef.current
    if (spec.nav !== undefined) items = spec.nav
    else if (spec.page === 'login') items = []
    navRef.current = items
    setNav(items)
    if (items.some((i) => i.id === spec.page)) setActiveNav(spec.page)
  }, [])

  /**
   * Once per session, after the first screen settles: build the nav/script
   * pages in the background (max 3, sequential) so tapping them switches
   * instantly. Any user turn cancels it — a live request wins over prefetching.
   */
  const schedulePreGen = useCallback(() => {
    if (pregenScheduled.current || needsApiKey(config)) return
    pregenScheduled.current = true
    const seq = pregenSeq.current
    // Let the screen that just settled paint (and its turn wind down) first.
    window.setTimeout(() => {
      void pregenRunnerRef.current?.(seq)
    }, 400)
  }, [config])

  const showSpec = useCallback(
    (spec: UiSpec) => {
      // Overlay the live client-side state so stale cache hits and
      // back/forward snapshots show current values, not their capture-time ones.
      const live = Object.keys(stateRef.current).length > 0 ? stateRef.current : undefined
      const applied = live ? { ...spec, state: { ...spec.state, ...live } } : spec
      // Back/forward snapshots may predate pages delivered since; keep those too.
      const known = withKnownPages(applied, knownRef.current)
      knownRef.current = known
      currentSpecRef.current = applied // async turns decide visibility against it
      setCurrentSpec(applied)
      setPreviewSpec(null)
      setPageName(applied.pages.find((p) => p.id === applied.page)?.name ?? applied.page)
      applyNav(applied)
      // Remember where the user was: reopening restores this screen as-is.
      void screensRef.current?.saveView(loggedInRef.current, { page: applied.page, known })
    },
    [applyNav]
  )

  const finalizeSpec = useCallback(
    (spec: UiSpec, cacheKey: string | null) => {
      session.push(spec)
      if (cacheKey) session.cacheSet(cacheKey, spec)
      // The model's state is the truth when it sends one (its own declarations
      // plus any explicit changes); when it omits the field, keep the live
      // values — a turn that never touched them. Writes made while the turn
      // streamed beat both: they happened after the model's snapshot.
      if (spec.state !== undefined) {
        stateRef.current = { ...spec.state, ...pendingStateWrites.current }
      }
      // A non-edit screen (click hit, boot, instant-nav) makes the previous
      // edit's result the new baseline — no cells left to glow.
      if (!cacheKey?.startsWith('edit::')) clearEditHighlight()
      showSpec(spec)
      syncNav()
      schedulePreGen()
    },
    [clearEditHighlight, schedulePreGen, session, showSpec, syncNav]
  )

  const apiRuntime = useCallback(
    () => ({
      baseUrl: domino.api.baseUrl,
      allow: domino.api.allow,
      token: loggedInRef.current ? sessionTokenRef.current : null
    }),
    [domino]
  )

  /**
   * Land an edit's result on ITS page. The user is on that page right now →
   * the normal finalize path (session push + cache + highlight). They browsed
   * elsewhere → merge into the known pages only: no session.push (the back
   * stack is theirs, not the edit's), viewport and live state untouched — the
   * change appears when that page is next shown.
   */
  const landEdit = useCallback(
    (spec: UiSpec, cacheKey: string, pageId: string): void => {
      const visible = currentSpecRef.current
      if (visible && visible.page === pageId) {
        // Navigation during the edit may have dropped the glow; re-baseline on
        // the screen as it stands so only this edit's cells light up.
        setEditBase(visible)
        finalizeSpec(spec, cacheKey)
        return
      }
      session.cacheSet(cacheKey, spec)
      // Keep the page the user is looking at; every page the model returned
      // (one page, or all of them for an app-wide edit) still wins.
      showSpec({ ...spec, page: visible?.page ?? spec.page })
    },
    [finalizeSpec, session, showSpec]
  )

  const runTurn = useCallback(
    async (prompt: string, cacheKey: string | null): Promise<TurnOutcome> => {
      const isEdit = Boolean(cacheKey?.startsWith('edit::'))
      const editPageId = isEdit && cacheKey ? cacheKey.slice('edit::'.length).split('::')[0] : null
      const myTurn = ++turnSeq.current
      turnKindRef.current = isEdit ? 'edit' : 'user'
      pregenSeq.current++ // a live request outranks background building
      turnActiveRef.current = true
      turnDepsRef.current = {}
      // An ordinary turn replaces the screen the edit glow was tracking.
      if (!isEdit) clearEditHighlight()
      // Inject live client-side state so the model carries it in "state";
      // writes made from here on are merged over its result when it lands.
      const liveState =
        Object.keys(stateRef.current).length > 0
          ? `\nCurrent screen state (updated client-side — carry it in your "state" field): ${JSON.stringify(stateRef.current)}`
          : ''
      pendingStateWrites.current = {}
      setStreaming(true)
      setError(null)
      setStatus('생성 중…')
      startGauge()

      // The engine splices history back into the array it is given, and a newer
      // turn may start while this one winds down — so run on our own copy and
      // hand back only the messages we added (append-only: neither side's
      // entries are lost, executed tool calls still reach the next turn).
      const fork: ChatMessage[] = [...historyRef.current]
      const snapLen = fork.length
      // A rebuild wipes history mid-turn: then this turn's messages belong to
      // a conversation that no longer exists and must not be appended back.
      const epoch = historyEpochRef.current

      let completed = false
      try {
        const adapter = createAdapter(config)
        // One snapshot per turn: the engine diffs responses against it, the
        // prompt describes screens built from it.
        const knownSchemas = bookFields(schemaBookRef.current)
        const system = buildSystemPrompt(domino, {
          loggedIn: loggedInRef.current,
          knownSchemas
        })
        fork.push({ role: 'user', content: prompt + liveState })
        for await (const update of runAgentTurn({
          adapter,
          system,
          history: fork,
          api: apiRuntime(),
          knownSchemas
        })) {
          if (turnSeq.current !== myTurn) break // superseded by a newer turn
          switch (update.type) {
            case 'spec':
              if (update.final) {
                // Teach the gauge how big finished specs are (for next turn's
                // denominator), then complete and fade the bar.
                specCharsEma.current = nextSpecChars(
                  specCharsEma.current,
                  progressChars.current > 0
                    ? progressChars.current
                    : JSON.stringify(update.spec).length
                )
                finishGauge()
                completed = true
                const merged = withKnownPages(update.spec, knownRef.current)
                if (isEdit && cacheKey && editPageId) landEdit(merged, cacheKey, editPageId)
                else finalizeSpec(merged, cacheKey)
                // Persist the screen (and which responses it was built from)
                // so the next session restores it instead of regenerating.
                if (cacheKey) {
                  void screensRef.current?.put(cacheKey, merged, turnDepsRef.current)
                }
                setStatus('')
              } else {
                // Previews are interruptible: typing/scrolling stays responsive
                // while the screen assembles, and stale previews get skipped.
                // A background edit previews only while its target page is on
                // screen — browsing elsewhere must not flash the edit over it.
                if (!isEdit || currentSpecRef.current?.page === editPageId) {
                  startTransition(() => setPreviewSpec(update.spec))
                }
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
            case 'progress':
              progressChars.current = update.chars
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
        // Hand our messages back even when superseded: an already-executed
        // tool call must reach the next turn's history. Append-only, so a turn
        // that started meanwhile keeps whatever it pushed in the meantime.
        const mine = fork.slice(snapLen)
        if (mine.length && historyEpochRef.current === epoch) historyRef.current.push(...mine)
        if (turnSeq.current === myTurn) {
          turnKindRef.current = null
          turnActiveRef.current = false
          setStreaming(false)
          setPreviewSpec(null)
          setStatus('')
          // A turn that ended without a final spec leaves the bar mid-fill;
          // a completed one is already fading out on its own.
          if (!completed) cancelGauge()
          // A finished edit glows for ~2s; a failed/interrupted one drops
          // the highlight at once. Either way, drain any queued requests.
          if (isEdit) {
            if (completed) armEditFade()
            else clearEditHighlight()
          }
          editDrainRef.current?.()
        }
      }
      // Superseded after applying still counts as applied (the queue advances);
      // superseded before finishing keeps its queue head for the re-drain.
      if (completed) return 'applied'
      return turnSeq.current === myTurn ? 'failed' : 'superseded'
    },
    [
      apiRuntime,
      armEditFade,
      cancelGauge,
      clearEditHighlight,
      config,
      domino,
      finalizeSpec,
      landEdit,
      scheduleSchemaSave,
      startGauge
    ]
  )

  /* ------------------------- background pre-generation ------------------------- */

  /** Build one page in an isolated scratch history — never the user's conversation. */
  const pregenOne = useCallback(
    async (pageId: string, seq: number): Promise<UiSpec | null> => {
      const scratch: ChatMessage[] = [
        {
          role: 'user',
          content: `INITIAL SCREEN. Show the "${pageId}" page following the screen patterns.`
        }
      ]
      const knownSchemas = bookFields(schemaBookRef.current)
      const system = buildSystemPrompt(domino, {
        loggedIn: loggedInRef.current,
        knownSchemas
      })
      try {
        for await (const update of runAgentTurn({
          adapter: createAdapter(config),
          system,
          history: scratch, // the engine splices history: sharing would corrupt it
          api: apiRuntime(),
          knownSchemas
        })) {
          if (pregenSeq.current !== seq) return null // cancelled: walk away silently
          if (update.type === 'spec' && update.final) return update.spec
          // previews and api_results are ignored: nothing on screen changes
        }
      } catch {
        return null // a failed background build just becomes a live-generating tap
      }
      return null
    },
    [apiRuntime, config, domino]
  )

  const maybeRunPreGen = useCallback(
    async (seq: number): Promise<void> => {
      if (pregenSeq.current !== seq || needsApiKey(config)) return
      const base = knownRef.current
      if (!base) return
      for (const pageId of pregenTargets(domino, base, loggedInRef.current)) {
        if (pregenSeq.current !== seq) return
        const built = await pregenOne(pageId, seq)
        if (pregenSeq.current !== seq || !built || !knownRef.current) return
        // Merge into what the runtime knows — no session.push (no back-stack
        // pollution), no showSpec (the user's screen never flickers).
        knownRef.current = mergeKnownPage(knownRef.current, built, pageId)
        setCurrentSpec((prev) => (prev ? mergeKnownPage(prev, built, pageId) : prev))
      }
      // The view snapshot now carries the background pages too — reopening keeps them.
      const known = knownRef.current
      if (pregenSeq.current === seq && known) {
        void screensRef.current?.saveView(loggedInRef.current, { page: known.page, known })
      }
    },
    [config, domino, pregenOne]
  )
  pregenRunnerRef.current = maybeRunPreGen

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
      pregenSeq.current++ // …and any background builds still running
      editQueueRef.current = [] // …queued edits must not start new turns
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------- back / forward keys ------------------------- */
  const goBack = useCallback(() => {
    const snap = session.back()
    if (snap) {
      interruptTurn() // cancel any streaming user turn (edits are spared)
      // The snapshot diffs against a different baseline — drop stale glow;
      // a landing edit re-baselines on what's on screen then (landEdit).
      clearEditHighlight()
      showSpec(snap.spec)
      syncNav()
    }
  }, [clearEditHighlight, interruptTurn, session, showSpec, syncNav])

  const goForward = useCallback(() => {
    const snap = session.forward()
    if (snap) {
      interruptTurn()
      clearEditHighlight()
      showSpec(snap.spec)
      syncNav()
    }
  }, [clearEditHighlight, interruptTurn, session, showSpec, syncNav])

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

  /** Write client-side state locally: no history, no cache, no model turn. */
  const applyLocalState = useCallback(
    (key: string, value: unknown): void => {
      const next = { ...stateRef.current, [key]: value }
      stateRef.current = next
      pendingStateWrites.current[key] = value
      // saveView persists the overlay; no session.push → back-stack untouched.
      if (currentSpec) showSpec({ ...currentSpec, state: next })
    },
    [currentSpec, showSpec]
  )

  const handleEvent = useCallback(
    (e: ActionEvent): void => {
      const pageId = currentSpec?.page ?? e.pageId
      const hasPassword = Boolean(e.data && 'password' in e.data)
      if (e.event === 'submit' && hasPassword && domino.auth.loginEndpoint) {
        void handleLogin(e.data ?? {})
        return
      }

      // Client-side screen state (spec.state): a change on a state-keyed field
      // or a click on a stateKey+delta button is applied by the runtime itself
      // — no history, no cache, no LLM round trip.
      if (currentSpec?.state) {
        if (e.event === 'change') {
          const name = String(e.data?.name ?? e.nodeId)
          if (name in currentSpec.state) {
            applyLocalState(name, e.data?.value)
            return
          }
        } else if (e.event === 'click') {
          const node = findNode(currentSpec, e.nodeId)
          const stateKey = node?.props?.stateKey
          if (typeof stateKey === 'string' && stateKey in currentSpec.state) {
            const delta = Number(node?.props?.delta)
            const cur = Number(currentSpec.state[stateKey])
            if (Number.isFinite(delta) && Number.isFinite(cur)) {
              applyLocalState(stateKey, cur + delta)
              return
            }
          }
        }
      }

      // Sign-out convention: the runtime owns the token, so it clears it itself.
      if (isSignOutEvent(e) && loggedInRef.current) {
        void (async () => {
          // The signed-out screen must not be rebuilt from a queued edit —
          // drop pending requests (the runTurn below supersedes a running one).
          editQueueRef.current = []
          setEditCount(0)
          clearEditHighlight()
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
      clearEditHighlight,
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
   * Apply one queued edit: history records it now (not at submit time, so an
   * in-flight turn's history stays coherent), the highlight baseline is the
   * screen as it stands, then cache or one turn applies the change — landing
   * on the edited page wherever the user has browsed to (landEdit).
   */
  const processEdit = useCallback(
    async (item: { text: string; pageId: string }): Promise<TurnOutcome> => {
      historyRef.current.push({
        role: 'user',
        content: `EDIT REQUEST (page "${item.pageId}"): ${item.text}`
      })
      if (historyRef.current.length > 60) historyRef.current.splice(0, 20)

      setEditBase(knownRef.current)
      const cacheKey = `edit::${item.pageId}::${hashContext(item.text)}`
      const cached = session.cacheGet(cacheKey)
      if (cached) {
        landEdit(cached, cacheKey, item.pageId)
        armEditFade()
        return 'applied'
      }
      const stored = screensRef.current?.get(cacheKey, schemaHashes())
      if (stored) {
        landEdit(withKnownPages(stored.spec, knownRef.current), cacheKey, item.pageId)
        armEditFade()
        return 'applied'
      }
      return await runTurn(
        `The user asked to change the current screen (EDIT REQUEST above). Apply only that change to page "${item.pageId}" and keep everything else — layout, ids, values, data and the other pages — as it is unless the change requires otherwise. Re-render the page. If the request is app-wide (a theme, colors, wording, navigation), re-render every page with the change applied and include all of them in the spec.`,
        cacheKey
      )
    },
    [armEditFade, landEdit, runTurn, schemaHashes, session]
  )

  /**
   * Queue head → apply → next. Never overlaps a turn; turns re-drain on
   * finish. A newer turn superseding an edit keeps its head in the queue —
   * the edit resumes from that turn's finally instead of being lost.
   */
  const drainEditQueue = useCallback((): void => {
    if (editDraining.current || turnActiveRef.current) return
    const head = editQueueRef.current[0]
    if (!head) return
    editDraining.current = true
    const advance = (): void => {
      if (editQueueRef.current[0] === head) editQueueRef.current.shift()
    }
    void processEdit(head).then(
      (outcome) => {
        // Superseded: keep the head — this edit re-runs on the next drain.
        if (outcome !== 'superseded') advance()
      },
      // An unexpected throw is a failed edit: advance rather than loop on it.
      advance
    ).finally(() => {
      editDraining.current = false
      setEditCount(editQueueRef.current.length)
      if (editQueueRef.current.length > 0) drainEditQueue()
    })
  }, [processEdit])
  editDrainRef.current = drainEditQueue

  /**
   * "Change what I'm looking at": the request is queued and applied by
   * drainEditQueue in the background — it survives page navigation, stacks
   * with further requests, and each result becomes its page's canonical
   * version (session + screen cache + view snapshot).
   */
  const submitEdit = useCallback(
    (raw: string): void => {
      const text = raw.trim()
      if (!text || !currentSpec) return
      editQueueRef.current.push({ text, pageId: currentSpec.page })
      setEditCount(editQueueRef.current.length)
      setEditText('')
      setEditOpen(false)
      drainEditQueue()
    },
    [currentSpec, drainEditQueue]
  )

  /**
   * "Tangled beyond repair": wipe every derived copy — conversation, caches,
   * back stack, stored screens — and generate the app again from the current
   * state, exactly like a fresh boot. The token cost is real (a full LLM
   * re-generation), so the caller only reaches here through the warning dialog.
   */
  const rebuildApp = useCallback((): void => {
    // Stop everything in flight: queued edits die here, and the lane
    // interrupt covers a background edit too (kind is cleared first so the
    // edit-lane exemption doesn't spare it). turnSeq bump orphans any
    // running turn's finally — the epoch guard keeps its messages out of
    // the history we are about to wipe.
    editQueueRef.current = []
    setEditCount(0)
    clearEditHighlight()
    turnKindRef.current = null
    interruptTurn()
    historyEpochRef.current++
    historyRef.current = []
    // Content: everything derived from past turns goes.
    knownRef.current = null
    currentSpecRef.current = null
    setCurrentSpec(null)
    setPreviewSpec(null)
    setPageName('')
    // Navigation + caches: no snapshot, no replay, no reopen-restores-old-pages.
    session.reset()
    void screensRef.current?.clear(loggedInRef.current)
    syncNav()
    // Live state and the rest of the surface state.
    stateRef.current = {}
    pendingStateWrites.current = {}
    navRef.current = []
    setNav([])
    setActiveNav(null)
    setEditText('')
    setEditOpen(false)
    pregenSeq.current++ // any background build targets pages that no longer exist
    pregenScheduled.current = false
    setError(null)
    // schemaBookRef stays: API response shapes are unrelated to page tangles
    // and re-learning them would only cost extra calls.
    // Boot's opening move, unchanged: one turn draws the first page.
    const target = resolveInitialPage(domino, loggedInRef.current)
    const auth = domino.auth.required ? ` Logged in: ${loggedInRef.current ? 'yes' : 'no'}.` : ''
    void runTurn(
      `INITIAL SCREEN.${auth} Show the "${target}" page following the screen patterns.`,
      `init::${target}::auth:${loggedInRef.current}`
    )
  }, [clearEditHighlight, interruptTurn, runTurn, session, syncNav])

  /* -------------------------------- render -------------------------------- */
  const view = useMemo(
    () => (previewSpec ? streamView(currentSpec, previewSpec) : null),
    [currentSpec, previewSpec]
  )
  const shown = view?.spec ?? currentSpec
  // Cells that differ from the edit baseline glow while (and just after) the
  // edit applies — streaming previews included, so the change is visible live.
  const changed = useMemo(
    () => (editBase && shown && editBase !== shown ? changedNodeIds(editBase, shown) : undefined),
    [editBase, shown]
  )
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
    else if (key === 'rebuild') setRebuildOpen(true)
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
      {progress !== null ? (
        <div
          className="render-gauge"
          role="progressbar"
          aria-label="렌더링 진행률"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          data-done={progress >= 100}
        >
          <div className="render-gauge-fill" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
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
          <BarButton
            label="처음부터 다시 만들기"
            icon="refresh"
            onPress={() => setRebuildOpen(true)}
            isDisabled={!currentSpec}
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
                ...(currentSpec ? [] : ['edit']),
                ...(currentSpec ? [] : ['rebuild'])
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
                <Dropdown.Item id="rebuild" textValue="처음부터 다시 만들기">
                  <Icon name="refresh" />
                  <Label>처음부터 다시 만들기</Label>
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

      {/* Rebuild-from-scratch: an explicit, warned choice — a full LLM
          re-generation is expensive and destroys every derived copy. */}
      <AlertDialog.Backdrop
        isOpen={rebuildOpen}
        onOpenChange={(open) => {
          if (!open) setRebuildOpen(false)
        }}
      >
        <AlertDialog.Container size="sm" placement="center">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>앱을 처음부터 다시 만들까요?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted">
                모든 화면과 대화 기록이 지워지고 현재 앱 상태에서 처음부터 다시 생성됩니다.{' '}
                <strong className="text-warning">
                  LLM에 다시 요청하므로 토큰을 많이 소모할 수 있습니다.
                </strong>
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer className="flex justify-end gap-2">
              <Button variant="ghost" onPress={() => setRebuildOpen(false)}>
                취소
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  setRebuildOpen(false)
                  rebuildApp()
                }}
              >
                다시 만들기
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <div className="runtime-main">
        {hasNav ? <SideNav items={navItems} activeId={activeNav} onSelect={handleNav} /> : null}
        <main className="runtime-body" ref={bodyRef} onScroll={onBodyScroll}>
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
              changed={changed}
            />
          ) : error ? null : (
            <LoadingScreen />
          )}
        </main>
      </div>
      {hasNav ? <BottomNav items={navItems} activeId={activeNav} onSelect={handleNav} /> : null}
      {/* Bottom-right chip: how many edit requests are queued / in flight. */}
      {editCount > 0 ? (
        <div className="edit-toast" role="status" aria-live="polite">
          <Spinner size="sm" />
          <span>
            {editCount > 1 ? `화면 수정 요청 ${editCount}건 처리 중…` : '화면 수정 요청 처리 중…'}
          </span>
        </div>
      ) : null}
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
