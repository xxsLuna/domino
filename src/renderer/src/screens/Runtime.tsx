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
import { executeApi, resolveEndpoint } from '@core/agent/api'
import {
  bookFields,
  hashSchema,
  loadSchemaBook,
  rememberSchema,
  saveSchemaBook,
  type SchemaBook
} from '@core/agent/schema'
import { loadApiSnaps, putApiSnap, saveApiSnaps, type ApiSnaps } from '@core/agent/apiSnaps'
import { mergeKnownPage, pregenTargets } from '@core/agent/pregen'
import { nextSpecChars, renderProgress } from '@core/agent/progress'
import { applyScript, buildScriptContext } from '@core/domino/script'
import type { ActionDecl, DominoFile } from '@core/domino/types'
import {
  loadPageGraph,
  observedDests,
  pageMapLines,
  savePageGraph,
  upsertEdge,
  type GraphEdge
} from '@core/pageGraph'
import { createAdapter, needsApiKey, type ChatMessage, type LLMConfig } from '@core/llm'
import { nextReasoningLevel } from '@core/llm/reasoning'
import { httpFetch, readTextCapped } from '@core/net'
import { hashContext, SessionStore, type HistoryKind } from '@core/session/session'
import { clearToken, extractToken, getToken, loadTokenWarn, setToken } from '@core/session/prefs'
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
  isRefreshFeedsEvent,
  isSignOutEvent,
  isSubscribeFeedEvent,
  isUnsubscribeFeedEvent,
  referencedDataKeys,
  withKnownPages,
  withTargetPage,
  type ActionEvent,
  type NavItem,
  type UiSpec
} from '@core/spec'
import {
  fetchFeed,
  loadFeeds,
  normalizeFeedUrl,
  saveFeeds,
  MAX_FEEDS,
  type FeedEntry
} from '@core/feeds/store'
import { resolvePageId } from '@core/pageLinks'
import { getCachedText } from '@core/session/registry'
import { isModalPresentation } from '@core/ui/presentation'
import { loadDominoText, type LoadedDomino } from '../loadDomino'
import { useBackHandler } from '../backStack'
import { getStorage } from '../platform'
import { PageGraphDialog } from './PageGraphDialog'
import { activeLang, LANG_ENGLISH, LANG_NATIVE, t, type Lang } from '../i18n'
import { detectSpecLanguage } from '@core/specLang'

interface RuntimeProps {
  loaded: LoadedDomino
  config: LLMConfig
  onHome: () => void
  onOpenSettings: () => void
}

/** How a turn ended: applied to a screen, failed, or taken over by a newer turn. */
type TurnOutcome = 'applied' | 'failed' | 'superseded'

/** Items one `@subscriptions` snapshot may carry — 20 feeds × 50 items is plenty. */
const MAX_FEED_ITEMS = 200

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
  /** The edit request text — stamped onto the history entry its turn pushes. */
  const pendingEditNoteRef = useRef<string | undefined>(undefined)
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
  /** Persisted endpoint → last body: what {"$data": "api:…"} bindings resolve against. */
  const apiSnapsRef = useRef<ApiSnaps>({})
  /** User-subscribed feeds (RSS/Atom) — the runtime owns this list, not the model. */
  const feedsRef = useRef<FeedEntry[]>([])
  /** Persistent screen cache — specs from earlier sessions, with their API deps. */
  const screensRef = useRef<ScreenStore | null>(null)
  /** Endpoints whose responses the current turn's final spec is built from. */
  const turnDepsRef = useRef<ScreenDeps>({})
  const schemaTimer = useRef<number | null>(null)
  const snapTimer = useRef<number | null>(null)
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
  /**
   * [data] live sources: latest snapshot per key. The runtime refreshes these
   * itself (bound [actions], `every Ns` polls); CardGrid substitutes them into
   * {"$data": key.path} props, so a refresh re-renders without a model turn.
   */
  const dataSnapRef = useRef<Record<string, unknown>>({})
  const [dataSnap, setDataSnap] = useState<Record<string, unknown>>({})
  /** When each source was last fetched — turns re-pull anything stale. */
  const dataAtRef = useRef<Record<string, number>>({})
  /** Page-graph edges observed so far (page ←action→ page), persisted per domino. */
  const graphEdgesRef = useRef<GraphEdge[]>([])
  const [graphTick, setGraphTick] = useState(0)
  /** The action a running turn answers — finalizeSpec turns it into an edge. */
  const pendingActionRef = useRef<{ from: string; action: string; label: string } | null>(null)

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
  // Developer submenu (phone menu) + the mermaid page-graph dialog it opens.
  const [devMenuOpen, setDevMenuOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  // Live "change this screen" composer — the app-bar field and the phone modal
  // share the draft; submitting queues the request and drains it sequentially.
  const [editText, setEditText] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  /** "Rebuild from scratch" confirmation — carries the token-consumption warning. */
  const [rebuildOpen, setRebuildOpen] = useState(false)
  /** Export chooser: definition only, or definition + built pages ([screens]). */
  const [exportOpen, setExportOpen] = useState(false)
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

  // Same debounce for the bindable endpoint snapshots.
  const scheduleSnapSave = useCallback(() => {
    if (snapTimer.current !== null) window.clearTimeout(snapTimer.current)
    snapTimer.current = window.setTimeout(() => {
      snapTimer.current = null
      void saveApiSnaps(storage, domino.id, apiSnapsRef.current)
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
      if (snapTimer.current !== null) {
        window.clearTimeout(snapTimer.current)
        snapTimer.current = null
        void saveApiSnaps(storage, domino.id, apiSnapsRef.current)
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
      // First settled screen of this open: does the domino speak the UI language?
      if (!langOfferAskedRef.current) {
        langOfferAskedRef.current = true
        const ui = activeLang()
        const pageLang = detectSpecLanguage(applied)
        if (pageLang && pageLang !== ui) setLangOffer({ from: pageLang, to: ui })
      }
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
        setError(`${message}\n${t('rt.staleFallback')}`)
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
  const armResultToast = useCallback((toast: NonNullable<typeof resultToast>, ms: number): void => {
    if (resultToastTimer.current !== null) window.clearTimeout(resultToastTimer.current)
    setResultToast(toast)
    resultToastTimer.current = window.setTimeout(() => {
      resultToastTimer.current = null
      setResultToast(null)
    }, ms)
  }, [])
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
  /** Session budget guard: threshold from settings; the banner shows once. */
  const tokenWarnRef = useRef(0)
  const [tokenWarned, setTokenWarned] = useState(false)
  /**
   * One-shot language offer: the first settled screen of an open is checked
   * against the UI language; a mismatched domino offers a text-only
   * re-translation exactly once per open. The action runs through a ref
   * because the edit queue's submit lives further down the component.
   */
  const langOfferAskedRef = useRef(false)
  const [langOffer, setLangOffer] = useState<{ from: Lang; to: Lang } | null>(null)
  const langTranslateRef = useRef<((to: Lang) => void) | null>(null)
  const lastUsageInTurn = useRef(0)
  const usageChipTimer = useRef<number | null>(null)
  /** Recent call_api results (newest first) — the drawer's API section. */
  const apiLogRef = useRef<Array<{ at: number; path: string; status: number; ms: number }>>([])

  /** Remember page ←action→ page (deduped); persisted so the graph survives restarts. */
  const recordGraphEdge = useCallback(
    (edge: GraphEdge): void => {
      graphEdgesRef.current = upsertEdge(graphEdgesRef.current, edge)
      setGraphTick((t) => t + 1)
      void savePageGraph(storage, domino.id, graphEdgesRef.current)
    },
    [domino.id, storage]
  )

  /** The graph's human label for an action: its button text / form title. */
  const actionLabel = useCallback(
    (spec: UiSpec | null, nodeId: string, fallback: string): string => {
      if (!spec) return fallback
      const node = findNode(spec, nodeId)
      const text = node?.props?.text ?? node?.props?.title
      return typeof text === 'string' && text.trim() ? text : fallback
    },
    []
  )

  /**
   * The app map for the model's prompt: pages that exist, connected actions,
   * unconnected buttons — the mermaid view's model in cheap text lines.
   */
  const appMapLines = useCallback((): string[] | undefined => {
    const known = knownRef.current
    if (!known || known.pages.length === 0) return undefined
    return pageMapLines(known, navRef.current, domino, graphEdgesRef.current)
  }, [domino])

  const finalizeSpec = useCallback(
    (spec: UiSpec, cacheKey: string | null, kindHint?: HistoryKind) => {
      // The action this screen answers (a tap that ran/generated) becomes a
      // page-graph edge: from the page it was pressed on to the page shown.
      const pending = pendingActionRef.current
      if (pending) {
        pendingActionRef.current = null
        recordGraphEdge({ ...pending, to: spec.page, kind: 'action' })
      }
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
      // An edit's history row carries the request itself — what changed, at a glance.
      const note =
        kind === 'edit' && pendingEditNoteRef.current
          ? pendingEditNoteRef.current.split('\n')[0].slice(0, 120)
          : undefined
      session.push(spec, { kind, ...(note ? { note } : {}) })
      // Post-edit: offer a one-tap undo back to the moment BEFORE this edit.
      // Any other new moment retires the offer — its baseline has moved on.
      if (kind === 'edit') {
        const undoTo = session.historySize - 2
        if (undoTo >= 0) {
          armResultToast({ kind: 'undo', text: t('rt.toastEdited'), target: undoTo }, 8_000)
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
    [
      armResultToast,
      clearEditHighlight,
      recordGraphEdge,
      schedulePreGen,
      session,
      showSpec,
      syncNav
    ]
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
   * `{stateKey}` interpolations of a [data] path resolve against the live
   * screen state. Any key missing or empty → null: the source isn't ready
   * (no RSS URL typed yet) and fetching would ask the backend for nothing.
   * FEED paths interpolate RAW (a whole URL may be substituted); every other
   * method percent-encodes the value for safe query use.
   */
  const interpolateDataPath = useCallback((path: string, raw = false): string | null => {
    let ready = true
    const filled = path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
      const v = stateRef.current[key]
      if (v === undefined || v === null || String(v).trim() === '') {
        ready = false
        return ''
      }
      return raw ? String(v) : encodeURIComponent(String(v))
    })
    return ready ? filled : null
  }, [])

  /** Store one source's snapshot and stamp its fetch time (ref-first: async-safe). */
  const commitSourceSnapshot = useCallback((key: string, value: unknown): void => {
    dataSnapRef.current = { ...dataSnapRef.current, [key]: value }
    dataAtRef.current = { ...dataAtRef.current, [key]: Date.now() }
    setDataSnap(dataSnapRef.current)
  }, [])

  /**
   * A call_api response becomes a bindable snapshot: screens carry
   * {"$data": "api:<endpoint>.…"} and re-resolve against the latest body —
   * live this turn, and after a restart from the persisted copy. Only a
   * successful object body qualifies; error shapes would fake bindings.
   */
  const rememberApiSnapshot = useCallback(
    (endpoint: string, result: { status: number; data: unknown }): void => {
      if (result.status < 200 || result.status >= 300) return
      if (result.data === null || typeof result.data !== 'object') return
      apiSnapsRef.current = putApiSnap(apiSnapsRef.current, endpoint, result.data)
      commitSourceSnapshot(`api:${endpoint}`, apiSnapsRef.current[endpoint])
      scheduleSnapSave()
    },
    [commitSourceSnapshot, scheduleSnapSave]
  )

  /**
   * Fetch one [data] source, store the snapshot (a bound screen re-renders
   * from it) and log the fetch to the API inspector — runtime-owned refreshes
   * are visible too. API methods ride the allowlist/origin gates; FEED sources
   * are fetched and parsed client-side (no [api] involved), and the special
   * `FEED @subscriptions` fans out over the user's subscription list.
   */
  const fetchSource = useCallback(
    async (key: string): Promise<void> => {
      const decl = domino.data.find((d) => d.key === key)
      if (!decl) return
      if (decl.method === 'FEED') {
        if (decl.path === '@subscriptions') {
          const results = await Promise.all(
            feedsRef.current.map((f) => fetchFeed(f.url, f.title))
          )
          for (const r of results) {
            apiLogRef.current.unshift({
              at: Date.now(),
              path: `FEED ${r.entry.url}`,
              status: r.status,
              ms: r.ms
            })
          }
          if (apiLogRef.current.length > 50) apiLogRef.current.length = 50
          commitSourceSnapshot(key, {
            feeds: results.map((r) => ({
              url: r.entry.url,
              title: r.entry.title,
              ...(r.error ? { error: r.error } : {})
            })),
            items: results
              .flatMap((r) => (r.data?.items ?? []).map((i) => ({ ...i, feed: r.entry.title })))
              .slice(0, MAX_FEED_ITEMS)
          })
          return
        }
        const url = interpolateDataPath(decl.path, true)
        if (!url) return // not ready: the URL state input is still empty
        const norm = normalizeFeedUrl(url)
        if (!norm) {
          commitSourceSnapshot(key, { error: 'feed URL must be https (plain http only on localhost)' })
          return
        }
        const result = await fetchFeed(norm)
        apiLogRef.current.unshift({
          at: Date.now(),
          path: `FEED ${norm}`,
          status: result.status,
          ms: result.ms
        })
        if (apiLogRef.current.length > 50) apiLogRef.current.pop()
        commitSourceSnapshot(key, result.data ?? { error: result.error ?? `HTTP ${result.status}` })
        return
      }
      const path = interpolateDataPath(decl.path)
      if (!path) return // not ready: an input the source depends on is still empty
      const result = await executeApi(apiRuntime(), { path, method: decl.method })
      apiLogRef.current.unshift({
        at: Date.now(),
        path: `${decl.method} ${path}`,
        status: result.status,
        ms: result.ms ?? 0
      })
      if (apiLogRef.current.length > 50) apiLogRef.current.pop()
      const value =
        result.status > 0 && result.status < 400
          ? result.data
          : { error: result.status === 0 ? 'unreachable' : `HTTP ${result.status}` }
      commitSourceSnapshot(key, value)
    },
    [apiRuntime, commitSourceSnapshot, domino.data, interpolateDataPath]
  )

  /**
   * The subscription list changed — refetch every `FEED @subscriptions`
   * source so bound screens update on their own (no model turn).
   */
  const refreshSubscriptions = useCallback((): void => {
    for (const d of domino.data) {
      if (d.method === 'FEED' && d.path === '@subscriptions') void fetchSource(d.key)
    }
  }, [domino.data, fetchSource])

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
        {
          kind: 'notice',
          text: t('rt.editDone', { page: findPage(spec, pageId)?.name ?? pageId }),
          target: null,
          pageId
        },
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
              .map(
                (e) =>
                  `${e.index}) [${e.kind}] ${e.label} ${new Date(e.at).toTimeString().slice(0, 5)}`
              )
              .join(' | ')
          : ''
      pendingStateWrites.current = {}
      setStreaming(true)
      setError(null)
      setStatus(t('rt.generating'))
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
        // [data] sources arrive in the prompt as snapshots the model BINDS
        // ({"$data": key.path}) — pull anything not-yet-fetched or stale so
        // the design is made against real values, not a missing snapshot.
        for (const decl of domino.data) {
          const at = dataAtRef.current[decl.key] ?? 0
          if (Date.now() - at > 5_000) await fetchSource(decl.key)
        }
        // One snapshot per turn: the engine diffs responses against it, the
        // prompt describes screens built from it.
        const knownSchemas = bookFields(schemaBookRef.current)
        const system = buildSystemPrompt(domino, {
          loggedIn: loggedInRef.current,
          knownSchemas,
          dataSnapshots: dataSnapRef.current,
          pageMap: appMapLines(),
          feeds: feedsRef.current
        })
        fork.push({ role: 'user', content: prompt + liveState + historyLine })
        for await (const update of runAgentTurn({
          adapter,
          system,
          history: fork,
          api: apiRuntime(),
          knownSchemas,
          // A failed/absent render is the one round worth spending depth on.
          escalateReasoning: () =>
            createAdapter({ ...config, reasoning: nextReasoningLevel(config.reasoning) })
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
              // The result also feeds {"$data": "api:…"} bindings in screens.
              rememberApiSnapshot(update.endpoint, update.result)
              break
            case 'progress':
              progressChars.current = update.chars
              break
            case 'usage': {
              const t =
                update.usage.total ?? (update.usage.prompt ?? 0) + (update.usage.completion ?? 0)
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
      appMapLines,
      armEditFade,
      cancelGauge,
      clearEditHighlight,
      config,
      domino,
      failTurn,
      fetchSource,
      finalizeSpec,
      landEdit,
      rememberApiSnapshot,
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
        knownSchemas,
        dataSnapshots: dataSnapRef.current,
        pageMap: appMapLines(),
        feeds: feedsRef.current
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
          // Previews change nothing on screen; api results still seed the
          // {"$data": "api:…"} snapshots the built page's bindings resolve
          // against the moment it is shown.
          if (update.type === 'api_result') {
            rememberApiSnapshot(update.endpoint, update.result)
          }
        }
      } catch {
        return null // a failed background build just becomes a live-generating tap
      }
      return null
    },
    [apiRuntime, appMapLines, config, domino, rememberApiSnapshot]
  )

  const maybeRunPreGen = useCallback(
    async (seq: number): Promise<void> => {
      if (pregenSeq.current !== seq || needsApiKey(config)) return
      const base = knownRef.current
      if (!base) return
      let builtCount = 0
      const observed = observedDests(graphEdgesRef.current)
      for (const pageId of pregenTargets(domino, base, loggedInRef.current, observed)) {
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
        builtCount++
      }
      // The view snapshot now carries the background pages too — reopening keeps them.
      const known = knownRef.current
      if (pregenSeq.current === seq && known) {
        void screensRef.current?.saveView(loggedInRef.current, { page: known.page, known })
        // Idle continuation: a run that made progress arms the next batch until
        // every target is warm; an all-failures run just re-arms on the next turn.
        pregenScheduled.current = false
        if (
          builtCount > 0 &&
          pregenTargets(
            domino,
            known,
            loggedInRef.current,
            // Fresh read: a press during the batch may have observed a new page.
            observedDests(graphEdgesRef.current)
          ).length > 0
        ) {
          schedulePreGen()
        }
      }
    },
    [config, domino, pregenOne, schedulePreGen]
  )
  pregenRunnerRef.current = maybeRunPreGen

  /* ------------------------------ boot flow ------------------------------ */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const token = await getToken(storage, domino.id)
      sessionTokenRef.current = token
      loggedInRef.current = Boolean(token)

      tokenWarnRef.current = await loadTokenWarn(storage)
      schemaBookRef.current = await loadSchemaBook(storage, domino.id)
      // Persisted endpoint bodies: a restored screen's {"$data": "api:…"}
      // bindings resolve against these before any new call happens.
      apiSnapsRef.current = await loadApiSnaps(storage, domino.id)
      dataSnapRef.current = { ...apiSnapsRef.current, ...dataSnapRef.current }
      graphEdgesRef.current = await loadPageGraph(storage, domino.id)
      feedsRef.current = await loadFeeds(storage, domino.id)
      const screens = await ScreenStore.open(storage, domino.id)
      screensRef.current = screens
      if (cancelled) return
      setDataSnap(dataSnapRef.current)
      // Ready [data] sources fetch once up front: the very first design turn
      // (and any pregen build) sees real values to bind.
      await Promise.all(domino.data.map((d) => fetchSource(d.key)))
      // The stack rides along too: reopening lands on the very moment the
      // user left, not a one-entry stand-in.
      session.attach(storage, `domino:history:${domino.id}`)

      // Reopen lands exactly where the app was left — restored, not re-generated.
      const view = await screens.loadView(loggedInRef.current)
      if (cancelled) return
      if (view && findPage(view.known, view.page)) {
        // Live screen state rides in the snapshot: hydrate it BEFORE any
        // [data] fetch so `{stateKey}` interpolations (e.g. {rssUrl}) resolve
        // on this very session — without this the sources would stay unready
        // forever and a restored feed rendered empty.
        stateRef.current = { ...(view.known.state ?? {}) }
        pendingStateWrites.current = {}
        await Promise.all(domino.data.map((d) => fetchSource(d.key)))
        if (cancelled) return
        const restoredHistory = await session.load()
        if (cancelled) return
        if (restoredHistory && session.historySize > 0) {
          // The restored stack already holds this moment — show it without
          // pushing a duplicate entry in front of it.
          showSpec({ ...view.known, page: view.page })
          syncNav()
          schedulePreGen()
        } else {
          finalizeSpec({ ...view.known, page: view.page }, null)
        }
        return
      }

      // First open on this device of an export "with the app": the embedded
      // [screens] restore the whole thing — zero LLM calls, no BYOK needed
      // (a key only matters once the user edits or generates more). A local
      // view — this user's own progress — always wins over the embed.
      if (domino.screens && findPage(domino.screens.spec, domino.screens.spec.page)) {
        const embedded = domino.screens.spec
        stateRef.current = { ...(embedded.state ?? {}) }
        pendingStateWrites.current = {}
        // The exported action graph seeds the map, so linked buttons
        // auto-navigate on day one and the model sees the connections.
        if (domino.screens.graph && domino.screens.graph.length > 0) {
          graphEdgesRef.current = domino.screens.graph as GraphEdge[]
          setGraphTick((t) => t + 1)
          void savePageGraph(storage, domino.id, graphEdgesRef.current)
        }
        await Promise.all(domino.data.map((d) => fetchSource(d.key)))
        if (cancelled) return
        finalizeSpec(embedded, null)
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

  /* --------------------------- [data] auto-refresh -------------------------- */
  // Sources declared `every Ns` poll while any known page binds them — the
  // live feel: fresh values appear on screen without touching the model.
  const polledKeys = useMemo(() => {
    if (!currentSpec) return ''
    const used = referencedDataKeys(currentSpec)
    return domino.data
      .filter((d) => d.everySec && used.has(d.key))
      .map((d) => d.key)
      .join(',')
  }, [currentSpec, domino.data])
  useEffect(() => {
    if (!polledKeys) return
    const keys = new Set(polledKeys.split(','))
    const decls = domino.data.filter((d) => d.everySec && keys.has(d.key))
    if (decls.length === 0) return
    const intervalMs = Math.min(...decls.map((d) => d.everySec!)) * 1000
    const iv = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      for (const d of decls) void fetchSource(d.key)
    }, intervalMs)
    return () => window.clearInterval(iv)
  }, [polledKeys, domino.data, fetchSource])

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
  }, [
    canonicalView,
    clearEditHighlight,
    interruptTurn,
    session,
    sheetBehindIndex,
    showSpec,
    syncNav
  ])

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
      } else if (e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
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
      setStatus(t('rt.loginBusy'))
      setError(null)
      try {
        const loginUrl = resolveEndpoint(domino.auth.loginEndpoint!, domino.api.baseUrl)
        if (!loginUrl) {
          throw new Error(t('rt.loginBadEndpoint'))
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
        setError(t('rt.loginFail', { msg: (err as Error).message }))
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

  /**
   * The ACTION → agent tail shared by every non-local event: record which
   * action asked (its landing page becomes a graph edge), push the ACTION
   * message, then cache → stored screen → one turn — guided by the observed
   * edge when it names a destination that is no longer built.
   */
  const dispatchToAgent = useCallback(
    (e: ActionEvent, pageId: string): void => {
      const known = knownRef.current
      const cs = currentSpecRef.current
      // A plain button that already led somewhere (observed edge), with its
      // page still built, links straight to it — no model turn. Data-carrying
      // clicks (row selects, links) keep the normal flow: their target
      // depends on the data, not just the button.
      const plainClick = e.event === 'click' && (!e.data || Object.keys(e.data).length === 0)
      if (plainClick) {
        const edge = graphEdgesRef.current.find(
          (x) => x.from === pageId && x.action === e.nodeId && x.kind === 'action' && x.to !== ''
        )
        if (edge && known && cs && findPage(known, edge.to)) {
          interruptTurn()
          finalizeSpec({ ...cs, page: edge.to }, null)
          return
        }
      }
      pendingActionRef.current = {
        from: pageId,
        action: e.nodeId,
        label: actionLabel(currentSpecRef.current, e.nodeId, e.nodeId)
      }
      historyRef.current.push({
        role: 'user',
        content: `ACTION ${e.event} from ${e.nodeName}/${e.nodeId}${
          e.data ? ` data ${JSON.stringify(redact(e.data))}` : ''
        } (page "${pageId}")`
      })
      // Trim conversation so long sessions don't blow the context window.
      if (historyRef.current.length > 60) historyRef.current.splice(0, 20)

      // Page-free key: the same control (id + event + data) is the same action
      // wherever it sits, so every page's copy shares one cache slot — the
      // prompt's "one action, one id" contract, enforced here.
      const cacheKey = hashContext({ id: e.nodeId, ev: e.event, d: e.data })
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

      // The graph saw this plain press land on a page that isn't built right
      // now (the auto-link above would have taken it): name that destination
      // instead of letting the turn invent one.
      const guidedTo = plainClick
        ? (graphEdgesRef.current.find(
            (x) => x.from === pageId && x.action === e.nodeId && x.kind === 'action' && x.to !== ''
          )?.to ?? null)
        : null
      void runTurn(
        guidedTo
          ? `The user acted on the current screen (see ACTION above). This action has led to page "${guidedTo}" before — render that page again with fresh data (call_api first when it shows live records).`
          : `The user acted on the current screen (see ACTION above). Compute and render the next screen.`,
        cacheKey
      )
    },
    [actionLabel, finalizeSpec, interruptTurn, runTurn, schemaHashes, session]
  )

  /**
   * [actions]-bound widgets run entirely in the runtime — set state, refresh
   * [data] sources, switch to a built page — with no model turn. A goto for a
   * page not built yet falls through to the agent (which designs it against
   * the just-refreshed snapshot), so a bound button can never dead-end.
   */
  const runBoundAction = useCallback(
    async (decl: ActionDecl, e: ActionEvent, pageId: string): Promise<void> => {
      const label = actionLabel(currentSpecRef.current, e.nodeId, e.nodeId)
      let needsTurn = false
      for (const step of decl.steps) {
        if (step.kind === 'set') {
          const raw = e.data?.[step.formField]
          const value = Array.isArray(raw)
            ? raw.join(', ')
            : raw === undefined
              ? undefined
              : String(raw)
          if (value !== undefined && value.trim() !== '') applyLocalState(step.stateKey, value)
        } else if (step.kind === 'refresh') {
          await fetchSource(step.source)
        } else {
          const known = knownRef.current
          const resolved = known ? resolvePageId(navRef.current, known.pages, step.page) : null
          const cs = currentSpecRef.current
          if (resolved && cs) {
            recordGraphEdge({ from: pageId, to: resolved, action: e.nodeId, label, kind: 'action' })
            interruptTurn()
            finalizeSpec({ ...cs, page: resolved }, null)
            return
          }
          needsTurn = true
        }
      }
      if (!needsTurn) {
        // refresh/set only: the page stays; its bound props just got new data.
        recordGraphEdge({ from: pageId, to: pageId, action: e.nodeId, label, kind: 'data' })
        return
      }
      dispatchToAgent(e, pageId)
    },
    [
      actionLabel,
      applyLocalState,
      dispatchToAgent,
      fetchSource,
      finalizeSpec,
      interruptTurn,
      recordGraphEdge
    ]
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

      // Feed conventions: the runtime owns the subscription list (validation,
      // storage, fetching); the model only renders around it.
      if (isSubscribeFeedEvent(e)) {
        const raw = String(e.data?.url ?? '')
        const url = normalizeFeedUrl(raw)
        void (async () => {
          if (!url) {
            armResultToast(
              {
                kind: 'notice',
                text: `피드 주소가 올바르지 않습니다 (https 필요, localhost는 http 허용): ${raw.slice(0, 80)}`,
                target: null
              },
              5_000
            )
            return
          }
          if (feedsRef.current.some((f) => f.url === url)) {
            armResultToast({ kind: 'notice', text: '이미 구독 중인 피드입니다', target: null }, 4_000)
            return
          }
          if (feedsRef.current.length >= MAX_FEEDS) {
            armResultToast(
              { kind: 'notice', text: `구독은 최대 ${MAX_FEEDS}개까지 가능합니다`, target: null },
              4_000
            )
            return
          }
          // First fetch before the turn: the model needs the feed's title and
          // items to draw the updated screen in one go. A dead feed is still a
          // valid subscription — the screen shows its error state.
          const result = await fetchFeed(url)
          feedsRef.current = [...feedsRef.current, result.entry]
          void saveFeeds(storage, domino.id, feedsRef.current)
          refreshSubscriptions()
          const items = result.data?.items ?? []
          // Same synthetic-history pattern as login/sign-out: the model sees
          // what happened even though no default ACTION line was pushed.
          historyRef.current.push({
            role: 'user',
            content: `ACTION submit from ${e.nodeName}/${e.nodeId} → SUBSCRIBED ${url}${
              result.error
                ? ` (first fetch failed: ${result.error})`
                : ` — "${result.entry.title}", ${items.length} items`
            }`
          })
          await runTurn(
            `The user subscribed to a new feed: ${url} — ${
              result.error
                ? `the first fetch failed: ${result.error}.`
                : `"${result.entry.title}" with ${items.length} items: ${JSON.stringify(items.slice(0, 10))}.`
            } Update the current screen to show the new subscription.`,
            `feed-sub::${hashContext(url)}`
          )
        })()
        return
      }
      if (isUnsubscribeFeedEvent(e)) {
        const node = currentSpec ? findNode(currentSpec, e.nodeId) : null
        const raw = String(node?.props?.url ?? e.data?.url ?? '')
        const url = normalizeFeedUrl(raw)
        if (url && feedsRef.current.some((f) => f.url === url)) {
          feedsRef.current = feedsRef.current.filter((f) => f.url !== url)
          void saveFeeds(storage, domino.id, feedsRef.current)
          refreshSubscriptions()
          historyRef.current.push({
            role: 'user',
            content: `ACTION click from ${e.nodeName}/${e.nodeId} → UNSUBSCRIBED ${url}`
          })
          void runTurn(
            `The user unsubscribed from ${url}. Update the current screen to remove it.`,
            `feed-unsub::${hashContext(url)}`
          )
        }
        return
      }
      if (isRefreshFeedsEvent(e)) {
        // Instant and token-free: the @subscriptions snapshot refetches and
        // every bound screen updates on its own — no model turn.
        refreshSubscriptions()
        return
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

      // [actions]-bound widgets: the runtime owns their steps (set / refresh /
      // goto) — pressing one never starts a model turn by itself.
      const bound = domino.actions.find((a) => a.id === e.nodeId)
      if (bound) {
        void runBoundAction(bound, e, pageId)
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
        recordGraphEdge({
          from: pageId,
          to: resolved,
          action: e.nodeId,
          label: actionLabel(currentSpec, e.nodeId, target ?? e.nodeId),
          kind: e.event === 'navigate' ? 'nav' : 'action'
        })
        interruptTurn()
        finalizeSpec({ ...currentSpec, page: resolved }, null)
        return
      }
      if (target && navRef.current.some((i) => i.id === target)) setActiveNav(target)

      dispatchToAgent(e, pageId)
    },
    [
      actionLabel,
      applyLocalState,
      armResultToast,
      clearEditHighlight,
      currentSpec,
      dispatchToAgent,
      domino,
      finalizeSpec,
      goBack,
      handleLogin,
      interruptTurn,
      recordGraphEdge,
      refreshSubscriptions,
      restoreAt,
      runBoundAction,
      runTurn,
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
      pendingEditNoteRef.current = item.text
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
    void processEdit(head)
      .then(
        (outcome) => {
          // Superseded: keep the head — this edit re-runs on the next drain.
          if (outcome !== 'superseded') advance()
        },
        // An unexpected throw is a failed edit: advance rather than loop on it.
        advance
      )
      .finally(() => {
        editDraining.current = false
        setEditCount(editQueueRef.current.length)
        if (editQueueRef.current.length > 0) drainEditQueue()
      })
  }, [processEdit])
  editDrainRef.current = drainEditQueue

  /**
   * "Change language" on the one-shot banner: a TEXT-ONLY app-wide edit —
   * every screen keeps its ids, layout and bindings; only the written words
   * move to the UI language. Rides the queued edit lane so it survives
   * navigation and lands page by page wherever the user browses.
   */
  langTranslateRef.current = (to: Lang): void => {
    submitEdit(
      `Translate all user-visible text in EVERY page of this app into ${LANG_ENGLISH[to]}. ` +
        `Change ONLY the text strings (titles, descriptions, labels, button texts, placeholders, option labels, nav labels, empty-state and alert copy). ` +
        `Do NOT change any id, layout, grid, component, icon, number, URL, code, or {"$data"}/{"$state"} binding — everything except the language of the text must stay exactly as it is. ` +
        `Re-render every page with the translated text.`
    )
  }

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
   * Download a .domino text (the export chooser's both variants land here).
   */
  const downloadDomino = useCallback(
    (text: string, suffix = ''): void => {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${loaded.name || 'app'}${suffix}.domino`
      a.click()
    },
    [loaded.name]
  )

  /**
   * Copy a shareable inline link (domino://<name>?c=<payload>): the receiver
   * pastes it into the URL box — or a native shell opens it as a deep link —
   * and the whole definition runs with no upload step.
   */
  const shareLink = useCallback((): void => {
    void (async () => {
      try {
        const text =
          (await getCachedText(storage, loaded.source)) ?? (await loadDominoText(loaded.source))
        const link = `domino://${encodeURIComponent(loaded.name || 'app')}?c=${encodeURIComponent(text)}`
        await navigator.clipboard.writeText(link)
        armResultToast({ kind: 'notice', text: t('rt.shareDone'), target: null }, 5_000)
      } catch (err) {
        setError(t('rt.shareFail', { msg: (err as Error).message }))
      }
    })()
  }, [loaded, storage])

  /**
   * Export: the definition alone, or the definition WITH the built app
   * embedded in a [screens] section — pages, live state and the observed
   * action graph travel inside the file, so anyone opening it runs the app
   * as-is with zero LLM calls (a key is only needed to change it).
   */
  const runExport = useCallback(
    (withScreens: boolean): void => {
      setExportOpen(false)
      void (async () => {
        try {
          const text =
            (await getCachedText(storage, loaded.source)) ?? (await loadDominoText(loaded.source))
          if (!withScreens) {
            downloadDomino(text)
            return
          }
          const known = knownRef.current
          if (!known) return
          // A previous embed is replaced wholesale: the file always ships
          // the screens as they stand right now.
          const stripped = text.replace(/\[screens\][\s\S]*$/m, '').trimEnd()
          const embed = [
            '',
            '[screens]',
            `; 완성된 앱 포함 내보내기 — 페이지 ${known.pages.length}개와 액션 연결이 함께 저장됩니다.`,
            '; 이 파일을 여는 누구나 LLM 없이 그대로 앱을 실행할 수 있습니다.',
            `spec = ${JSON.stringify(known)}`,
            ...(graphEdgesRef.current.length > 0
              ? [`graph = ${JSON.stringify(graphEdgesRef.current)}`]
              : [])
          ].join('\n')
          downloadDomino(`${stripped}\n${embed}\n`, '-app')
        } catch {
          setError(t('rt.exportFail'))
        }
      })()
    },
    [downloadDomino, loaded, storage]
  )

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

  // Budget guard: once per session, when cumulative tokens cross the
  // configured threshold, surface a dismissible warning — BYOK is real money.
  useEffect(() => {
    const limit = tokenWarnRef.current
    if (!tokenWarned && limit > 0 && usageTotal >= limit) setTokenWarned(true)
  }, [usageTotal, tokenWarned])

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
        if (
          (v.side === 'left' || v.side === 'right') &&
          typeof v.y === 'number' &&
          Number.isFinite(v.y)
        ) {
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

  /* ------------------------- command palette (⌘K) ------------------------- */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteSel, setPaletteSel] = useState(0)
  useEffect(() => {
    if (!paletteOpen) {
      setPaletteQuery('')
      setPaletteSel(0)
    }
  }, [paletteOpen])

  interface PaletteItem {
    key: string
    label: string
    icon?: string
    hint?: string
    run: () => void
  }
  const paletteItems: PaletteItem[] = [
    ...(currentSpec
      ? [
          { key: 'edit', label: t('rt.editTitle'), icon: 'edit', run: () => setEditOpen(true) },
          { key: 'refresh', label: t('rt.regen'), icon: 'refresh', run: refreshPage },
          {
            key: 'rebuild',
            label: t('rt.rebuild'),
            icon: 'sparkles',
            run: () => setRebuildOpen(true)
          }
        ]
      : []),
    { key: 'back', label: t('rt.back'), icon: 'back', run: goBack },
    { key: 'forward', label: t('rt.forward'), icon: 'arrow-right', run: goForward },
    { key: 'export', label: t('rt.export'), icon: 'download', run: () => setExportOpen(true) },
    { key: 'share', label: t('rt.share'), icon: 'link', run: () => shareLink() },
    { key: 'history', label: t('rt.history'), icon: 'history', run: () => setHistoryOpen(true) },
    {
      key: 'inspect',
      label: chrome === 'app' ? t('rt.inspectOn') : t('rt.inspectOff'),
      icon: 'layers',
      run: () => setChrome(chrome === 'app' ? 'inspect' : 'app')
    },
    { key: 'graph', label: t('rt.graph'), icon: 'chart', run: () => setGraphOpen(true) },
    { key: 'settings', label: t('common.settings'), icon: 'settings', run: onOpenSettings },
    { key: 'home', label: t('rt.closeDomino'), icon: 'close', run: onHome },
    ...(currentSpec?.pages ?? [])
      .filter((p) => p.id !== currentSpec?.page)
      .map((p) => ({
        key: `page:${p.id}`,
        label: p.name,
        hint: t('rt.palettePage'),
        run: () => {
          if (!currentSpec) return
          interruptTurn()
          finalizeSpec({ ...currentSpec, page: p.id }, null)
        }
      }))
  ]
  const paletteFiltered = paletteItems.filter((it) =>
    it.label.toLowerCase().includes(paletteQuery.trim().toLowerCase())
  )
  const paletteActive = Math.min(paletteSel, Math.max(0, paletteFiltered.length - 1))
  const runPalette = (item: PaletteItem): void => {
    setPaletteOpen(false)
    item.run()
  }

  const menuAction = (key: React.Key): void => {
    if (key === 'back') goBack()
    else if (key === 'forward') goForward()
    else if (key === 'edit') setEditOpen(true)
    else if (key === 'rebuild') setRebuildOpen(true)
    else if (key === 'refresh') refreshPage()
    else if (key === 'export') setExportOpen(true)
    else if (key === 'share') shareLink()
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
    } else if (key === 'inspect') setChrome(chrome === 'app' ? 'inspect' : 'app')
    else if (key === 'graph') setGraphOpen(true)
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
          aria-label={t('rt.gauge')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          data-done={progress >= 100}
        >
          <div className="render-gauge-fill" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      <header className="app-bar">
        <BarButton label={t('rt.back')} icon="back" onPress={goBack} isDisabled={!canBack} />
        <BarButton
          label={t('rt.forward')}
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
            aria-label={t('rt.editAria')}
            isDisabled={!currentSpec}
            variant="secondary"
          >
            <InputGroup variant="secondary" fullWidth>
              <InputGroup.Prefix>
                <Icon name="edit" className="text-muted" size={14} />
              </InputGroup.Prefix>
              <InputGroup.Input
                placeholder={t('rt.editPlaceholder')}
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
              <span className="status-text hide-phone">{status || t('rt.generating')}</span>
            </span>
          ) : null}
          {lastUsage !== null ? (
            <span className="usage-chip" role="status">
              {t('rt.usageTurn', { n: fmtTokens(lastUsage) })}
            </span>
          ) : null}
          {needsKey ? (
            <Button size="sm" variant="outline" className="text-warning" onPress={onOpenSettings}>
              <Icon name="key" />
              <span className="hide-phone">{t('rt.byok')}</span>
            </Button>
          ) : null}
          <BarButton
            label={chrome === 'app' ? t('rt.inspectOn') : t('rt.inspectOff')}
            icon="layers"
            onPress={() => setChrome(chrome === 'app' ? 'inspect' : 'app')}
            active={chrome === 'inspect'}
            className="hide-phone"
          />
          <BarButton
            label={t('rt.graph')}
            icon="chart"
            onPress={() => setGraphOpen(true)}
            isDisabled={!currentSpec}
            className="hide-phone"
          />
          <BarButton
            label={t('rt.regen')}
            icon="refresh"
            onPress={refreshPage}
            isDisabled={!currentSpec}
            className="hide-phone"
          />
          <BarButton
            label={t('rt.export')}
            icon="download"
            onPress={() => setExportOpen(true)}
            className="hide-phone"
          />
          <BarButton label={t('rt.share')} icon="link" onPress={shareLink} className="hide-phone" />
          <BarButton
            label={t('rt.history')}
            icon="history"
            onPress={() => setHistoryOpen((v) => !v)}
            active={historyOpen}
            className="hide-phone"
          />
          <BarButton
            label={t('rt.rebuild')}
            icon="sparkles"
            onPress={() => setRebuildOpen(true)}
            isDisabled={!currentSpec}
            className="hide-phone"
          />
          <BarButton
            label={t('common.settings')}
            icon="settings"
            onPress={onOpenSettings}
            className="hide-phone"
          />
          <BarButton
            label={t('rt.closeDomino')}
            icon="close"
            onPress={onHome}
            className="hide-phone"
          />
        </div>
      </header>
      {/* Phones: the bar is too narrow for a status line — a floating pill
          under it carries the same live text so a 15s turn never looks dead. */}
      {streaming ? (
        <div className="turn-status phone-only" role="status" aria-live="polite">
          <Spinner size="sm" />
          <span>{status || t('rt.generating')}</span>
        </div>
      ) : null}

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
          if (!next) setDevMenuOpen(false) // the flyout never outlives its menu
        }}
      >
        <Button
          ref={handleRef}
          isIconOnly
          size="sm"
          variant="secondary"
          className="runtime-handle phone-only"
          aria-label={t('rt.menu')}
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
              <Dropdown.Item id="back" textValue={t('rt.back')}>
                <Icon name="back" />
                <Label>{t('rt.back')}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="forward" textValue={t('rt.forward')}>
                <Icon name="arrow-right" />
                <Label>{t('rt.forward')}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="rebuild" textValue={t('rt.rebuild')}>
                <Icon name="sparkles" />
                <Label>{t('rt.rebuild')}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="refresh" textValue={t('rt.regen')}>
                <Icon name="refresh" />
                <Label>{t('rt.regen')}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="share" textValue={t('rt.share')}>
                <Icon name="link" />
                <Label>{t('rt.share')}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="export" textValue={t('rt.export')}>
                <Icon name="download" />
                <Label>{t('rt.export')}</Label>
              </Dropdown.Item>
              <Dropdown.Item id="history" textValue={t('rt.history')}>
                <Icon name="history" />
                <Label>{t('rt.history')}</Label>
              </Dropdown.Item>
              <Dropdown.Item
                id="handle-side"
                textValue={handlePos.side === 'right' ? t('rt.handleLeft') : t('rt.handleRight')}
              >
                <Icon name={handlePos.side === 'right' ? 'arrow-left' : 'arrow-right'} />
                <Label>
                  {handlePos.side === 'right' ? t('rt.handleLeft') : t('rt.handleRight')}
                </Label>
              </Dropdown.Item>
            </Dropdown.Section>
            <Dropdown.Item id="settings" textValue={t('common.settings')}>
              <Icon name={needsKey ? 'key' : 'settings'} />
              <Label>{needsKey ? t('rt.settingsKey') : t('common.settings')}</Label>
            </Dropdown.Item>
            <Dropdown.Item id="home" textValue={t('rt.closeDomino')}>
              <Icon name="close" />
              <Label>{t('rt.closeDomino')}</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
          {/* Developer tools live OUTSIDE the menu collection: pressing the
              row must not select (react-aria would close the whole menu) —
              it toggles a flyout submenu that opens BESIDE the menu, which
              stays up until a real item is picked. */}
          <div className="menu-submenu-row">
            <button
              type="button"
              className="menu-item menu-item--default menu-submenu-trigger"
              aria-expanded={devMenuOpen}
              aria-haspopup="menu"
              onClick={() => {
                const next = !devMenuOpen
                setDevMenuOpen(next)
                // The expanded rows land inside the popover's scroll area:
                // reveal them the moment they mount, so "expands downward"
                // never means "expands out of sight".
                if (next) {
                  window.setTimeout(() => {
                    document
                      .querySelector('.menu-submenu-items')
                      ?.lastElementChild?.scrollIntoView({ block: 'nearest' })
                  }, 60)
                }
              }}
            >
              <Icon name="grid" />
              <Label>{t('rt.devMenu')}</Label>
              <span aria-hidden className="menu-submenu-chev">
                {handlePos.side === 'right' ? '‹' : '›'}
              </span>
            </button>
            {/* The submenu ACCORDIONS open downward, in-flow inside the
                popover: nothing to clip, nothing outside the modal scope —
                and the row (outside the menu collection) keeps the menu up. */}
            {devMenuOpen ? (
              <div className="menu-submenu-items" role="menu" aria-label={t('rt.devMenu')}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    menuOpenRef.current = false
                    setMenuOpen(false)
                    setDevMenuOpen(false)
                    setChrome(chrome === 'app' ? 'inspect' : 'app')
                  }}
                >
                  <Icon name="layers" />
                  {chrome === 'app' ? t('rt.inspectOn') : t('rt.inspectOff')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    menuOpenRef.current = false
                    setMenuOpen(false)
                    setDevMenuOpen(false)
                    setGraphOpen(true)
                  }}
                >
                  <Icon name="chart" />
                  {t('rt.graph')}
                </button>
              </div>
            ) : null}
          </div>
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
          <Modal.Dialog aria-label={t('rt.editTitle')}>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{t('rt.editTitle')}</Modal.Heading>
              <p className="text-sm text-muted">{t('rt.editDesc')}</p>
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
                <TextArea rows={4} placeholder={t('rt.editPlaceholderModal')} />
              </TextField>
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-2">
              <Button variant="ghost" onPress={() => setEditOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                isDisabled={!currentSpec || !editText.trim()}
                onPress={() => submitEdit(editText)}
              >
                {t('rt.editSubmit')}
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
              <AlertDialog.Heading>{t('rt.rebuildTitle')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted">
                {t('rt.rebuildBody')}{' '}
                <strong className="text-warning">{t('rt.rebuildWarn')}</strong>
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer className="flex justify-end gap-2">
              <Button variant="ghost" onPress={() => setRebuildOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onPress={() => {
                  setRebuildOpen(false)
                  rebuildApp()
                }}
              >
                {t('rt.rebuildGo')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      {/* Export chooser: the definition alone, or the definition WITH the
          built pages embedded — the latter runs on any device, zero LLM. */}
      <Modal.Backdrop
        isOpen={exportOpen}
        onOpenChange={(o) => {
          if (!o) setExportOpen(false)
        }}
        variant="blur"
      >
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog aria-label={t('rt.export')}>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{t('rt.exportTitle')}</Modal.Heading>
              <p className="text-sm text-muted">{t('rt.exportDesc')}</p>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-2">
              <button type="button" className="export-option" onClick={() => runExport(false)}>
                <strong>{t('rt.exportDefTitle')}</strong>
                <span>{t('rt.exportDefDesc')}</span>
              </button>
              <button
                type="button"
                className="export-option"
                onClick={() => runExport(true)}
                disabled={!currentSpec}
              >
                <strong>{t('rt.exportAppTitle')}</strong>
                <span>
                  {t('rt.exportAppDesc', { n: currentSpec?.pages.length ?? 0 })}{' '}
                  {currentSpec?.pages.length ?? 0}개와 액션 연결이 함께 저장됩니다 — 받은 사람이
                  LLM·API 키 없이 바로 실행합니다.
                </span>
              </button>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/* Command palette (⌘/Ctrl K): every runtime action plus a jump to any
          page of the current screen. Enter runs the highlighted row. */}
      <Modal.Backdrop
        isOpen={paletteOpen}
        onOpenChange={(open) => {
          if (!open) setPaletteOpen(false)
        }}
        variant="blur"
      >
        <Modal.Container size="sm" placement="top" scroll="inside">
          <Modal.Dialog aria-label={t('rt.palette')}>
            <Modal.CloseTrigger />
            <Modal.Body className="flex flex-col gap-2">
              <input
                className="w-full rounded-lg border border-[var(--separator)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                value={paletteQuery}
                placeholder={t('rt.palettePlaceholder')}
                aria-label={t('rt.paletteSearch')}
                autoFocus
                onChange={(e) => {
                  setPaletteQuery(e.target.value)
                  setPaletteSel(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setPaletteSel((s) => s + 1)
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setPaletteSel((s) => Math.max(0, s - 1))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    const item = paletteFiltered[paletteActive]
                    if (item) runPalette(item)
                  }
                }}
              />
              <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
                {paletteFiltered.length === 0 ? (
                  <li className="px-2 py-3 text-sm text-muted">{t('rt.paletteNone')}</li>
                ) : (
                  paletteFiltered.map((item, i) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        className={`palette-item${i === paletteActive ? ' is-active' : ''}`}
                        onMouseEnter={() => setPaletteSel(i)}
                        onClick={() => runPalette(item)}
                      >
                        {item.icon ? <Icon name={item.icon} size={16} /> : null}
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

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
                  data={dataSnap}
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
          {langOffer ? (
            <div className="runtime-banner">
              <Alert
                variant="warning"
                title={t('rt.langDiffTitle')}
                message={t('rt.langDiffBody', {
                  page: LANG_NATIVE[langOffer.from],
                  ui: LANG_NATIVE[langOffer.to]
                })}
                action={{
                  label: t('rt.langChange'),
                  onPress: () => {
                    const target = langOffer.to
                    setLangOffer(null)
                    langTranslateRef.current?.(target)
                  }
                }}
                onClose={() => setLangOffer(null)}
              />
            </div>
          ) : null}
          {tokenWarned ? (
            <div className="runtime-banner">
              <Alert
                variant="warning"
                title={t('rt.tokenWarnTitle')}
                message={`이번 세션에서 ${t('rt.usageTurn', { n: fmtTokens(usageTotal) })}을 사용했습니다 — 예산을 확인하세요. (설정에서 임계값 조정)`}
                action={{ label: t('common.settings'), onPress: onOpenSettings }}
                onClose={() => setTokenWarned(false)}
              />
            </div>
          ) : null}
          {error ? (
            <div className="runtime-banner">
              <Alert
                variant="danger"
                title={t('rt.errorTitle')}
                message={error}
                action={
                  lastTurnRef.current
                    ? {
                        label: t('rt.retry'),
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
              data={dataSnap}
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
            {editCount > 1 ? t('rt.editQueueMany', { n: editCount }) : t('rt.editQueueOne')}
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
              {t('rt.undo')}
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
              {t('rt.view')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Developer menu's mermaid view: pages, every action button, and where
          each leads — unconnected buttons show as live-generation targets. */}
      <PageGraphDialog
        open={graphOpen}
        onClose={() => setGraphOpen(false)}
        spec={currentSpec}
        nav={nav}
        domino={domino}
        edges={graphEdgesRef.current}
        tick={graphTick}
      />

      {/* Right-side screen history: every settled moment; click restores it. */}
      {historyOpen ? <div className="history-scrim" onClick={() => setHistoryOpen(false)} /> : null}
      <aside
        className={`history-panel${historyOpen ? ' is-open' : ''}`}
        aria-label={t('rt.history')}
      >
        <div className="history-panel-head">
          <span className="history-panel-title">{t('rt.history')}</span>
          <span className="history-total">{t('rt.usageTurn', { n: fmtTokens(usageTotal) })}</span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={t('rt.historyClose')}
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
                {e.note ? <span className="history-note">{e.note}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {apiLogRef.current.length > 0 ? (
          <div className="history-api">
            <div className="history-panel-head">
              <span className="history-panel-title">{t('rt.apiCalls')}</span>
              <span className="history-total">
                {t('rt.apiCount', { n: apiLogRef.current.length })}
              </span>
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
  start: t('rt.kindStart'),
  action: t('rt.kindAction'),
  nav: t('rt.kindNav'),
  edit: t('rt.kindEdit'),
  restore: t('rt.kindRestore')
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
      aria-label={t('rt.composing')}
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
