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
import { hashContext, SessionStore, type HistoryKind } from '@core/session/session'
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
  isCancelEvent,
  isSignOutEvent,
  withKnownPages,
  withTargetPage,
  type ActionEvent,
  type NavItem,
  type UiSpec
} from '@core/spec'
import { resolvePageId } from '@core/pageLinks'
import { isModalPresentation } from '@core/ui/presentation'
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
  /** The most recent turn — its prompt is what "retry" re-runs after a failure. */
  const lastTurnRef = useRef<{ prompt: string; cacheKey: string | null } | null>(null)
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
  /** Right-side screen-history drawer (collapsed by default). */
  const [historyOpen, setHistoryOpen] = useState(false)
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
    // Highlight the tab this screen belongs to: by id first, then by the
    // page's name (nav ids drift from page ids). Nothing matching — a page
    // outside the nav — clears the highlight instead of leaving it stale.
    const name = spec.pages.find((p) => p.id === spec.page)?.name
    const active = items.find((i) => i.id === spec.page || (name !== undefined && i.label === name))
    setActiveNav(active ? active.id : null)
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

  /**
   * A failed turn keeps the app usable: show the error, and when we have a
   * cached screen for the very same action, keep it on stage ("stale but
   * there") instead of leaving an empty page behind the banner.
   */
  const failTurn = useCallback(
    (message: string, cacheKey: string | null): void => {
      const fallback = cacheKey ? screensRef.current?.get(cacheKey, schemaHashes()) : null
      if (fallback) {
        showSpec(withTargetPage(fallback.spec, knownRef.current))
        setError(`${message}\n이전에 만들어둔 화면을 그대로 보여 주고 있습니다.`)
      } else {
        setError(message)
      }
    },
    [schemaHashes, showSpec]
  )

  /* --------------------- result toast (undo / notice) --------------------- */
  const [resultToast, setResultToast] = useState<{
    kind: 'undo' | 'notice'
    text: string
    target: number | null
    pageId?: string
  } | null>(null)
  const resultToastTimer = useRef<number | null>(null)
  const clearResultToast = useCallback((): void => {
    if (resultToastTimer.current !== null) {
      window.clearTimeout(resultToastTimer.current)
      resultToastTimer.current = null
    }
    setResultToast(null)
  }, [])
  const armResultToast = useCallback(
    (toast: NonNullable<typeof resultToast>, ms: number): void => {
      if (resultToastTimer.current !== null) window.clearTimeout(resultToastTimer.current)
      setResultToast(toast)
      resultToastTimer.current = window.setTimeout(() => {
        resultToastTimer.current = null
        setResultToast(null)
      }, ms)
    },
    []
  )
  useEffect(
    () => () => {
      if (resultToastTimer.current !== null) window.clearTimeout(resultToastTimer.current)
    },
    []
  )

  /* ------------------- token usage + API call inspection ------------------- */
  /** Last turn's token total (transient chip); session cumulative (drawer). */
  const [lastUsage, setLastUsage] = useState<number | null>(null)
  const [usageTotal, setUsageTotal] = useState(0)
  const lastUsageInTurn = useRef(0)
  const usageChipTimer = useRef<number | null>(null)
  /** Recent call_api results (newest first) — the drawer's API section. */
  const apiLogRef = useRef<Array<{ at: number; path: string; status: number; ms: number }>>([])

  const finalizeSpec = useCallback(
    (spec: UiSpec, cacheKey: string | null, kindHint?: HistoryKind) => {
      // What the history panel shows as this moment's badge.
      const kind: HistoryKind =
        kindHint ??
        (cacheKey == null
          ? 'nav'
          : cacheKey.startsWith('edit::')
            ? 'edit'
            : /^(init|auth-ok|signed-out)::/.test(cacheKey)
              ? 'start'
              : 'action')
      session.push(spec, { kind })
      // Post-edit: offer a one-tap undo back to the moment BEFORE this edit.
      // Any other new moment retires the offer — its baseline has moved on.
      if (kind === 'edit') {
        const undoTo = session.historySize - 2
        if (undoTo >= 0) {
          armResultToast({ kind: 'undo', text: '수정이 반영되었습니다', target: undoTo }, 8_000)
        }
      } else {
        setResultToast((prev) => (prev?.kind === 'undo' ? null : prev))
      }
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
    [armResultToast, clearEditHighlight, schedulePreGen, session, showSpec, syncNav]
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
      // The user is elsewhere: landing silently felt like a lost request —
      // say so, and let the chip jump straight to the changed page.
      armResultToast(
        { kind: 'notice', text: `수정 완료 · ${findPage(spec, pageId)?.name ?? pageId}`, target: null, pageId },
        8_000
      )
    },
    [armResultToast, finalizeSpec, session, showSpec]
  )

  /**
   * Index of the moment a full-screen sheet would sit over — the nearest
   * older history entry on ANOTHER page (an edit of the sheet page itself
   * pushes its own entry; those are skipped). -1 when the current screen
   * isn't a sheet or there is nothing behind it.
   */
  const sheetBehindIndex = useCallback((): number => {
    const cs = currentSpecRef.current
    if (!cs) return -1
    const page = findPage(cs, cs.page)
    if (!page || !isModalPresentation(page)) return -1
    const entries = session.entries()
    const i = entries.findIndex((e) => e.current)
    let j = i - 1
    while (j >= 0 && entries[j].pageId === page.id) j--
    return j
  }, [session])

  /**
   * Restore one moment AS IT WAS: the snapshot's pages replace the canonical
   * copies (time travel) and its state replaces the live one — the explicit
   * counterpart to back/forward, which follow the current canonical pages.
   * Interrupts a running turn only when the restore came from the UI.
   */
  const restoreAt = useCallback(
    (index: number, fromUi: boolean): boolean => {
      const snap = session.jumpTo(index)
      if (!snap) return false
      if (fromUi) {
        interruptTurn()
        clearEditHighlight()
      }
      stateRef.current = { ...(snap.spec.state ?? {}) }
      pendingStateWrites.current = {}
      showSpec(snap.spec)
      syncNav()
      return true
    },
    [clearEditHighlight, interruptTurn, session, showSpec, syncNav]
  )

  const runTurn = useCallback(
    async (prompt: string, cacheKey: string | null): Promise<TurnOutcome> => {
      const isEdit = Boolean(cacheKey?.startsWith('edit::'))
      const editPageId = isEdit && cacheKey ? cacheKey.slice('edit::'.length).split('::')[0] : null
      lastTurnRef.current = { prompt, cacheKey }
      const myTurn = ++turnSeq.current
      turnKindRef.current = isEdit ? 'edit' : 'user'
      pregenSeq.current++ // a live request outranks background building
      // …and let the next settled screen re-arm it: one interruption used to
      // disable pre-generation for the rest of the session.
      pregenScheduled.current = false
      // A new turn owns a fresh usage window: drop the previous chip and the
      // per-turn baseline (the session total keeps what it accumulated).
      lastUsageInTurn.current = 0
      setLastUsage(null)
      if (usageChipTimer.current !== null) {
        window.clearTimeout(usageChipTimer.current)
        usageChipTimer.current = null
      }
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
      // "Take me back to that moment" arrives as an ordinary request: hand the
      // agent the moment list (bounded) so it can answer with history:<index>.
      const hist = session.entries()
      const historyLine =
        hist.length >= 2
          ? `\nScreen history (oldest first, "index) [kind] label time"; current = ${hist[hist.length - 1].index}): ` +
            hist
              .slice(-25)
              .map((e) => `${e.index}) [${e.kind}] ${e.label} ${new Date(e.at).toTimeString().slice(0, 5)}`)
              .join(' | ')
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
        fork.push({ role: 'user', content: prompt + liveState + historyLine })
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
              // Keep a bounded, newest-first log for the drawer's API section.
              apiLogRef.current.unshift({
                at: Date.now(),
                path: update.result.path,
                status: update.result.status,
                ms: update.result.ms ?? 0
              })
              if (apiLogRef.current.length > 50) apiLogRef.current.pop()
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
            case 'usage': {
              const t =
                update.usage.total ?? ((update.usage.prompt ?? 0) + (update.usage.completion ?? 0))
              if (t > 0) {
                // Provider totals are cumulative within one response: add only
                // the delta so a repeated chunk can't double-count the session.
                const add = Math.max(0, t - lastUsageInTurn.current)
                lastUsageInTurn.current = t
                setUsageTotal((prev) => prev + add)
                setLastUsage(t)
                if (usageChipTimer.current !== null) window.clearTimeout(usageChipTimer.current)
                usageChipTimer.current = window.setTimeout(() => {
                  usageChipTimer.current = null
                  setLastUsage(null)
                }, 8_000)
              }
              break
            }
            case 'navigated': {
              // "history:<index>" restores that exact moment (time travel);
              // the agent's own turn is spared — if it renders after, that wins.
              const histTarget = /^history:(\d+)$/.exec(update.page)
              if (histTarget) {
                restoreAt(Number(histTarget[1]), false)
                break
              }
              // The model switched pages itself: land on it when the runtime
              // knows the page — a tool call the UI ignored used to end the
              // turn 'failed' with the screen unchanged.
              const shownNow = currentSpecRef.current
              const page = shownNow
                ? resolvePageId(navRef.current, shownNow.pages, update.page)
                : null
              if (shownNow && page && page !== shownNow.page) {
                finalizeSpec({ ...shownNow, page }, null)
              }
              break
            }
            case 'error':
              failTurn(update.message, cacheKey)
              break
            case 'done':
              break
          }
        }
      } catch (err) {
        if (turnSeq.current === myTurn) failTurn((err as Error).message, cacheKey)
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
      failTurn,
      finalizeSpec,
      landEdit,
      restoreAt,
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
        // The user may have reached this page while earlier targets were
        // building: a page the runtime already knows is canonical — a live
        // render beats a background guess.
        if (knownRef.current?.pages.some((p) => p.id === pageId)) continue
        const built = await pregenOne(pageId, seq)
        if (pregenSeq.current !== seq || !knownRef.current) return
        if (!built) continue // one failed build must not abandon the rest
        // …same race across the build itself: re-check before merging.
        if (knownRef.current.pages.some((p) => p.id === pageId)) continue
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
        finalizeSpec(withTargetPage(stored.spec, knownRef.current), cacheKey)
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
  // Back/forward choose WHICH page to show, never WHEN: the snapshot's page
  // pointer + the current canonical pages (knownRef). Reviving the snapshot's
  // own copy used to rewind other pages to capture time — an edit tag vanished
  // and a list reverted after browsing back. Ids the canonical set doesn't
  // know (login boundary, cleared rebuilds) fall back to the snapshot's copy.
  const canonicalView = useCallback((snap: { spec: UiSpec }): UiSpec => {
    const cur = knownRef.current
    if (!cur) return snap.spec
    const target = snap.spec.page
    if (cur.pages.some((p) => p.id === target)) return { ...cur, page: target }
    const snapPage = snap.spec.pages.find((p) => p.id === target)
    return snapPage ? { ...cur, page: target, pages: [...cur.pages, snapPage] } : cur
  }, [])

  const goBack = useCallback(() => {
    // A full-screen sheet CLOSES rather than steps: jump to the moment it was
    // opened over (an edit pushed onto the sheet would otherwise demand two
    // backs before the sheet goes away).
    const behind = sheetBehindIndex()
    const snap = behind >= 0 ? session.jumpTo(behind) : session.back()
    if (snap) {
      interruptTurn() // cancel any streaming user turn (edits are spared)
      // The snapshot diffs against a different baseline — drop stale glow;
      // a landing edit re-baselines on what's on screen then (landEdit).
      clearEditHighlight()
      showSpec(canonicalView(snap))
      syncNav()
    }
  }, [canonicalView, clearEditHighlight, interruptTurn, session, sheetBehindIndex, showSpec, syncNav])

  const goForward = useCallback(() => {
    const snap = session.forward()
    if (snap) {
      interruptTurn()
      clearEditHighlight()
      showSpec(canonicalView(snap))
      syncNav()
    }
  }, [canonicalView, clearEditHighlight, interruptTurn, session, showSpec, syncNav])

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
  // …but while the history drawer is open, back closes the drawer (newest wins).
  useBackHandler(historyOpen, () => setHistoryOpen(false))

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

      // A sheet's Cancel dismisses the sheet in place — no model round trip.
      if (isCancelEvent(e) && sheetBehindIndex() >= 0) {
        goBack()
        return
      }

      // Pages the agent already delivered switch instantly, like a real app —
      // resolved through the nav↔page links, so a nav id that drifted from the
      // page id still lands on the stored page instead of asking the model to
      // draw it again ("yet another, different page").
      const target = e.event === 'navigate' ? String(e.data?.page ?? e.nodeId) : null
      // "history:<index>" (the agent restoring a moment) — same restore the
      // history panel runs; invalid indices are ignored.
      const histTarget = target ? /^history:(\d+)$/.exec(target) : null
      if (histTarget) {
        restoreAt(Number(histTarget[1]), true)
        return
      }
      const resolved =
        target && currentSpec ? resolvePageId(navRef.current, currentSpec.pages, target) : null
      if (resolved && currentSpec && resolved !== currentSpec.page) {
        interruptTurn()
        finalizeSpec({ ...currentSpec, page: resolved }, null)
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
        // A replay only speaks for ITS target page: the other pages in the
        // stored spec were captured alongside it and must not drag the rest
        // of the app back to that moment (withTargetPage).
        finalizeSpec(withTargetPage(cached, knownRef.current), cacheKey)
        return
      }
      // Persisted across restarts — but only while every endpoint it embeds
      // still answers with the shape the screen was built on.
      const stored = screensRef.current?.get(cacheKey, schemaHashes())
      if (stored) {
        session.cacheSet(cacheKey, stored.spec)
        finalizeSpec(withTargetPage(stored.spec, knownRef.current), cacheKey)
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
      goBack,
      handleLogin,
      interruptTurn,
      restoreAt,
      runTurn,
      schemaHashes,
      session,
      sheetBehindIndex,
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
    clearResultToast()
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
  }, [clearEditHighlight, clearResultToast, interruptTurn, runTurn, session, syncNav])

  /**
   * Re-render the CURRENT page from scratch: one INITIAL-style turn for this
   * page (fresh data via call_api) while the stack, caches and every other
   * page stay untouched — a refresh, not a reset (see rebuildApp).
   */
  const refreshPage = useCallback((): void => {
    const spec = currentSpecRef.current
    if (!spec) return
    const target = spec.page
    const auth = domino.auth.required ? ` Logged in: ${loggedInRef.current ? 'yes' : 'no'}.` : ''
    void runTurn(
      `INITIAL SCREEN.${auth} Show the "${target}" page following the screen patterns.`,
      `init::${target}::auth:${loggedInRef.current}`
    )
  }, [domino, runTurn])

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
  // Full-screen sheet: a short form pages over the moment it was opened from.
  // Both derives read the stack fresh — every push/jump already re-renders.
  const behindIdx = sheetBehindIndex()
  const behindPage =
    behindIdx >= 0 && knownRef.current
      ? (findPage(knownRef.current, session.entries()[behindIdx].pageId) ?? null)
      : null
  const behindSpec =
    behindPage && knownRef.current ? { ...knownRef.current, page: behindPage.id } : null
  const sheetMode = behindIdx >= 0 && behindSpec !== null
  // The body shows the page BEHIND the sheet; the overlay carries the sheet.
  const bodyPage = sheetMode ? behindPage : shownPage
  const bodySpec = sheetMode ? behindSpec : shown
  // Drawer rows, newest first; "current" comes from the stack itself.
  const historyList = currentSpec ? session.entries().reverse() : []
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

  // The phone handle hugs a wall — which one, and where along it, is the
  // user's choice: drag it up/down (or across to the other wall) and the
  // placement is persisted. A plain tap still opens the menu.
  const [handlePos, setHandlePos] = useState<{ side: 'left' | 'right'; y: number }>({
    side: 'right',
    y: 0.5
  })
  const handlePosRef = useRef(handlePos)
  useEffect(() => {
    let live = true
    void storage.get('domino:handle-pos').then((raw) => {
      if (!live || !raw) return
      try {
        const v = JSON.parse(String(raw)) as { side?: string; y?: unknown }
        if ((v.side === 'left' || v.side === 'right') && typeof v.y === 'number' && Number.isFinite(v.y)) {
          const pos = { side: v.side, y: Math.min(0.94, Math.max(0.06, v.y)) } as const
          handlePosRef.current = pos
          setHandlePos(pos)
        }
      } catch {
        /* corrupted placement — keep the default */
      }
    })
    return () => {
      live = false
    }
  }, [storage])
  // Native listeners only: react-aria's press handling drops pointer moves on
  // its Button mid-drag (mouse path — touch differs), so the drag tracks on
  // window-level capture listeners installed at pointerdown: target
  // independent, starts before React/react-aria see the press, and the release
  // swallow at window-capture kills the event before any root dispatch — a
  // drag can never open the menu, a plain tap flows through untouched.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuOpenRef = useRef(false)
  const dragCloseRef = useRef(false)
  const handleRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    let pointerId = -1
    let startY = 0
    let moved = false
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      try {
        el.releasePointerCapture(pointerId)
      } catch {
        /* capture already released */
      }
      pointerId = -1
    }
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      if (Math.abs(e.clientY - startY) > 6) moved = true
      if (!moved) return
      // First drag movement: close the menu if the trigger already opened it
      // (menus may open on press-start), and block any further open attempts
      // until the next press. Letting events flow keeps react-aria's press
      // bookkeeping balanced — swallowing them left a stuck pressed state
      // that ate the next tap.
      dragCloseRef.current = true
      if (menuOpenRef.current) {
        menuOpenRef.current = false
        setMenuOpen(false)
      }
      // Vertical only: the wall never changes mid-drag (an inward horizontal
      // swipe from the edge is the SYSTEM back gesture — the menu flips walls
      // instead). Bounds keep the whole handle on screen.
      const next = {
        side: handlePosRef.current.side,
        y: Math.min(0.94, Math.max(0.06, e.clientY / window.innerHeight))
      }
      handlePosRef.current = next
      setHandlePos(next)
    }
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      const wasDrag = moved
      cleanup()
      if (!wasDrag) return
      void storage.set('domino:handle-pos', JSON.stringify(handlePosRef.current))
    }
    const onDown = (e: PointerEvent): void => {
      if (pointerId !== -1) return
      dragCloseRef.current = false
      pointerId = e.pointerId
      startY = e.clientY
      moved = false
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* capture unsupported — window listeners still track */
      }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
    }
    // Capture phase at the element: runs before React's root dispatch and
    // before react-aria's press handlers, so tracking always starts first.
    el.addEventListener('pointerdown', onDown, true)
    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attach-once listeners read refs and stable setters only
  }, [])

  const menuAction = (key: React.Key): void => {
    if (key === 'back') goBack()
    else if (key === 'forward') goForward()
    else if (key === 'edit') setEditOpen(true)
    else if (key === 'rebuild') setRebuildOpen(true)
    else if (key === 'refresh') refreshPage()
    else if (key === 'history') setHistoryOpen(true)
    else if (key === 'handle-side') {
      // Cross-wall moves live here: swiping horizontally from the very edge
      // belongs to the system back gesture, so the wall flips via the menu.
      const next = {
        side: handlePosRef.current.side === 'right' ? ('left' as const) : ('right' as const),
        y: handlePosRef.current.y
      }
      handlePosRef.current = next
      setHandlePos(next)
      void storage.set('domino:handle-pos', JSON.stringify(next))
    }
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
          {lastUsage !== null ? (
            <span className="usage-chip" role="status">
              이번 턴 {fmtTokens(lastUsage)} 토큰
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
            label="화면 다시 그리기"
            icon="refresh"
            onPress={refreshPage}
            isDisabled={!currentSpec}
            className="hide-phone"
          />
          <BarButton
            label="화면 히스토리"
            icon="history"
            onPress={() => setHistoryOpen((v) => !v)}
            active={historyOpen}
            className="hide-phone"
          />
          <BarButton
            label="처음부터 다시 만들기"
            icon="sparkles"
            onPress={() => setRebuildOpen(true)}
            isDisabled={!currentSpec}
            className="hide-phone"
          />
          <BarButton label="설정" icon="settings" onPress={onOpenSettings} className="hide-phone" />
          <BarButton label="domino 닫기" icon="close" onPress={onHome} className="hide-phone" />
        </div>
      </header>

      {/* Phones: the menu lives behind a slim handle docked to the right edge;
          the handle IS the trigger — tapping it opens the menu directly, no
          square button in between. */}
      <Dropdown
        isOpen={menuOpen}
        onOpenChange={(open) => {
          // A just-finished drag may try to open (press-end and/or click):
          // decline while the flag stands, until the next press re-arms it.
          const next = open && dragCloseRef.current ? false : open
          menuOpenRef.current = next
          setMenuOpen(next)
        }}
      >
        <Button
          ref={handleRef}
          isIconOnly
          size="sm"
          variant="secondary"
          className="runtime-handle phone-only"
          aria-label="Domino UI 메뉴"
          data-side={handlePos.side}
          style={{ top: `${handlePos.y * 100}%` }}
        >
          {streaming ? <Spinner size="sm" /> : <Icon name="more" size={16} />}
        </Button>
        <Dropdown.Popover placement={handlePos.side === 'left' ? 'bottom start' : 'bottom end'}>
          <Dropdown.Menu
            aria-label="Runtime menu"
            onAction={menuAction}
            disabledKeys={[
              ...(canBack ? [] : ['back']),
              ...(canForward ? [] : ['forward']),
              ...(currentSpec ? [] : ['edit']),
              ...(currentSpec ? [] : ['rebuild']),
              ...(currentSpec ? [] : ['refresh']),
              ...(currentSpec ? [] : ['history'])
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
                <Icon name="sparkles" />
                <Label>처음부터 다시 만들기</Label>
              </Dropdown.Item>
              <Dropdown.Item id="refresh" textValue="화면 다시 그리기">
                <Icon name="refresh" />
                <Label>화면 다시 그리기</Label>
              </Dropdown.Item>
              <Dropdown.Item id="history" textValue="화면 히스토리">
                <Icon name="history" />
                <Label>화면 히스토리</Label>
              </Dropdown.Item>
              <Dropdown.Item
                id="handle-side"
                textValue={handlePos.side === 'right' ? '핸들을 왼쪽으로' : '핸들을 오른쪽으로'}
              >
                <Icon name={handlePos.side === 'right' ? 'arrow-left' : 'arrow-right'} />
                <Label>{handlePos.side === 'right' ? '핸들을 왼쪽으로' : '핸들을 오른쪽으로'}</Label>
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

      {/* Short forms arrive as a full-screen sheet over the page they were
          opened from; closing it (X, Escape, Android back, Cancel) = goBack. */}
      {sheetMode && shown && shownPage ? (
        <Modal.Backdrop
          isOpen
          onOpenChange={(open) => {
            if (!open) goBack()
          }}
        >
          <Modal.Container size="full" placement="center" scroll="inside">
            <Modal.Dialog aria-label={shownPage.name}>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>{shownPage.name}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
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
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}

      <div className="runtime-main">
        {hasNav ? <SideNav items={navItems} activeId={activeNav} onSelect={handleNav} /> : null}
        <main
          className="runtime-body"
          ref={bodyRef}
          onScroll={onBodyScroll}
          data-centered={navItems.length === 0 && !sheetMode ? 'true' : undefined}
        >
          {error ? (
            <div className="runtime-banner">
              <Alert
                variant="danger"
                title="화면을 만들지 못했습니다"
                message={error}
                action={
                  lastTurnRef.current
                    ? {
                        label: '다시 시도',
                        onPress: () => {
                          const last = lastTurnRef.current
                          if (last) void runTurn(last.prompt, last.cacheKey)
                        }
                      }
                    : undefined
                }
                onClose={() => setError(null)}
              />
            </div>
          ) : null}
          {bodyPage && bodySpec ? (
            <CardGrid
              page={bodyPage}
              spec={bodySpec}
              onEvent={handleEvent}
              streaming={sheetMode ? false : Boolean(previewSpec)}
              pending={sheetMode ? undefined : view?.pending}
              hidden={sheetMode ? undefined : view?.hidden}
              chrome={chrome}
              density={domino.ui.density}
              changed={sheetMode ? undefined : changed}
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

      {/* Post-turn result chip: one-tap undo right after an edit lands, or a
          jump-to-page notice when the edit finished while browsing elsewhere. */}
      {resultToast ? (
        <div className="result-toast" role="status" aria-live="polite">
          <span>{resultToast.text}</span>
          {resultToast.kind === 'undo' && resultToast.target !== null ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                if (restoreAt(resultToast.target!, true)) clearResultToast()
              }}
            >
              되돌리기
            </Button>
          ) : resultToast.pageId ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                const cur = currentSpecRef.current
                const known = knownRef.current
                if (cur && known && findPage(known, resultToast.pageId!)) {
                  finalizeSpec({ ...cur, page: resultToast.pageId! }, null)
                }
                clearResultToast()
              }}
            >
              보기
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Right-side screen history: every settled moment; click restores it. */}
      {historyOpen ? <div className="history-scrim" onClick={() => setHistoryOpen(false)} /> : null}
      <aside className={`history-panel${historyOpen ? ' is-open' : ''}`} aria-label="화면 히스토리">
        <div className="history-panel-head">
          <span className="history-panel-title">화면 히스토리</span>
          <span className="history-total">{fmtTokens(usageTotal)} 토큰</span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="히스토리 닫기"
            onPress={() => setHistoryOpen(false)}
          >
            <Icon name="close" size={16} />
          </Button>
        </div>
        <ul className="history-list">
          {historyList.map((e) => (
            <li key={e.index}>
              <button
                type="button"
                className="history-item"
                aria-current={e.current ? 'true' : undefined}
                onClick={() => {
                  if (restoreAt(e.index, true)) setHistoryOpen(false)
                }}
              >
                <span className="history-badge" data-kind={e.kind}>
                  {HISTORY_KIND_LABEL[e.kind]}
                </span>
                <span className="history-label">{e.label}</span>
                <time className="history-time">{new Date(e.at).toTimeString().slice(0, 5)}</time>
              </button>
            </li>
          ))}
        </ul>
        {apiLogRef.current.length > 0 ? (
          <div className="history-api">
            <div className="history-panel-head">
              <span className="history-panel-title">API 호출</span>
              <span className="history-total">{apiLogRef.current.length}건</span>
            </div>
            <ul className="history-list">
              {apiLogRef.current.map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="api-item">
                  <span className="api-badge" data-ok={entry.status < 400 ? 'true' : undefined}>
                    {entry.status}
                  </span>
                  <span className="history-label">{entry.path}</span>
                  <time className="history-time">{entry.ms}ms</time>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  )
}

const HISTORY_KIND_LABEL: Record<HistoryKind, string> = {
  start: '시작',
  action: '액션',
  nav: '이동',
  edit: '수정',
  restore: '복원'
}

/** Compact token counts for chips ("1.2k"). */
const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

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
