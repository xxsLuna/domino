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
import { buildSystemPrompts } from '@core/agent/prompt'
import { executeApi, resolveEndpoint } from '@core/agent/api'
import {
  bookFields,
  endpointKey,
  hashSchema,
  loadSchemaBook,
  rememberSchema,
  saveSchemaBook,
  type SchemaBook
} from '@core/agent/schema'
import {
  apiSnapBindings,
  loadApiSnaps,
  putApiSnap,
  saveApiSnaps,
  type ApiSnaps
} from '@core/agent/apiSnaps'
import {
  mergeBuiltPage,
  mergeKnownPage,
  plannedPages,
  pregenClickTargets,
  pregenPagePrompt,
  pregenTargets,
  PREGEN_CONCURRENCY
} from '@core/agent/pregen'
import { compactHistory } from '@core/agent/history'
import { nextSpecChars, renderProgress } from '@core/agent/progress'
import { interpolateCallPath } from '@core/domino/actions'
import {
  bootNeedsLogin,
  scriptEventOutcome,
  scriptLandingPage,
  type ScriptEventOutcome
} from '@core/domino/script'
import { dominoFingerprint } from '@core/domino/fingerprint'
import { parseDomino } from '@core/domino/parse'
import { withScreensSection } from '@core/domino/sections'
import {
  allowErrorRoute,
  apiErrorCode,
  isSessionExpiry,
  pressScriptEvent,
  scriptCallRequest,
  scriptRoute,
  sessionVarsFromLogin,
  type RouteMemo
} from '@core/runtime/script'
import {
  apiKeysToRefresh,
  boundApiKeys,
  keysStaleAfterWrite,
  parseEndpointKey
} from '@core/runtime/apiBindings'
import { loadDataSnaps, persistableDataSnaps, saveDataSnaps } from '@core/runtime/dataSnaps'
import {
  planSourceFetch,
  settleWithin,
  sourcesReadingState,
  STATE_SOURCE_DEBOUNCE_MS,
  TURN_DATA_WAIT_MS
} from '@core/runtime/dataSources'
import {
  adoptDeclaredId,
  alignHistoryWithView,
  answerEdge,
  backView,
  keepCanonicalPage,
  cacheableAnswer,
  dismissesPage,
  namedDestination,
  navWithPlan,
  nodeContext,
  mergeEmbeddedEdges,
  planPress,
  recordPagesFromHistory,
  replayView,
  turnKnownPages,
  type PressAnswer
} from '@core/runtime/navigation'
import {
  pendingDestination,
  shouldIgnorePress,
  type InflightAction,
  type PendingDestination
} from '@core/runtime/interaction'
import {
  clickBuildKey,
  pageBuildKey,
  PregenBuilds,
  runPool,
  type Adoption,
  type BuildResult,
  type PregenBuild
} from '@core/runtime/pregenBuilds'
import {
  actionCacheKey,
  clickPregenPrompt,
  editTurnPrompt,
  promptCacheKey,
  turnTransientContext,
  usageStep
} from '@core/runtime/turn'
import type { ActionDecl } from '@core/domino/types'
import {
  loadPageGraph,
  observedDests,
  pageMapLines,
  pruneEdgesForPage,
  savePageGraph,
  upsertAnswerEdge,
  type GraphEdge
} from '@core/pageGraph'
import { createAdapter, needsApiKey, type ChatMessage, type LLMConfig } from '@core/llm'
import { effectiveReasoning, nextReasoningLevel } from '@core/llm/reasoning'
import { httpFetch, readTextCapped } from '@core/net'
import {
  hashContext,
  historyKey,
  legacyHistoryKey,
  SessionStore,
  type HistoryKind
} from '@core/session/session'
import {
  clearSessionVars,
  clearToken,
  extractToken,
  getToken,
  loadSessionVars,
  loadTokenWarn,
  saveSessionVars,
  setToken
} from '@core/session/prefs'
import { ScreenStore, type ScreenDeps } from '@core/session/screenStore'
import { protectDomino } from '@core/session/storageAudit'
import { BottomNav, SideNav } from '@core/ui/AppNav'
import { navDataKeys, resolveNavItems } from '@core/ui/nav'
import { CardGrid, PageSkeleton } from '@core/ui/CardGrid'
import { changedNodeIds, streamView } from '@core/ui/streaming'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'
import { themeVars } from '@core/ui/theme'
import {
  findNode,
  findPage,
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
import { flushStorage, getStorage, onAppHidden, onQuitFlush, onStorageError } from '../platform'
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

/** What one turn answers, and how its answer may be reused. */
interface TurnOptions {
  /** The press whose turn this is (a second press of it is dropped while it runs). */
  action?: InflightAction
  /** The press the landing screen answers — its graph edge is recorded from it, once. */
  answers?: PressAnswer
  /** false: the answer is this press's alone — never cached or replayed. */
  cache?: boolean
  /** Pages the model may navigate to (default: every built page). */
  knownPages?: string[]
  /**
   * The page id an [actions] `goto` declares for this press: a NEW page the
   * model designs under another id is renamed to it, so the next press
   * resolves it by id and never reaches the model again.
   */
  declaredPage?: string
}

/** Why the session ends: the user signed out, or the backend rejected the token (401). */
type SignOutReason = 'logout' | 'auth_failed'

/** Which file diagnostics were dismissed, per domino (hash of the set). */
const DIAG_SEEN_KEY = 'domino:diag-seen'
const DIAG_SEEN_MAX = 30

/** At most one storage-trouble notice per this many ms. */
const STORAGE_NOTICE_MS = 60_000

/** Items one `@subscriptions` snapshot may carry — 20 feeds × 50 items is plenty. */
const MAX_FEED_ITEMS = 200

/** Predicted button destinations built per pregen batch, and per session. */
const MAX_CLICK_PREGEN_BATCH = 2
const MAX_CLICK_PREGEN_SESSION = 6

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
  /**
   * The most recent turn — its prompt is what "retry" re-runs after a
   * failure — and the page it was asked from: Retry only makes sense there.
   */
  const lastTurnRef = useRef<{
    prompt: string
    cacheKey: string | null
    page: string | null
    opts?: TurnOptions
  } | null>(null)
  /** Cancels the lane's running turn (superseded, interrupted, unmounted). */
  const turnAbortRef = useRef<AbortController | null>(null)
  /** The press the running user turn answers — a second press of it is dropped. */
  const turnActionRef = useRef<InflightAction | null>(null)
  /** A sign-in request is in flight — a second press of the form is the same request. */
  const loginBusyRef = useRef(false)
  /** Page id of the streaming preview (presses on a half-built new page are dropped). */
  const previewPageRef = useRef<string | null>(null)
  /** Stable provider prompt-cache key for this domino on this model. */
  const llmCacheKey = useMemo(
    () => promptCacheKey(domino.id, config.model),
    [domino.id, config.model]
  )
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
  const dataSaveTimer = useRef<number | null>(null)
  /** Late-bound storage-failure reporter (declared with the notices below). */
  const onPersistErrorRef = useRef<(() => void) | null>(null)
  /** Rendering gauge: turn start, streamed chars, EMA of finished spec sizes. */
  const progressStart = useRef(0)
  const progressChars = useRef(0)
  const specCharsEma = useRef(0)
  const progressTimer = useRef<number | null>(null)
  const progressFade = useRef<number | null>(null)
  /**
   * Background pre-generation: bumped to cancel (rebuild, sign-in/out,
   * unmount). A user turn no longer cancels it — builds of OTHER pages keep
   * going, and a tap on a page being built adopts its build.
   */
  const pregenSeq = useRef(0)
  const pregenScheduled = useRef(false)
  /** Late-bound so the early finalize hook can reach the runner declared below. */
  const pregenRunnerRef = useRef<((seq: number) => Promise<void>) | null>(null)
  /** Background builds in flight (pages and predicted button destinations). */
  const pregenBuildsRef = useRef(new PregenBuilds())
  /** Targets already attempted this session — a build that never merges is not retried. */
  const pregenTriedRef = useRef(new Set<string>())
  const clickTriedRef = useRef(new Set<string>())
  /** Bound `api:GET …` refreshes: running, and when the last one failed. */
  const apiInflightRef = useRef(new Set<string>())
  const apiFailedAtRef = useRef<Record<string, number>>({})
  /** [data] fetches in flight (one per source and path) and the newest request per source. */
  const sourceInflightRef = useRef(new Map<string, { path: string; promise: Promise<void> }>())
  const sourceSeqRef = useRef<Record<string, number>>({})
  /**
   * Bumped on every auth transition (sign-out, entering an auth state): a
   * request that started under the old one lands into nothing — its body is
   * never remembered, persisted or bound on the other side, and its 401 (it
   * carried the old token) never signs the new session out.
   */
  const authEpochRef = useRef(0)
  /** Debounce timers for sources re-queried by a state key the user is editing. */
  const stateSourceTimers = useRef(new Map<string, number>())
  /** Late-bound: showSpec (declared early) refreshes the shown page's bound endpoints. */
  const refreshApiBindingsRef = useRef<((spec: UiSpec) => void) | null>(null)
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
  /**
   * Pages whose canonical copy shows ONE record (page id → record identity):
   * reached by a row select, a submit, or a press on another record page.
   * Presses never auto-link or replay into them, and back/forward bring a
   * moment's own record back instead of whichever one is canonical now.
   */
  const recordPagesRef = useRef(new Map<string, string>())
  /** Definition fingerprint: stored screens/views/history built on another one are outdated. */
  const fingerprint = useMemo(() => dominoFingerprint(domino), [domino])
  /** Last time a storage-trouble notice was shown (they are rate-limited). */
  const storageNoticeAt = useRef(0)
  /**
   * [script] context beyond logged_in: the sign-in response's non-secret
   * fields (plan, role…, persisted with the token) and the last API error
   * code (`when error == "billing" -> goto upgrade`).
   */
  const sessionVarsRef = useRef<Record<string, unknown>>({})
  const lastErrorRef = useRef<string | null>(null)
  /** The last route an `api_error` rule took — the same one never loops. */
  const errorRouteRef = useRef<RouteMemo | null>(null)
  /** A 401 burst signs out once: set while the expired session is being left. */
  const authExpiringRef = useRef(false)
  /**
   * Late-bound handlers for API answers (declared further down, reached from
   * the fetchers declared before them): an expired session (401 with the
   * token) signs out; any other failure fires [script]'s `api_error`.
   */
  const authExpiredRef = useRef<(() => void) | null>(null)
  const apiErrorRef = useRef<((code: string) => void) | null>(null)
  /** The definition changed since the stored screens were built (banner). */
  const [defChanged, setDefChanged] = useState(false)
  /** Parse diagnostics of the open file: the dismissed set, and the details dialog. */
  const warningsKey = useMemo(
    () => loaded.warnings.map((w) => `${w.line}:${w.message}`).join('\n'),
    [loaded.warnings]
  )
  const [warningsSeen, setWarningsSeen] = useState<string | null>(null)
  const [diagOpen, setDiagOpen] = useState(false)

  const [currentSpec, setCurrentSpec] = useState<UiSpec | null>(null)
  /** Mirror of currentSpec for async turns deciding "is my page on screen". */
  const currentSpecRef = useRef<UiSpec | null>(null)
  useEffect(() => {
    currentSpecRef.current = currentSpec
  }, [currentSpec])
  const [previewSpec, setPreviewSpec] = useState<UiSpec | null>(null)
  useEffect(() => {
    previewPageRef.current = previewSpec?.page ?? null
  }, [previewSpec])
  /**
   * Where a running turn is headed when that is known up front (a tab, an
   * observed edge, a declared goto, an adopted background build): its
   * skeleton and name show at once instead of the old page staying up for
   * the whole first-token wait. Cleared wherever the preview is.
   */
  const [pendingNav, setPendingNav] = useState<PendingDestination | null>(null)
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

  // …and for the last-known [data] snapshots (a reopen shows them at once).
  const persistDataSnaps = useCallback((): void => {
    void saveDataSnaps(
      storage,
      domino.id,
      persistableDataSnaps(dataSnapRef.current, domino.data),
      onPersistErrorRef.current ?? undefined
    )
  }, [domino.data, domino.id, storage])
  const scheduleDataSave = useCallback(() => {
    if (domino.data.length === 0) return
    if (dataSaveTimer.current !== null) window.clearTimeout(dataSaveTimer.current)
    dataSaveTimer.current = window.setTimeout(() => {
      dataSaveTimer.current = null
      persistDataSnaps()
    }, 1_000)
  }, [domino.data.length, persistDataSnaps])

  // Don't drop a pending save when the screen unmounts mid-debounce.
  useEffect(
    () => () => {
      if (dataSaveTimer.current !== null) {
        window.clearTimeout(dataSaveTimer.current)
        dataSaveTimer.current = null
        persistDataSnaps()
      }
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
    [domino.id, persistDataSnaps, storage]
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
    // Stop the request itself, not just its consumer: a superseded turn
    // waiting on its first token used to keep running (and billing), and a
    // write it had not sent yet still went out.
    turnAbortRef.current?.abort()
    turnAbortRef.current = null
    turnActiveRef.current = false
    turnActionRef.current = null
    setStreaming(false)
    setPreviewSpec(null)
    setPendingNav(null)
    setStatus('')
    cancelGauge()
    // The interrupted turn's finally is now orphaned (guard skips it), so a
    // queued edit that was waiting on this lane must be drained from here.
    editDrainRef.current?.()
  }, [cancelGauge])

  /**
   * Apply a spec's navigation: explicit `nav` wins, login screens never show
   * it. The [pages] plan's tabs fill in what the model left out, so every
   * planned section is reachable (and pre-built) even without a nav bar.
   */
  const applyNav = useCallback(
    (spec: UiSpec) => {
      let items = navRef.current
      if (spec.nav !== undefined) items = spec.nav
      else if (spec.page === 'login') items = []
      const signedOut = domino.auth.required && !loggedInRef.current
      if (spec.page !== 'login' && !signedOut) items = navWithPlan(items, plannedPages(domino))
      navRef.current = items
      setNav(items)
      // Highlight the tab this screen belongs to: by id first, then by the
      // page's name (nav ids drift from page ids). Nothing matching — a page
      // outside the nav — clears the highlight instead of leaving it stale.
      const name = spec.pages.find((p) => p.id === spec.page)?.name
      const active = items.find(
        (i) => i.id === spec.page || (name !== undefined && i.label === name)
      )
      setActiveNav(active ? active.id : null)
    },
    [domino]
  )

  /**
   * After a screen settles: build the planned/nav/script pages in the
   * background (a few at a time, see maybeRunPreGen) so tapping them switches
   * instantly. A user turn does not cancel it; a tap on a page still being
   * built adopts that build instead of starting over.
   */
  const schedulePreGen = useCallback(() => {
    if (pregenScheduled.current || needsApiKey(config)) return
    pregenScheduled.current = true
    const seq = pregenSeq.current
    // Just long enough for the screen that settled to paint first.
    window.setTimeout(() => {
      void pregenRunnerRef.current?.(seq)
    }, 50)
  }, [config])

  /**
   * Cancel all background building (the app's context changed: rebuild,
   * sign-in, sign-out) — every target becomes eligible again.
   */
  const cancelPreGen = useCallback(() => {
    pregenSeq.current++
    pregenScheduled.current = false
    pregenBuildsRef.current.cancelAll()
    pregenTriedRef.current.clear()
    clickTriedRef.current.clear()
  }, [])

  const showSpec = useCallback(
    (
      spec: UiSpec,
      opts?: {
        /**
         * Show this page's copy from `spec` WITHOUT making it canonical: the
         * known pages and the saved view keep the current canonical copy
         * (Back/Forward onto another record's moment — an edit made to the
         * page since must not be reverted by that old copy).
         */
        keepCanonical?: string
      }
    ) => {
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
      const known = keepCanonicalPage(
        withKnownPages(applied, knownRef.current),
        knownRef.current,
        opts?.keepCanonical
      )
      knownRef.current = known
      const prevPage = currentSpecRef.current?.page
      currentSpecRef.current = applied // async turns decide visibility against it
      setCurrentSpec(applied)
      setPreviewSpec(null)
      setPendingNav(null)
      // A failed turn's banner (and its Retry) belongs to the page it failed
      // on: moving to another page retires it.
      if (prevPage !== undefined && prevPage !== applied.page) setError(null)
      setPageName(applied.pages.find((p) => p.id === applied.page)?.name ?? applied.page)
      applyNav(applied)
      // Remember where the user was: reopening restores this screen as-is
      // (the store coalesces bursts into one write).
      void screensRef.current?.saveView(loggedInRef.current, { page: applied.page, known })
      // Bound GET endpoints of the page now on screen refetch when their
      // snapshot is missing or aged — cached, restored and pre-built pages
      // come up with live data, without a model turn.
      refreshApiBindingsRef.current?.(applied)
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
        // The optimistic tab highlight pointed at the target that never
        // came: put it back on the page that is actually shown.
        if (currentSpecRef.current) applyNav(currentSpecRef.current)
        setError(message)
      }
    },
    [applyNav, schemaHashes, showSpec]
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
  const usageChipTimer = useRef<number | null>(null)
  /** Recent call_api results (newest first) — the drawer's API section. */
  const apiLogRef = useRef<Array<{ at: number; path: string; status: number; ms: number }>>([])

  /**
   * Remember page ←action→ page (one answer per page+action, newest wins);
   * persisted so the graph survives restarts.
   */
  const recordGraphEdge = useCallback(
    (edge: GraphEdge): void => {
      graphEdgesRef.current = upsertAnswerEdge(graphEdgesRef.current, edge)
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
   * Storage trouble (quota, disk) is said out loud — rate-limited — instead
   * of persistence silently stopping: "recovered" means older data of other
   * apps was cleared to make room; otherwise the write was lost.
   */
  const reportStorage = useCallback(
    (recovered: boolean): void => {
      const now = Date.now()
      if (now - storageNoticeAt.current < STORAGE_NOTICE_MS) return
      storageNoticeAt.current = now
      armResultToast(
        {
          kind: 'notice',
          text: recovered ? t('rt.storageEvicted') : t('rt.storageFail'),
          target: null
        },
        8_000
      )
    },
    [armResultToast]
  )
  const onPersistError = useCallback((): void => reportStorage(false), [reportStorage])
  onPersistErrorRef.current = onPersistError
  useEffect(() => onStorageError((e) => reportStorage(e.recovered)), [reportStorage])

  /**
   * The app map for the model's prompt: pages that exist, connected actions,
   * unconnected buttons — the mermaid view's model in cheap text lines.
   */
  const appMapLines = useCallback((): string[] | undefined => {
    const known = knownRef.current
    if (!known || known.pages.length === 0) return undefined
    return pageMapLines(known, navRef.current, domino, graphEdgesRef.current)
  }, [domino])

  /** Whether `pageId` is one of the tabs (a list page, never a record page). */
  const isNavPage = useCallback((pageId: string): boolean => {
    const nav = navRef.current
    if (nav.some((i) => i.id === pageId)) return true
    const known = knownRef.current
    if (!known) return false
    return nav.some((i) => resolvePageId(nav, known.pages, i.id) === pageId)
  }, [])

  const finalizeSpec = useCallback(
    (
      spec: UiSpec,
      cacheKey: string | null,
      kindHint?: HistoryKind,
      opts?: {
        /** false: badge the moment by its key, but never replay it (a turn that wrote data). */
        cache?: boolean
        /**
         * The press this screen answers (its own turn or replay — never any
         * other screen that happens to land next): its landing becomes a
         * page-graph edge, unless it stayed on its page (an in-place update).
         */
        answers?: PressAnswer
        /** The answering turn wrote data: a data-action edge, never a link. */
        mutated?: boolean
        /**
         * A later screen of the same turn: overwrite the history moment the
         * turn already pushed (at this index) instead of pushing another one
         * — one press is one moment.
         */
        replaceAt?: number
      }
    ) => {
      const answers = opts?.answers
      // Only a landing on ANOTHER page gives that page a record identity: an
      // in-place data press (search, filter, next page) leaves a plain list.
      const recordLanding = Boolean(answers && answers.dataKey !== undefined && spec.page !== answers.from)
      // The tabs are lists, never record pages: a create-form submit that
      // navigates back to its list must not mark that list.
      const navPage = isNavPage(spec.page)
      if (answers) {
        const edge = answerEdge(answers, spec.page, opts?.mutated === true)
        if (edge) recordGraphEdge(edge)
        // Which record the page's canonical copy now shows (none: a plain page).
        if (recordLanding && !navPage) {
          recordPagesRef.current.set(spec.page, answers.dataKey!)
        } else if (spec.page !== answers.from || navPage) {
          recordPagesRef.current.delete(spec.page)
        }
      } else if (cacheKey?.startsWith('init::') || (cacheKey == null && navPage)) {
        // A start screen, or an instant switch to a tab: a plain page again.
        recordPagesRef.current.delete(spec.page)
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
      const meta = {
        kind,
        ...(note ? { note } : {}),
        ...(answers?.dataKey !== undefined ? { dataKey: answers.dataKey } : {}),
        ...(recordLanding && !navPage ? { recordLanding: true } : {})
      }
      const replaced =
        opts?.replaceAt !== undefined && session.replaceTop(opts.replaceAt, spec, meta)
      if (!replaced) session.push(spec, meta)
      // Post-edit: offer a one-tap undo back to the moment BEFORE this edit
      // (computed once, on the edit's first landing). Any other new moment
      // retires the offer — its baseline has moved on.
      if (replaced) {
        // Same moment, same undo target: nothing to re-arm.
      } else if (kind === 'edit') {
        const undoTo = session.historySize - 2
        if (undoTo >= 0) {
          armResultToast({ kind: 'undo', text: t('rt.toastEdited'), target: undoTo }, 8_000)
        }
      } else {
        setResultToast((prev) => (prev?.kind === 'undo' ? null : prev))
      }
      if (cacheKey && opts?.cache !== false) session.cacheSet(cacheKey, spec)
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
      isNavPage,
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
   * Every API answer the runtime sees (turns, [data] fetches, bound-endpoint
   * refreshes, [actions] and [script] calls) passes through here. A 401 on a
   * request that carried the session token means the session expired: the
   * runtime signs out itself and returns true — the caller stops, so a turn
   * never loops on a dead token. Any other failure is [script]'s `api_error`
   * (only when `route`: a background build's failure never moves the user).
   */
  const reportApiResult = useCallback(
    (result: { status: number; data?: unknown }, sentToken: boolean, route = true): boolean => {
      if (isSessionExpiry(result.status, sentToken)) {
        authExpiredRef.current?.()
        return true
      }
      const code = apiErrorCode(result)
      if (code !== null && route) apiErrorRef.current?.(code)
      return false
    },
    []
  )

  /** Append one runtime-made request to the drawer's API log (newest first, bounded). */
  const logApi = useCallback((path: string, status: number, ms: number): void => {
    apiLogRef.current.unshift({ at: Date.now(), path, status, ms })
    if (apiLogRef.current.length > 50) apiLogRef.current.length = 50
  }, [])

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
  const commitSourceSnapshot = useCallback(
    (key: string, value: unknown): void => {
      dataSnapRef.current = { ...dataSnapRef.current, [key]: value }
      dataAtRef.current = { ...dataAtRef.current, [key]: Date.now() }
      setDataSnap(dataSnapRef.current)
      // `api:` bodies persist through apiSnaps; [data] sources through here.
      if (!key.startsWith('api:')) scheduleDataSave()
    },
    [scheduleDataSave]
  )

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
   *
   * Boot, turns, polls and pregen may all ask at once: a request for the same
   * source AND the same resolved path joins the one in flight, and only the
   * newest request per source may commit — a slow answer for an old filter
   * value never overwrites the current one.
   */
  const fetchSource = useCallback(
    (key: string): Promise<void> => {
      const decl = domino.data.find((d) => d.key === key)
      if (!decl) return Promise.resolve()
      const identity =
        decl.method === 'FEED'
          ? decl.path === '@subscriptions'
            ? `@subscriptions ${feedsRef.current.map((f) => f.url).join(' ')}`
            : (interpolateDataPath(decl.path, true) ?? '')
          : (interpolateDataPath(decl.path) ?? '')
      const running = sourceInflightRef.current.get(key)
      if (running && running.path === identity) return running.promise
      const seq = (sourceSeqRef.current[key] ?? 0) + 1
      sourceSeqRef.current[key] = seq
      const epoch = authEpochRef.current
      const commit = (value: unknown): void => {
        if (sourceSeqRef.current[key] === seq && authEpochRef.current === epoch) {
          commitSourceSnapshot(key, value)
        }
      }
      const log = (path: string, status: number, ms: number): void => {
        apiLogRef.current.unshift({ at: Date.now(), path, status, ms })
        if (apiLogRef.current.length > 50) apiLogRef.current.length = 50
      }
      const run = async (): Promise<void> => {
        if (decl.method === 'FEED') {
          if (decl.path === '@subscriptions') {
            const results = await Promise.all(
              feedsRef.current.map((f) => fetchFeed(f.url, f.title))
            )
            for (const r of results) log(`FEED ${r.entry.url}`, r.status, r.ms)
            commit({
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
          const url = identity
          if (!url) return // not ready: the URL state input is still empty
          const norm = normalizeFeedUrl(url)
          if (!norm) {
            commit({ error: 'feed URL must be https (plain http only on localhost)' })
            return
          }
          const result = await fetchFeed(norm)
          log(`FEED ${norm}`, result.status, result.ms)
          commit(result.data ?? { error: result.error ?? `HTTP ${result.status}` })
          return
        }
        const path = identity
        if (!path) return // not ready: an input the source depends on is still empty
        const api = apiRuntime()
        const result = await executeApi(api, { path, method: decl.method })
        log(`${decl.method} ${path}`, result.status, result.ms ?? 0)
        // Signed out (or in) meanwhile: this answer belongs to the other side.
        if (authEpochRef.current !== epoch) return
        // An expired session signs out — its 401 body is no snapshot to keep.
        if (reportApiResult(result, Boolean(api.token))) return
        commit(
          result.status > 0 && result.status < 400
            ? result.data
            : { error: result.status === 0 ? 'unreachable' : `HTTP ${result.status}` }
        )
      }
      const promise = run().finally(() => {
        if (sourceInflightRef.current.get(key)?.promise === promise) {
          sourceInflightRef.current.delete(key)
        }
      })
      sourceInflightRef.current.set(key, { path: identity, promise })
      return promise
    },
    [apiRuntime, commitSourceSnapshot, domino.data, interpolateDataPath, reportApiResult]
  )

  /** Refresh every declared source in the background (bound cells update as each lands). */
  const refreshAllSources = useCallback((): Promise<void> => {
    return Promise.all(domino.data.map((d) => fetchSource(d.key))).then(() => undefined)
  }, [domino.data, fetchSource])

  /**
   * Before a model turn: wait (briefly, in parallel) only for sources that
   * have no snapshot at all — the prompt shows the rest as last known, and
   * aged ones refresh behind the turn.
   */
  const prefetchForTurn = useCallback(async (): Promise<void> => {
    const plan = planSourceFetch(domino.data, dataSnapRef.current, dataAtRef.current, Date.now())
    for (const key of plan.stale) void fetchSource(key)
    if (plan.missing.length === 0) return
    await settleWithin(Promise.all(plan.missing.map((k) => fetchSource(k))), TURN_DATA_WAIT_MS)
  }, [domino.data, fetchSource])

  /**
   * Refetch the `api:GET …` endpoints the shown page binds when their
   * snapshot is missing or aged — all at once, never blocking the screen.
   * Same gates as call_api (executeApi), logged like any runtime fetch; a
   * failure keeps the last good snapshot and backs off.
   */
  const refreshApiBindings = useCallback(
    (spec: UiSpec, opts?: { force?: boolean }): void => {
      const keys = boundApiKeys(spec, [spec.page], Object.keys(dataSnapRef.current))
      const due = apiKeysToRefresh(keys, {
        fetchedAt: dataAtRef.current,
        failedAt: apiFailedAtRef.current,
        inflight: apiInflightRef.current,
        now: Date.now(),
        // After a write: every bound endpoint of the landing page, however fresh.
        ...(opts?.force ? { maxAgeMs: -1, retryMs: 0 } : {})
      })
      const epoch = authEpochRef.current
      for (const key of due) {
        const ep = parseEndpointKey(key.slice('api:'.length))
        if (!ep) continue
        apiInflightRef.current.add(key)
        const api = apiRuntime()
        void executeApi(api, { path: ep.path, method: 'GET' })
          .then((result) => {
            logApi(`GET ${ep.path}`, result.status, result.ms ?? 0)
            // Signed out (or in) meanwhile: never bind this body on the other side.
            if (authEpochRef.current !== epoch) return
            if (reportApiResult(result, Boolean(api.token))) return
            const ok = result.status >= 200 && result.status < 300
            if (ok) delete apiFailedAtRef.current[key]
            else apiFailedAtRef.current[key] = Date.now()
            rememberApiSnapshot(endpointKey('GET', ep.path), result)
          })
          .catch(() => {
            apiFailedAtRef.current[key] = Date.now()
          })
          .finally(() => apiInflightRef.current.delete(key))
      }
    },
    [apiRuntime, logApi, rememberApiSnapshot, reportApiResult]
  )
  refreshApiBindingsRef.current = refreshApiBindings

  /**
   * A write landed: every read snapshot of the same resource is stale now —
   * its `api:GET …` keys lose their fetch stamp (the landing screen's
   * bindings refetch at once instead of showing the pre-write list for up
   * to the max age) and its declared [data] sources refetch right away. A
   * deleted row stays gone; a created one appears; a second Delete never
   * hits a row that no longer exists.
   */
  const invalidateAfterWrite = useCallback(
    (path: string): void => {
      const stale = keysStaleAfterWrite(path, Object.keys(dataSnapRef.current), domino.data)
      if (stale.length === 0) return
      const at = { ...dataAtRef.current }
      for (const key of stale) {
        delete at[key]
        delete apiFailedAtRef.current[key]
      }
      dataAtRef.current = at
      for (const d of domino.data) if (stale.includes(d.key)) void fetchSource(d.key)
    },
    [domino.data, fetchSource]
  )

  /**
   * The screen a turn that wrote data lands on refreshes everything it binds
   * — even a write to another resource than the one listed (a status change
   * through `/actions/archive` on an orders list).
   */
  const refreshAfterWrite = useCallback(
    (spec: UiSpec): void => {
      refreshApiBindings(spec, { force: true })
      const page = spec.pages.find((p) => p.id === spec.page)
      const used = referencedDataKeys({ ...spec, pages: page ? [page] : [] })
      for (const d of domino.data) if (used.has(d.key)) void fetchSource(d.key)
    },
    [domino.data, fetchSource, refreshApiBindings]
  )

  /**
   * Run the `call` command of a [script] outcome (boot, sign-in, sign-out,
   * an expired session, a routed event) through the same allow-listed path
   * as call_api. A GET answer becomes the `api:` snapshot the landing page
   * binds; a failure is logged and never blocks the navigation it rides on.
   */
  const runScriptCall = useCallback(
    async (outcome: Pick<ScriptEventOutcome, 'call' | 'callMethod'>): Promise<void> => {
      const req = scriptCallRequest(outcome)
      if (!req) return
      const api = apiRuntime()
      const epoch = authEpochRef.current
      try {
        const result = await executeApi(api, req)
        logApi(`${req.method} ${req.path}`, result.status, result.ms ?? 0)
        // Signed out (or in) meanwhile: the answer belongs to the other side.
        if (authEpochRef.current !== epoch) return
        if (req.method === 'GET') rememberApiSnapshot(endpointKey('GET', req.path), result)
        else if (result.status > 0 && result.status < 400) invalidateAfterWrite(req.path)
        // Expiry still signs out; its other failures do not re-route (no loops).
        reportApiResult(result, Boolean(api.token), false)
      } catch {
        logApi(`${req.method} ${req.path}`, 0, 0)
      }
    },
    [apiRuntime, invalidateAfterWrite, logApi, rememberApiSnapshot, reportApiResult]
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
  /**
   * An edit changed these pages: every cached or stored answer landing on
   * one of them holds the pre-edit copy and would revert the edit when
   * replayed — they go (the edit's own key stays). Graph edges from an
   * edited page whose widget is gone go too, so the app map and auto-links
   * follow the page as it now is.
   */
  const invalidateEdited = useCallback(
    (pageIds: readonly string[], keepKey: string, spec: UiSpec): void => {
      let edges = graphEdgesRef.current
      for (const id of new Set(pageIds)) {
        session.cacheEvictPage(id, keepKey)
        void screensRef.current?.evictPage(id, keepKey)
        const page = findPage(spec, id)
        if (page) edges = pruneEdgesForPage(edges, page)
      }
      if (edges !== graphEdgesRef.current) {
        graphEdgesRef.current = edges
        setGraphTick((t) => t + 1)
        void savePageGraph(storage, domino.id, edges)
      }
    },
    [domino.id, session, storage]
  )

  const landEdit = useCallback(
    (
      spec: UiSpec,
      cacheKey: string,
      pageId: string,
      edited?: readonly string[],
      /** A later screen of the same edit turn: replace that moment (finalizeSpec). */
      replaceAt?: number
    ): boolean => {
      invalidateEdited(edited && edited.length > 0 ? edited : [pageId], cacheKey, spec)
      const visible = currentSpecRef.current
      if (visible && visible.page === pageId) {
        // Navigation during the edit may have dropped the glow; re-baseline on
        // the screen as it stands so only this edit's cells light up.
        // (A second screen of the same edit keeps the first one's baseline.)
        if (replaceAt === undefined) setEditBase(visible)
        finalizeSpec(spec, cacheKey, undefined, replaceAt !== undefined ? { replaceAt } : undefined)
        return true
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
      return false
    },
    [armResultToast, finalizeSpec, invalidateEdited, session, showSpec]
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
      // Time travel: the moment's own copies become canonical again — and
      // with them, which record its page shows.
      const records = recordPagesRef.current
      // Other record pages come back as captured too — showing a record
      // nobody can name any more: still a record page, never a plain link.
      for (const p of snap.spec.pages) if (records.has(p.id)) records.set(p.id, `restored:${index}`)
      if (snap.dataKey !== undefined && snap.recordLanding && !isNavPage(snap.spec.page)) {
        records.set(snap.spec.page, snap.dataKey)
      } else {
        records.delete(snap.spec.page)
      }
      showSpec(snap.spec)
      syncNav()
      return true
    },
    [clearEditHighlight, interruptTurn, isNavPage, session, showSpec, syncNav]
  )

  const runTurn = useCallback(
    async (prompt: string, cacheKey: string | null, opts?: TurnOptions): Promise<TurnOutcome> => {
      const isEdit = Boolean(cacheKey?.startsWith('edit::'))
      const editPageId = isEdit && cacheKey ? cacheKey.slice('edit::'.length).split('::')[0] : null
      // Retry re-runs it with the same press attached (edge, cache policy).
      lastTurnRef.current = { prompt, cacheKey, page: currentSpecRef.current?.page ?? null, opts }
      /**
       * The press this turn answers. Consumed by the first screen it lands —
       * a later screen of the same turn, or any other screen, never records
       * this press's edge (it used to stay pending across failures and
       * interrupts and link the button to whatever page showed next).
       */
      let answers = isEdit ? undefined : opts?.answers
      const takeAnswers = (): PressAnswer | undefined => {
        const a = answers
        answers = undefined
        return a
      }
      const replayable = opts?.cache !== false
      // The turn this one supersedes stops streaming — and billing — now.
      turnAbortRef.current?.abort()
      const abort = new AbortController()
      turnAbortRef.current = abort
      const myTurn = ++turnSeq.current
      turnKindRef.current = isEdit ? 'edit' : 'user'
      turnActionRef.current = isEdit ? null : (opts?.action ?? null)
      // Background builds keep running: they build OTHER pages, and a tap on
      // the page one is building adopts it instead (dispatchToAgent).
      // A new turn owns a fresh usage window: drop the previous chip (the
      // session total keeps what it accumulated).
      let usageSeen = 0
      setLastUsage(null)
      if (usageChipTimer.current !== null) {
        window.clearTimeout(usageChipTimer.current)
        usageChipTimer.current = null
      }
      turnActiveRef.current = true
      turnDepsRef.current = {}
      /** A write ran this turn: its screen answers THIS press only — never replayed. */
      let mutated = false
      /**
       * One press is one history moment: the history index this turn's first
       * screen landed at (a later screen of the same turn — a second
       * render_ui, a data round's re-render — replaces it), the press that
       * screen answers, and what to cache once the turn is over: only then
       * does `mutated` cover every call of the turn.
       */
      let landedAt: number | undefined
      let landedPress: PressAnswer | undefined
      let toCache: { key: string; spec: UiSpec; landed: string; edit: boolean } | null = null
      // An ordinary turn replaces the screen the edit glow was tracking.
      if (!isEdit) clearEditHighlight()
      // Live client-side state and the moment list ride along with THIS
      // request only (transientContext): history keeps the bare prompt, so
      // old turns don't each carry a stale copy. Writes made from here on
      // are merged over the model's state when it lands.
      const transient = turnTransientContext(stateRef.current, session.entries())
      pendingStateWrites.current = {}
      setStreaming(true)
      setError(null)
      setStatus(t('rt.generating'))
      startGauge()

      // The engine appends to the history it is given, and a newer turn may
      // start while this one winds down — so run on our own copy and hand
      // back only the messages we added (append-only: neither side's
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
        // ({"$data": key.path}): wait briefly for any that has none yet;
        // aged ones refresh behind the turn.
        await prefetchForTurn()
        // Superseded while waiting: never send a request nobody will read.
        if (turnSeq.current !== myTurn || abort.signal.aborted) return 'superseded'
        // One snapshot per turn: the engine diffs responses against it, the
        // prompt describes screens built from it. The stable part is the
        // provider-cached prefix; the dynamic part follows it.
        const knownSchemas = bookFields(schemaBookRef.current)
        const prompts = buildSystemPrompts(domino, {
          loggedIn: loggedInRef.current,
          knownSchemas,
          dataSnapshots: dataSnapRef.current,
          pageMap: appMapLines(),
          feeds: feedsRef.current
        })
        fork.push({ role: 'user', content: prompt })
        // Fixed for the whole turn: whether its calls carried the session token.
        const api = apiRuntime()
        for await (const update of runAgentTurn({
          adapter,
          system: prompts.stable,
          systemDynamic: prompts.dynamic,
          transientContext: transient || undefined,
          history: fork,
          api,
          knownSchemas,
          signal: abort.signal,
          cacheKey: llmCacheKey,
          // A navigate to one of these ends the turn with no further pass. A
          // press whose destination depends on its record gets a narrower
          // list: the stored copy would show the previous record.
          knownPages:
            opts?.knownPages ??
            turnKnownPages(knownRef.current, navRef.current, recordPagesRef.current, false),
          // A failed/absent render is the one round worth spending depth on —
          // escalated from the level actually in effect (unset gpt-5 = low).
          escalateReasoning: () =>
            createAdapter({ ...config, reasoning: nextReasoningLevel(effectiveReasoning(config)) })
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
                // A declared [actions] goto target keeps its id even when the
                // model named the new page differently.
                const landed =
                  !isEdit && opts?.declaredPage
                    ? adoptDeclaredId(
                        update.spec,
                        opts.declaredPage,
                        knownRef.current,
                        opts.answers?.from ?? lastTurnRef.current?.page ?? ''
                      )
                    : update.spec
                const merged = withKnownPages(landed, knownRef.current)
                if (isEdit && cacheKey && editPageId) {
                  const pushed = landEdit(
                    merged,
                    cacheKey,
                    editPageId,
                    update.spec.pages.map((p) => p.id),
                    landedAt
                  )
                  if (pushed) landedAt = session.index
                  toCache = { key: cacheKey, spec: merged, landed: merged.page, edit: true }
                } else {
                  // The press this turn answers, taken at its FIRST screen.
                  if (landedAt === undefined) landedPress = takeAnswers()
                  // Cached (and persisted) when the turn ends — see toCache.
                  finalizeSpec(merged, cacheKey, undefined, {
                    cache: false,
                    answers: landedPress,
                    mutated,
                    ...(landedAt !== undefined ? { replaceAt: landedAt } : {})
                  })
                  landedAt = session.index
                  if (cacheKey) {
                    toCache = { key: cacheKey, spec: merged, landed: merged.page, edit: false }
                  }
                }
                // A write ran: the landing screen's data is refetched, not trusted.
                if (mutated) refreshAfterWrite(merged)
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
              logApi(update.result.path, update.result.status, update.result.ms ?? 0)
              // The session expired: the runtime signed out, which already
              // interrupted this turn — the model never answers a dead token.
              if (!update.blocked && reportApiResult(update.result, Boolean(api.token))) break
              if (update.method && update.method !== 'GET' && !update.blocked) {
                mutated = true
                // The lists this write changed are stale from now on.
                if (update.result.status > 0 && update.result.status < 400) {
                  invalidateAfterWrite(update.result.path)
                }
              }
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
              // The engine reports the TURN's running totals (every pass
              // summed): only the growth since the last report is new.
              const step = usageStep(usageSeen, update.usage)
              usageSeen = step.total
              if (step.add > 0) setUsageTotal((prev) => prev + step.add)
              if (step.total > 0) {
                setLastUsage(step.total)
                if (usageChipTimer.current !== null) window.clearTimeout(usageChipTimer.current)
                usageChipTimer.current = window.setTimeout(() => {
                  usageChipTimer.current = null
                  setLastUsage(null)
                }, 8_000)
              }
              break
            }
            case 'navigated': {
              // The model switched to a page that exists: that ENDS the turn
              // (no closing pass), so this is the turn's outcome.
              // "history:<index>" restores that exact moment (time travel).
              const histTarget = /^history:(\d+)$/.exec(update.page)
              if (histTarget) {
                if (restoreAt(Number(histTarget[1]), false)) {
                  completed = true
                  finishGauge()
                  setStatus('')
                } else {
                  failTurn(`navigate: no screen-history moment ${histTarget[1]}`, cacheKey)
                }
                break
              }
              const known = knownRef.current
              const shownNow = currentSpecRef.current
              const page = known ? resolvePageId(navRef.current, known.pages, update.page) : null
              if (!page || !shownNow) {
                failTurn(`navigate: unknown page "${update.page}"`, cacheKey)
                break
              }
              completed = true
              finishGauge()
              setStatus('')
              if (page === shownNow.page) {
                // The screen is already right — but a write this turn (Delete
                // on the list, then navigate to the list) changed its data.
                if (mutated) refreshAfterWrite(shownNow)
                break
              }
              const next = withKnownPages({ ...shownNow, page }, known)
              if (isEdit) {
                finalizeSpec(next, null)
                break
              }
              // An ordinary action → page answer: cached (and persisted) like
              // a rendered one when the turn ends, so the same press switches
              // instantly next time.
              if (landedAt === undefined) landedPress = takeAnswers()
              finalizeSpec(next, cacheKey, undefined, {
                cache: false,
                answers: landedPress,
                mutated,
                ...(landedAt !== undefined ? { replaceAt: landedAt } : {})
              })
              landedAt = session.index
              if (cacheKey) toCache = { key: cacheKey, spec: next, landed: page, edit: false }
              if (mutated) refreshAfterWrite(next)
              break
            }
            case 'error':
              failTurn(update.message, cacheKey)
              break
            case 'done':
              break
          }
        }
        // The turn is over: its screen is cached (and persisted, with the
        // responses it was built from) only now — `mutated` then covers a
        // write placed after the render as well. Never when the turn wrote
        // data, the press is not replayable, or the answer updated the
        // pressed page in place.
        if (toCache && turnSeq.current === myTurn && !abort.signal.aborted) {
          const done = toCache
          if (done.edit) {
            if (!mutated) void screensRef.current?.put(done.key, done.spec, turnDepsRef.current)
          } else if (
            cacheableAnswer({ replayable, mutated, from: landedPress?.from, landed: done.landed })
          ) {
            session.cacheSet(done.key, done.spec)
            void screensRef.current?.put(done.key, done.spec, turnDepsRef.current)
          }
        }
      } catch (err) {
        // An abort is a supersede/interrupt, never a user-visible failure.
        if (turnSeq.current === myTurn && !abort.signal.aborted) {
          failTurn((err as Error).message, cacheKey)
        }
      } finally {
        if (turnAbortRef.current === abort) turnAbortRef.current = null
        // Hand our messages back even when superseded: an already-executed
        // tool call must reach the next turn's history. Append-only, so a turn
        // that started meanwhile keeps whatever it pushed in the meantime.
        const mine = fork.slice(snapLen)
        if (mine.length && historyEpochRef.current === epoch) {
          historyRef.current.push(...mine)
          // Bound what the next turn re-sends: older screens become stubs and
          // whole old turns drop (a tool result never loses its call).
          historyRef.current = compactHistory(historyRef.current)
        }
        if (turnSeq.current === myTurn) {
          turnKindRef.current = null
          turnActiveRef.current = false
          turnActionRef.current = null
          setStreaming(false)
          setPreviewSpec(null)
          setPendingNav(null)
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
      finalizeSpec,
      finishGauge,
      invalidateAfterWrite,
      landEdit,
      llmCacheKey,
      logApi,
      prefetchForTurn,
      refreshAfterWrite,
      rememberApiSnapshot,
      reportApiResult,
      restoreAt,
      scheduleSchemaSave,
      session,
      startGauge
    ]
  )

  /* ------------------------- background pre-generation ------------------------- */

  /**
   * Stream one background build in an isolated scratch history — never the
   * user's conversation. Read-only: a build that tries to write is dropped
   * (the engine refuses the call; the result is never kept). Its tokens
   * count toward the session total, not the per-turn chip.
   */
  const streamScratch = useCallback(
    async (
      content: string,
      build: PregenBuild,
      preview: (spec: UiSpec) => void
    ): Promise<BuildResult> => {
      const deps: ScreenDeps = {}
      const fail: BuildResult = { spec: null, deps }
      const signal = build.controller.signal
      // Builds bind what the [data] sources hold: give missing ones a moment.
      await prefetchForTurn()
      if (signal.aborted) return fail
      const knownSchemas = bookFields(schemaBookRef.current)
      const prompts = buildSystemPrompts(domino, {
        loggedIn: loggedInRef.current,
        knownSchemas,
        dataSnapshots: dataSnapRef.current,
        pageMap: appMapLines(),
        feeds: feedsRef.current
      })
      const scratch: ChatMessage[] = [{ role: 'user', content }]
      let usageSeen = 0
      const api = apiRuntime()
      try {
        for await (const update of runAgentTurn({
          adapter: createAdapter(config),
          system: prompts.stable,
          systemDynamic: prompts.dynamic,
          history: scratch, // the engine appends to history: sharing would corrupt it
          api,
          knownSchemas,
          signal,
          cacheKey: llmCacheKey,
          readOnlyApi: true,
          // A predicted press may answer "that page exists": switch, no build.
          ...(build.kind === 'click'
            ? {
                knownPages: turnKnownPages(
                  knownRef.current,
                  navRef.current,
                  recordPagesRef.current,
                  false
                )
              }
            : {})
        })) {
          if (signal.aborted) return fail
          switch (update.type) {
            case 'spec':
              if (update.final) return { spec: update.spec, deps }
              preview(update.spec)
              break
            case 'api_result':
              // A build that tried to write is no answer to keep or replay.
              if (update.blocked) {
                build.controller.abort()
                return fail
              }
              // An expired session ends every build (the sign-out cancels
              // them); a build's other failures never move the user.
              if (reportApiResult(update.result, Boolean(api.token), false)) return fail
              if (update.schema) {
                schemaBookRef.current = rememberSchema(
                  schemaBookRef.current,
                  update.endpoint,
                  update.schema
                )
                deps[update.endpoint] = hashSchema(update.schema)
                scheduleSchemaSave()
              }
              // Results seed the {"$data": "api:…"} snapshots the built page
              // binds, so it shows real values the moment it is opened.
              rememberApiSnapshot(update.endpoint, update.result)
              break
            case 'usage': {
              const step = usageStep(usageSeen, update.usage)
              usageSeen = step.total
              if (step.add > 0) setUsageTotal((prev) => prev + step.add)
              break
            }
            case 'navigated': {
              const known = knownRef.current
              const page = known ? resolvePageId(navRef.current, known.pages, update.page) : null
              return {
                spec: build.kind === 'click' && known && page ? { ...known, page } : null,
                deps
              }
            }
            case 'error':
              return fail
          }
        }
      } catch {
        return fail // a failed background build just becomes a live-generating tap
      }
      return fail
    },
    [
      apiRuntime,
      appMapLines,
      config,
      domino,
      llmCacheKey,
      prefetchForTurn,
      rememberApiSnapshot,
      reportApiResult,
      scheduleSchemaSave
    ]
  )

  /**
   * A finished page build nobody adopted: merge it into what the runtime
   * knows — no session.push (no back-stack pollution), no showSpec (the
   * user's screen never flickers). A page the runtime already has is
   * canonical: a background guess never shadows it (mergeBuiltPage).
   */
  const mergeBackgroundPage = useCallback((pageId: string, result: BuildResult): boolean => {
    const base = knownRef.current
    if (!result.spec || !base) return false
    const merged = mergeBuiltPage(base, result.spec, pageId)
    if (!merged) return false
    knownRef.current = merged.spec
    setCurrentSpec((prev) => (prev ? mergeKnownPage(prev, merged.spec, merged.pageId) : prev))
    return true
  }, [])

  /**
   * A finished predicted press nobody adopted: its destination joins the
   * known pages (built ahead, so the real press can switch to it), but it is
   * NOT stored as that press's answer. The build ran read-only: a button
   * that writes on its first press ("Add to cart", "Place order") rendered
   * its result page without the write — replaying that would mean the first
   * real press never reaches the API. The real press runs a live turn, which
   * may then navigate to the built page cheaply; an answer that stays on the
   * button's page is an in-place data action and is dropped. No graph edge
   * is recorded: that happens when the user actually presses.
   */
  const storeClickBuild = useCallback(
    (fromPage: string, key: string, result: BuildResult): void => {
      const spec = result.spec
      if (!spec || spec.page === fromPage) return
      // Remembered (never replayed: no press looks this key up) so a restart
      // does not pre-build the same button again.
      void screensRef.current?.put(clickPregenMark(key), spec, result.deps)
      if (mergeBackgroundPage(spec.page, result)) {
        const after = knownRef.current
        if (after) {
          void screensRef.current?.saveView(loggedInRef.current, { page: after.page, known: after })
        }
      }
    },
    [mergeBackgroundPage]
  )

  const maybeRunPreGen = useCallback(
    async (seq: number): Promise<void> => {
      const stop = (): boolean => pregenSeq.current !== seq
      if (stop() || needsApiKey(config) || !knownRef.current) return
      const builds = pregenBuildsRef.current
      let builtCount = 0
      const targetsNow = (): string[] => {
        const known = knownRef.current
        return known
          ? pregenTargets(
              domino,
              known,
              loggedInRef.current,
              // Fresh read: a press during the batch may have observed a new page.
              observedDests(graphEdgesRef.current),
              pregenTriedRef.current
            )
          : []
      }

      // Pages first, a few in parallel: model latency overlaps instead of
      // adding up, without flooding the provider.
      await runPool(
        targetsNow(),
        PREGEN_CONCURRENCY,
        async (pageId) => {
          const known = knownRef.current
          if (stop() || !known) return
          // The user may have reached it meanwhile: a page the runtime knows
          // is canonical — a live render beats a background guess.
          if (resolvePageId(known.nav, known.pages, pageId) !== null) return
          pregenTriedRef.current.add(pageId)
          const build = builds.start(
            pageBuildKey(pageId),
            'page',
            pageId,
            (b, preview) => streamScratch(pregenPagePrompt(domino, pageId), b, preview),
            (result) => {
              if (!stop() && mergeBackgroundPage(pageId, result)) builtCount++
              return true
            }
          )
          await build.done
        },
        stop
      )

      // Then, once every page is warm, the main plain buttons' destinations,
      // so a first "New …" press is instant too. Read-only builds, never a
      // mutating control (pregenClickTargets), and a small budget: these are
      // guesses the user may never press.
      const signedOut = domino.auth.required && !loggedInRef.current
      const known = knownRef.current
      if (!stop() && !signedOut && known && targetsNow().length === 0) {
        const room = Math.min(
          MAX_CLICK_PREGEN_BATCH,
          MAX_CLICK_PREGEN_SESSION - clickTriedRef.current.size
        )
        const clicks = pregenClickTargets(
          known,
          graphEdgesRef.current,
          domino,
          MAX_CLICK_PREGEN_SESSION + clickTriedRef.current.size
        )
          .filter((c) => !clickTriedRef.current.has(c.nodeId))
          // A press on a record's page answers for that record only (never
          // replayed), and a button naming a built page switches by itself.
          .filter((c) => !recordPagesRef.current.has(c.pageId))
          .filter((c) => {
            const { node } = nodeContext({ ...known, page: c.pageId }, c.nodeId)
            const named = namedDestination(node, {
              known,
              nav: navRef.current,
              plan: plannedPages(domino),
              currentPage: c.pageId
            })
            return !named?.built
          })
          .slice(0, Math.max(0, room))
        await runPool(
          clicks,
          PREGEN_CONCURRENCY,
          async (c) => {
            if (stop()) return
            clickTriedRef.current.add(c.nodeId)
            // Exactly the key dispatchToAgent computes for this press.
            const key = actionCacheKey({ nodeId: c.nodeId, event: 'click' }, loggedInRef.current)
            if (
              session.cacheGet(key) ||
              screensRef.current?.get(key, schemaHashes()) ||
              screensRef.current?.get(clickPregenMark(key), schemaHashes())
            ) {
              return
            }
            const base = knownRef.current ?? known
            const build = builds.start(
              clickBuildKey(key),
              'click',
              c.pageId,
              (b, preview) => streamScratch(clickPregenPrompt(base, c), b, preview),
              (result) => {
                if (!stop()) storeClickBuild(c.pageId, key, result)
                return true
              }
            )
            await build.done
          },
          stop
        )
      }

      const after = knownRef.current
      if (stop() || !after) return
      // The view snapshot now carries the background pages too — reopening keeps them.
      if (builtCount > 0) {
        void screensRef.current?.saveView(loggedInRef.current, { page: after.page, known: after })
      }
      // Idle continuation: a run that made progress arms the next batch until
      // every target is warm; an all-failures run just re-arms on the next screen.
      pregenScheduled.current = false
      if (builtCount > 0 && targetsNow().length > 0) schedulePreGen()
    },
    [
      config,
      domino,
      mergeBackgroundPage,
      schedulePreGen,
      schemaHashes,
      session,
      storeClickBuild,
      streamScratch
    ]
  )
  pregenRunnerRef.current = maybeRunPreGen

  /* ------------------------------ boot flow ------------------------------ */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Every persisted piece loads at once — seven sequential storage reads
      // used to stand between opening a domino and its first screen.
      const [token, tokenWarn, book, snaps, edges, feeds, screens, vars, lastData] =
        await Promise.all([
          getToken(storage, domino.id),
          loadTokenWarn(storage),
          loadSchemaBook(storage, domino.id),
          loadApiSnaps(storage, domino.id),
          loadPageGraph(storage, domino.id),
          loadFeeds(storage, domino.id),
          // Screens and views built against another definition read as outdated.
          ScreenStore.open(storage, domino.id, { fingerprint, onPersistError }),
          loadSessionVars(storage, domino.id),
          loadDataSnaps(storage, domino.id, domino.data)
        ])
      if (cancelled) return
      sessionTokenRef.current = token
      // `skip_if_logged_in = false`: a stored session still signs in again —
      // the app opens signed out (its signed-out view, its login page).
      loggedInRef.current = Boolean(token) && !bootNeedsLogin(domino, Boolean(token))
      sessionVarsRef.current = loggedInRef.current ? vars : {}
      tokenWarnRef.current = tokenWarn
      schemaBookRef.current = book
      // Persisted endpoint bodies: a restored screen's {"$data": "api:…"}
      // bindings resolve against these before any new call happens — under
      // the `api:`-prefixed keys the bindings name (apiSnapsRef itself stays
      // keyed by the bare endpoint, as putApiSnap writes it).
      apiSnapsRef.current = snaps
      // Last-known [data] values too: bound cells show them at once, and each
      // source still refreshes behind (restored ≠ fetched this session). A
      // signed-out open of an app that requires sign-in shows none of them.
      const signedOutBoot = domino.auth.required && !loggedInRef.current
      dataSnapRef.current = {
        ...(signedOutBoot ? {} : lastData),
        ...apiSnapBindings(snaps),
        ...dataSnapRef.current
      }
      graphEdgesRef.current = edges
      // An export "with the app" seeds this device's action graph — what this
      // device observed itself always wins (mergeEmbeddedEdges).
      // Only an embed stamped with THIS definition is current: one exported
      // before the file was edited (or from an older build, unstamped) may
      // bind renamed keys or goto pages that no longer exist.
      const embedCurrent = Boolean(domino.screens && domino.screens.def === fingerprint)
      const embeddedGraph = (embedCurrent ? (domino.screens?.graph ?? []) : []) as GraphEdge[]
      if (embeddedGraph.length > 0) {
        const merged = mergeEmbeddedEdges(edges, embeddedGraph)
        if (merged.length !== edges.length) {
          graphEdgesRef.current = merged
          setGraphTick((t) => t + 1)
          void savePageGraph(storage, domino.id, merged)
        }
      }
      feedsRef.current = feeds
      screensRef.current = screens
      setDataSnap(dataSnapRef.current)
      // The [script] for this launch: its route picks the landing page below,
      // and its `call` (e.g. `call GET /me`) starts now, alongside.
      const bootOutcome = scriptEventOutcome(
        domino,
        undefined,
        sessionVarsRef.current,
        loggedInRef.current,
        null
      )
      // Started once the landing is decided: an expired token it meets then
      // signs out cleanly instead of racing the restore.
      const startBootCall = (): Promise<void> => runScriptCall(bootOutcome)
      // The stack rides along too: reopening lands on the very moment the
      // user left, not a one-entry stand-in. One stack per auth state —
      // signed-in screens never come back after sign-out — and a stack saved
      // against another definition is dropped. The pre-partition key is
      // adopted only where it cannot hold another auth state's screens.
      session.attach(storage, historyKey(domino.id, loggedInRef.current), {
        fingerprint,
        onPersistError,
        ...(domino.auth.required ? {} : { legacyKey: legacyHistoryKey(domino.id) })
      })
      // An app with sign-in can never adopt the pre-partition stack (it mixes
      // both auth states), and nothing else reads or evicts it: drop it once,
      // or its megabytes block every page, view and history write for good.
      if (domino.auth.required) {
        void storage.remove(legacyHistoryKey(domino.id)).catch(() => undefined)
      }

      // Reopen lands exactly where the app was left — restored, not
      // re-generated, and shown AT ONCE: [data] sources and bound endpoints
      // refresh behind it (bound cells update as each answer lands), so a
      // slow or dead backend never holds the restored screen.
      // A view saved against another definition is outdated: its pages may
      // call endpoints or show sections the file no longer has — regenerate.
      const view = await screens.loadView(loggedInRef.current)
      if (cancelled) return
      // Built against another definition: never shown as if current — the
      // app is rebuilt for the new file, and the user is told (and offered a
      // full rebuild that also forgets the old action graph).
      if (view?.stale) setDefChanged(true)
      if (view && !view.stale && findPage(view.known, view.page)) {
        // Live screen state rides in the snapshot: hydrate it BEFORE any
        // [data] fetch so `{stateKey}` interpolations (e.g. {rssUrl}) resolve
        // on this very session — without this the sources would stay unready
        // forever and a restored feed rendered empty.
        stateRef.current = { ...(view.known.state ?? {}) }
        pendingStateWrites.current = {}
        const restoredHistory = await session.load()
        if (cancelled) return
        if (restoredHistory && session.historySize > 0) {
          // The view and the stack are separate debounced writes: the view
          // (what was on screen) wins, and the stack moves to its moment —
          // Back/Forward continue from the screen actually shown.
          alignHistoryWithView(session, view)
          // Which record each reused page showed last (the view's copies are
          // the newest ones) — record pages stay record pages after a restart.
          knownRef.current = view.known
          navRef.current = view.known.nav ?? navRef.current
          recordPagesRef.current = recordPagesFromHistory(session.entries(), isNavPage)
          showSpec({ ...view.known, page: view.page })
          syncNav()
          schedulePreGen()
        } else {
          finalizeSpec({ ...view.known, page: view.page }, null)
        }
        void refreshAllSources()
        void startBootCall()
        return
      }

      // First open on this device of an export "with the app": the embedded
      // [screens] restore the whole thing — zero LLM calls, no BYOK needed
      // (a key only matters once the user edits or generates more). A local
      // view — this user's own progress — always wins over the embed. (Its
      // action graph was merged into the map above.)
      // The embedded pages are the signed-in app: a signed-out user of an
      // app that requires sign-in starts at the login path.
      const signedOut = domino.auth.required && !loggedInRef.current
      // An outdated embed is never seeded as current: say why the app is
      // being built, and generate it for the file as it is now.
      if (domino.screens && !embedCurrent) setDefChanged(true)
      if (
        domino.screens &&
        embedCurrent &&
        !signedOut &&
        findPage(domino.screens.spec, domino.screens.spec.page)
      ) {
        const embedded = domino.screens.spec
        stateRef.current = { ...(embedded.state ?? {}) }
        pendingStateWrites.current = {}
        // Seeded as this state's start screen: a later sign-in/out or a
        // reopen without a view lands on it instead of generating again.
        const seedKey = `init::${embedded.page}::auth:${loggedInRef.current}`
        void screens.put(seedKey, embedded)
        finalizeSpec(embedded, seedKey, 'start')
        void refreshAllSources()
        void startBootCall()
        return
      }

      const target = scriptLandingPage(domino, {
        loggedIn: loggedInRef.current,
        vars: sessionVarsRef.current
      })
      const cacheKey = `init::${target}::auth:${loggedInRef.current}`
      const cached = session.cacheGet(cacheKey)
      if (cached) {
        finalizeSpec(cached, cacheKey)
        void refreshAllSources()
        void startBootCall()
        return
      }
      // A screen an earlier session persisted — same deps check as events.
      const stored = screens.get(cacheKey, schemaHashes())
      if (stored) {
        session.cacheSet(cacheKey, stored.spec)
        finalizeSpec(withTargetPage(stored.spec, knownRef.current), cacheKey)
        void refreshAllSources()
        void startBootCall()
        return
      }
      // Only an outdated copy exists: say why the app is being built again.
      if (screens.get(cacheKey, schemaHashes(), { allowStale: true })?.stale) setDefChanged(true)
      // The script's call feeds the page the model is about to design.
      const bootLoggedIn = loggedInRef.current
      await settleWithin(startBootCall(), TURN_DATA_WAIT_MS)
      // Cancelled, or the call met an expired session (already signed out).
      if (cancelled || loggedInRef.current !== bootLoggedIn) return
      // A real first generation: runTurn waits (briefly) for the sources
      // that have no snapshot yet, so the first design binds real values.
      // "Logged in: no" on an app without sign-in nudges models into a login page.
      const auth = domino.auth.required ? ` Logged in: ${loggedInRef.current ? 'yes' : 'no'}.` : ''
      await runTurn(
        `INITIAL SCREEN.${auth} Show the "${target}" page following the screen patterns.`,
        cacheKey
      )
    })()
    // The counters are bumped (not snapshotted): the cleanup must orphan
    // whatever is in flight at unmount, which is exactly their live value.
    const turns = turnSeq
    const pregens = pregenSeq
    const builds = pregenBuildsRef.current
    return () => {
      cancelled = true
      turns.current++ // invalidate in-flight turns
      turnAbortRef.current?.abort() // …and stop their requests
      pregens.current++ // …and any background builds still running
      builds.cancelAll()
      editQueueRef.current = [] // …queued edits must not start new turns
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced writes (view, history, page table) land before the app goes
  // away — a phone backgrounding the app, a closed tab, an unmount.
  useEffect(() => {
    const flush = (): void => {
      void screensRef.current?.flush()
      void session.flush()
      if (dataSaveTimer.current !== null) {
        window.clearTimeout(dataSaveTimer.current)
        dataSaveTimer.current = null
        persistDataSnaps()
      }
      void flushStorage()
    }
    const off = onAppHidden(flush)
    // The desktop app waits for this before it quits or closes the window
    // (pagehide is too late there): every pending write, awaited.
    const offQuit = onQuitFlush(async () => {
      const writes: Array<Promise<unknown>> = [
        screensRef.current?.flush() ?? Promise.resolve(),
        session.flush()
      ]
      if (dataSaveTimer.current !== null) {
        window.clearTimeout(dataSaveTimer.current)
        dataSaveTimer.current = null
        writes.push(
          saveDataSnaps(
            storage,
            domino.id,
            persistableDataSnaps(dataSnapRef.current, domino.data),
            onPersistErrorRef.current ?? undefined
          )
        )
      }
      if (snapTimer.current !== null) {
        window.clearTimeout(snapTimer.current)
        snapTimer.current = null
        writes.push(saveApiSnaps(storage, domino.id, apiSnapsRef.current))
      }
      if (schemaTimer.current !== null) {
        window.clearTimeout(schemaTimer.current)
        schemaTimer.current = null
        writes.push(saveSchemaBook(storage, domino.id, schemaBookRef.current))
      }
      await Promise.all(writes)
    })
    // Quota relief never evicts the app that is open right now.
    const release = protectDomino(domino.id)
    return () => {
      off()
      offQuit()
      release()
      flush()
    }
  }, [domino.data, domino.id, persistDataSnaps, session, storage])

  /* --------------------------- [data] auto-refresh -------------------------- */
  // Sources declared `every Ns` poll while any known page binds them — the
  // live feel: fresh values appear on screen without touching the model.
  const polledKeys = useMemo(() => {
    if (!currentSpec) return ''
    const used = referencedDataKeys(currentSpec)
    // The nav bar may bind sources too (badges) even when this screen omits it.
    for (const key of navDataKeys(nav)) used.add(key)
    return domino.data
      .filter((d) => d.everySec && used.has(d.key))
      .map((d) => d.key)
      .join(',')
  }, [currentSpec, domino.data, nav])
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
  // and a list reverted after browsing back. The exception is a page reused
  // across records (one order-detail id for every order): the moment comes
  // back with ITS record (backView). Stacks are per auth state, so a
  // snapshot's own copy never crosses the sign-in boundary.
  const canonicalView = useCallback(
    (snap: {
      spec: UiSpec
      dataKey?: string
      recordLanding?: boolean
    }): { spec: UiSpec; keepCanonical?: string } => {
      const view = backView(snap, knownRef.current, recordPagesRef.current)
      // Another record's own copy is SHOWN, never made canonical: an edit
      // made to the page since stays in the known pages and the saved view,
      // and which record the canonical copy shows is unchanged.
      const canonical = knownRef.current ? findPage(knownRef.current, snap.spec.page) : null
      if (view.usedSnapshotCopy && canonical) {
        return { spec: view.spec, keepCanonical: snap.spec.page }
      }
      if (view.usedSnapshotCopy) {
        // A page the canonical set lacks (rebuilt away) comes back as the
        // snapshot's copy and becomes canonical again: with its record.
        const records = recordPagesRef.current
        if (snap.dataKey !== undefined && snap.recordLanding) records.set(snap.spec.page, snap.dataKey)
        else records.delete(snap.spec.page)
      }
      return { spec: view.spec }
    },
    []
  )

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
      const view = canonicalView(snap)
      showSpec(view.spec, view.keepCanonical ? { keepCanonical: view.keepCanonical } : undefined)
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
      const view = canonicalView(snap)
      showSpec(view.spec, view.keepCanonical ? { keepCanonical: view.keepCanonical } : undefined)
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

  /**
   * Cross the sign-in boundary (login succeeded, or signed out) without
   * losing either side's app. Each auth state keeps its own built pages
   * (the view snapshot), its own back stack and its own render cache:
   * leaving one parks it intact, entering the other restores what it had —
   * the signed-in app comes back after a login instead of being generated
   * again, and nothing signed-in stays reachable (Back, the cache) after a
   * sign-out. Only a state with nothing stored asks the model, once.
   */
  const enterAuthState = useCallback(
    async (loggedIn: boolean, event: 'login' | SignOutReason): Promise<void> => {
      // Requests of the side being left land into nothing from here on, and
      // this side's fetches never join one of them.
      authEpochRef.current++
      sourceInflightRef.current.clear()
      apiInflightRef.current.clear()
      cancelPreGen() // background builds were made for the other context
      interruptTurn()
      // The side being left: its pending view write lands before the switch.
      await screensRef.current?.flush()
      navRef.current = []
      knownRef.current = null
      recordPagesRef.current.clear()
      stateRef.current = {}
      pendingStateWrites.current = {}
      // The signed-in stack is not kept after sign-out: the next person on
      // this device must not walk Back into it.
      if (!loggedIn) await session.forget(historyKey(domino.id, true))
      // Switch stacks — this also drops renders cached for the other state.
      await session.rebind(historyKey(domino.id, loggedIn))
      recordPagesRef.current = recordPagesFromHistory(session.entries(), isNavPage)
      syncNav()
      // [script] decides where this side lands (`on logout -> goto login`,
      // `on auth_failed -> …`, `when plan == "pro" -> …`) and may call an
      // endpoint on the way (`on login -> call GET /me`).
      const state = {
        loggedIn,
        event,
        vars: sessionVarsRef.current,
        error: lastErrorRef.current
      }
      const outcome = scriptEventOutcome(domino, event, state.vars, loggedIn, state.error)
      const call = runScriptCall(outcome)
      const target = scriptLandingPage(domino, state)
      const prompt =
        event === 'login'
          ? `Authentication SUCCEEDED (token stored). Render the "${target}" page now.`
          : event === 'auth_failed'
            ? `The session EXPIRED (HTTP 401 — the token was cleared). Render the "${target}" page.`
            : `The user signed out. Render the "${target}" page.`
      const view = await screensRef.current?.loadView(loggedIn)
      if (view && !view.stale && findPage(view.known, view.page)) {
        knownRef.current = view.known
        stateRef.current = { ...(view.known.state ?? {}) }
        const landing = resolvePageId(view.known.nav ?? [], view.known.pages, target)
        if (landing) {
          const spec = { ...view.known, page: landing }
          if (session.current?.spec.page === landing) {
            showSpec(spec)
            syncNav()
            schedulePreGen()
          } else {
            finalizeSpec(spec, null, 'start')
          }
          void refreshAllSources()
          return
        }
        // The landing page was never built on this side: generate just that
        // one — every other page of this side stays known.
      }
      // Boot and the auth transition share one key per landing page and
      // auth state, so either reuses what the other generated.
      const key = `init::${target}::auth:${loggedIn}`
      const stored = screensRef.current?.get(key, schemaHashes())
      if (stored) {
        session.cacheSet(key, stored.spec)
        finalizeSpec(withTargetPage(stored.spec, knownRef.current), key)
        void refreshAllSources()
        return
      }
      await settleWithin(call, TURN_DATA_WAIT_MS)
      // The call met an expired token: that sign-out owns the screen now.
      if (loggedInRef.current !== loggedIn) return
      await runTurn(prompt, key)
    },
    [
      cancelPreGen,
      domino,
      finalizeSpec,
      interruptTurn,
      isNavPage,
      refreshAllSources,
      runScriptCall,
      runTurn,
      schedulePreGen,
      schemaHashes,
      session,
      showSpec,
      syncNav
    ]
  )

  // Login responses are small JSON; cap the read so a hostile or broken
  // endpoint can't stream an unbounded body into memory.
  const handleLogin = useCallback(
    async (data: Record<string, unknown>): Promise<void> => {
      // A second press while the first sign-in is in flight is the same request.
      if (loginBusyRef.current) return
      loginBusyRef.current = true
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
          // The response's non-secret fields (plan, role…) become [script]
          // variables, kept with the token across restarts.
          const vars = sessionVarsFromLogin(body, domino.auth.tokenKey)
          await Promise.all([
            setToken(storage, domino.id, token),
            saveSessionVars(storage, domino.id, vars).catch(() => undefined)
          ])
          sessionTokenRef.current = token
          loggedInRef.current = true
          sessionVarsRef.current = vars
          lastErrorRef.current = null // an expired session's error is history now
          historyRef.current.push({
            role: 'user',
            content: `ACTION submit from login/login data ${JSON.stringify(redact(data))}`
          })
          loginBusyRef.current = false
          setStreaming(false)
          // The signed-in app this device built before comes back as it was.
          await enterAuthState(true, 'login')
        } else {
          const msg =
            (body as { error?: string; message?: string } | null)?.error ??
            (body as { message?: string } | null)?.message ??
            `HTTP ${res.status}`
          historyRef.current.push({
            role: 'user',
            content: `ACTION submit from login/login → AUTH FAILED: ${msg}`
          })
          loginBusyRef.current = false
          setStreaming(false)
          await runTurn(
            `Login attempt FAILED (${msg}). Re-render the login page with an Alert explaining the failure (variant "danger"), preserving entered values where sensible.`,
            null
          )
        }
      } catch (err) {
        loginBusyRef.current = false
        setStreaming(false)
        setError(t('rt.loginFail', { msg: (err as Error).message }))
      }
    },
    [domino, enterAuthState, runTurn, storage]
  )

  /**
   * End the session — the user signed out, or the backend rejected the
   * token (401). The runtime owns the token, so it clears it itself, along
   * with everything the signed-in session fetched; [script] then decides
   * where the signed-out side lands (`on logout` / `on auth_failed`).
   */
  const signOut = useCallback(
    async (reason: SignOutReason): Promise<void> => {
      // Nothing may carry the token from here on — and no turn of the
      // signed-in app may land on the signed-out side, a background edit
      // included (the queue is dropped, the lane interrupted).
      // Requests still in flight with the old token answer into nothing: no
      // signed-in body is remembered, persisted or bound after this point.
      authEpochRef.current++
      loggedInRef.current = false
      sessionTokenRef.current = null
      editQueueRef.current = []
      setEditCount(0)
      clearEditHighlight()
      turnKindRef.current = null
      interruptTurn()
      lastErrorRef.current = reason === 'auth_failed' ? 'auth_failed' : null
      sessionVarsRef.current = {}
      await Promise.all([
        clearToken(storage, domino.id),
        clearSessionVars(storage, domino.id).catch(() => undefined)
      ])
      // Private data the signed-in session fetched goes with it: endpoint
      // bodies (persisted too), [data] snapshots and the conversation.
      apiSnapsRef.current = {}
      dataSnapRef.current = {}
      dataAtRef.current = {}
      apiFailedAtRef.current = {}
      setDataSnap({})
      // Later fetches start fresh, without the token — never joining (or
      // being outrun by) a signed-in request still in flight.
      sourceInflightRef.current.clear()
      apiInflightRef.current.clear()
      for (const key of Object.keys(sourceSeqRef.current)) sourceSeqRef.current[key]++
      if (snapTimer.current !== null) {
        window.clearTimeout(snapTimer.current)
        snapTimer.current = null
      }
      void saveApiSnaps(storage, domino.id, {})
      if (dataSaveTimer.current !== null) {
        window.clearTimeout(dataSaveTimer.current)
        dataSaveTimer.current = null
      }
      void saveDataSnaps(storage, domino.id, {})
      historyEpochRef.current++
      historyRef.current = [
        {
          role: 'user',
          content:
            reason === 'auth_failed'
              ? 'SESSION EXPIRED (HTTP 401 — the token was cleared)'
              : 'ACTION click from Button/logout → SIGNED OUT (token cleared)'
        }
      ]
      await enterAuthState(false, reason)
    },
    [clearEditHighlight, domino.id, enterAuthState, interruptTurn, storage]
  )

  /**
   * A request carrying the session token got a 401: the session expired.
   * Once per burst (every in-flight request may answer 401 at once) the
   * runtime signs out, says so, and lands where [script] routes
   * `auth_failed` (else the login page) — the model never sees the 401.
   */
  const handleAuthExpired = useCallback((): void => {
    if (authExpiringRef.current || !loggedInRef.current) return
    authExpiringRef.current = true
    armResultToast({ kind: 'notice', text: t('rt.authExpired'), target: null }, 6_000)
    void signOut('auth_failed').finally(() => {
      authExpiringRef.current = false
    })
  }, [armResultToast, signOut])
  authExpiredRef.current = handleAuthExpired

  /**
   * Show page `target` the fastest way the runtime has: a built page
   * switches at once; a start screen cached or stored for it replays; only
   * otherwise one turn builds it (after `ready`, e.g. the script call it
   * binds, has had a moment to land).
   */
  const landOn = useCallback(
    async (target: string, prompt: string, ready?: Promise<unknown>): Promise<void> => {
      const known = knownRef.current
      const cs = currentSpecRef.current
      const id = known ? resolvePageId(navRef.current, known.pages, target) : null
      if (id && cs) {
        interruptTurn()
        finalizeSpec(withKnownPages({ ...cs, page: id }, known), null)
        return
      }
      const key = `init::${target}::auth:${loggedInRef.current}`
      const cached = session.cacheGet(key)
      const stored = cached ? null : screensRef.current?.get(key, schemaHashes())
      const hit = cached ?? stored?.spec
      if (hit) {
        interruptTurn()
        if (stored) session.cacheSet(key, stored.spec)
        finalizeSpec(withTargetPage(hit, knownRef.current), key)
        return
      }
      if (ready) {
        const auth = loggedInRef.current
        await settleWithin(ready, TURN_DATA_WAIT_MS)
        // The call met an expired token: that sign-out owns the screen now.
        if (loggedInRef.current !== auth) return
      }
      await runTurn(prompt, key)
    },
    [finalizeSpec, interruptTurn, runTurn, schemaHashes, session]
  )

  /**
   * Carry out a [script] outcome fired by an event (a custom press, an API
   * error): run its call, then land on its route when it has one.
   */
  const routeByScript = useCallback(
    async (outcome: ScriptEventOutcome, target: string | null, why: string): Promise<void> => {
      const call = runScriptCall(outcome)
      if (!target) {
        await call
        return
      }
      await landOn(
        target,
        `The app's [script] routes to page "${target}" (${why}). Render the "${target}" page (use exactly that page id).`,
        call
      )
    },
    [landOn, runScriptCall]
  )

  /**
   * [script]'s `api_error`: a failed request sets `error` (the body's code,
   * else the status) and the rules it newly makes true may route — `when
   * error == "billing" -> goto upgrade`. The same route never re-fires
   * within a few seconds, so a destination that fails the same way can't loop.
   */
  const handleApiError = useCallback(
    (code: string): void => {
      lastErrorRef.current = code
      const outcome = scriptEventOutcome(
        domino,
        'api_error',
        sessionVarsRef.current,
        loggedInRef.current,
        code
      )
      const target = scriptRoute(outcome, currentSpecRef.current?.page ?? null)
      if (!target) return
      const now = Date.now()
      if (!allowErrorRoute(errorRouteRef.current, target, now)) return
      errorRouteRef.current = { target, at: now }
      void routeByScript(outcome, target, `a request failed with error "${code}"`).finally(() => {
        // Routed: the error that caused it is handled.
        if (lastErrorRef.current === code) lastErrorRef.current = null
      })
    },
    [domino, routeByScript]
  )
  apiErrorRef.current = handleApiError

  /**
   * Write client-side state locally: no history, no cache, no model turn —
   * and not through showSpec: a streaming preview stays up, nav and the
   * language check are untouched. The view snapshot keeps the overlay (the
   * store coalesces a burst of taps into one write).
   */
  const applyLocalState = useCallback(
    (key: string, value: unknown): void => {
      const next = { ...stateRef.current, [key]: value }
      stateRef.current = next
      pendingStateWrites.current[key] = value
      const cs = currentSpecRef.current
      if (cs) {
        const applied = { ...cs, state: next }
        currentSpecRef.current = applied
        // Functional: a background page merged this same tick must survive.
        setCurrentSpec((prev) => (prev ? { ...prev, state: next } : applied))
        const known = knownRef.current ? { ...knownRef.current, state: next } : applied
        knownRef.current = known
        void screensRef.current?.saveView(loggedInRef.current, { page: applied.page, known })
      }
      // [data] sources whose path reads this key re-query (debounced): a
      // filter, search box or pager bound to state refreshes its rows with
      // no model turn; only the newest answer lands (fetchSource).
      const timers = stateSourceTimers.current
      for (const source of sourcesReadingState(domino.data, key)) {
        const prev = timers.get(source)
        if (prev !== undefined) window.clearTimeout(prev)
        timers.set(
          source,
          window.setTimeout(() => {
            timers.delete(source)
            void fetchSource(source)
          }, STATE_SOURCE_DEBOUNCE_MS)
        )
      }
    },
    [domino.data, fetchSource]
  )

  /** A finished background build as the screen to show for an adopting tap. */
  const adoptedScreen = useCallback((build: PregenBuild, spec: UiSpec): UiSpec | null => {
    const known = knownRef.current
    if (build.kind === 'click') return withTargetPage(spec, known)
    if (!known) return spec
    const merged = mergeBuiltPage(known, spec, build.target)
    if (merged) return { ...merged.spec, page: merged.pageId }
    // Built meanwhile under another id (a live render won): show that one.
    const id = resolvePageId(known.nav ?? navRef.current, known.pages, build.target)
    return id ? { ...known, page: id } : null
  }, [])

  /**
   * The background build answering this press, if one is running: the
   * predicted press itself, or the page the press heads to (by id, or a tab
   * whose id drifted from the planned page's).
   */
  const findBuildFor = useCallback(
    (cacheKey: string, target: string | null): PregenBuild | null => {
      const builds = pregenBuildsRef.current
      const click = builds.get(clickBuildKey(cacheKey))
      if (click) return click
      if (!target) return null
      const direct = builds.get(pageBuildKey(target))
      if (direct) return direct
      const plan = plannedPages(domino)
      const stubs = builds
        .keys()
        .filter((k) => k.startsWith('page:'))
        .map((k) => k.slice('page:'.length))
        .map((id) => ({ id, name: plan.find((p) => p.id === id)?.name ?? id, layout: [] }))
      const id = resolvePageId(navRef.current, stubs, target)
      return id ? (builds.get(pageBuildKey(id)) ?? null) : null
    },
    [domino]
  )

  /**
   * The user tapped exactly what a background build is making: the live
   * lane takes it over instead of cancelling it and generating the same
   * screen from scratch. Its previews stream on screen and its result is
   * this press's answer. A later tap or interrupt supersedes the adoption
   * like any turn — the build then finishes in the background as before.
   */
  const adoptBuild = useCallback(
    (
      build: PregenBuild,
      cacheKey: string,
      prompt: string,
      opts: TurnOptions & { action: InflightAction },
      dest: PendingDestination | null
    ): boolean => {
      const builds = pregenBuildsRef.current
      if (builds.get(build.key) !== build || build.controller.signal.aborted) return false
      // Claim the lane exactly like a turn does.
      turnAbortRef.current?.abort()
      const lane = new AbortController()
      turnAbortRef.current = lane
      const myTurn = ++turnSeq.current
      turnKindRef.current = 'user'
      turnActiveRef.current = true
      turnActionRef.current = opts.action
      lastTurnRef.current = { prompt, cacheKey, page: currentSpecRef.current?.page ?? null, opts }
      clearEditHighlight()
      setStreaming(true)
      setError(null)
      setStatus(t('rt.generating'))
      startGauge()
      if (dest) {
        setPendingNav(dest)
        if (dest.navId) setActiveNav(dest.navId)
      }
      if (build.preview) {
        const first = build.preview
        startTransition(() => setPreviewSpec(first))
      }
      const adoption: Adoption = {
        onPreview: (spec) => {
          if (turnSeq.current === myTurn) startTransition(() => setPreviewSpec(spec))
        },
        onSettle: (result) => {
          // The user moved on: let it finish as an ordinary background build.
          if (turnSeq.current !== myTurn) return false
          const screen = result.spec ? adoptedScreen(build, result.spec) : null
          if (!screen) {
            // The build failed: the press still gets its answer, live.
            void runTurn(prompt, cacheKey, opts)
            return true
          }
          finishGauge()
          // Shown as this press's answer, but never cached for it and never
          // linked: the build ran read-only, so a press that writes on its
          // first use ("Add to cart") would never reach the API on a replay.
          // The next press runs live (the page is built, so it is cheap).
          // No `answers` either: an observed press→page edge would let the
          // next press auto-link past the API just the same.
          finalizeSpec(screen, cacheKey, undefined, { cache: false })
          if (turnAbortRef.current === lane) turnAbortRef.current = null
          turnKindRef.current = null
          turnActiveRef.current = false
          turnActionRef.current = null
          setStreaming(false)
          setStatus('')
          editDrainRef.current?.()
          return true
        }
      }
      builds.adopt(build.key, adoption)
      lane.signal.addEventListener('abort', () => builds.release(build, adoption), { once: true })
      return true
    },
    [adoptedScreen, clearEditHighlight, finalizeSpec, finishGauge, runTurn, startGauge]
  )

  /**
   * The ACTION → agent tail shared by every non-local event. planPress
   * decides first: a plain, read-only press whose destination is built
   * (observed edge, or a button naming the page) switches instantly; then a
   * replayable press may be answered from the cache or a stored screen;
   * then a running background build may be adopted; otherwise one turn —
   * guided by the declared, named or observed destination when known. The
   * press's answer (and its graph edge) travels with that turn only.
   */
  const dispatchToAgent = useCallback(
    (e: ActionEvent, pageId: string, declaredTarget?: string): void => {
      const known = knownRef.current
      const cs = currentSpecRef.current
      const plan = planPress({
        e,
        pageId,
        spec: cs,
        known,
        nav: navRef.current,
        plan: plannedPages(domino),
        edges: graphEdgesRef.current,
        recordPages: recordPagesRef.current,
        ...(declaredTarget ? { declaredTarget } : {})
      })
      if (plan.switchTo && cs) {
        // Instant: a plain link to a page that is already built.
        const edge = answerEdge(plan.answer, plan.switchTo, false)
        if (edge) recordGraphEdge(edge)
        interruptTurn()
        finalizeSpec(withKnownPages({ ...cs, page: plan.switchTo }, known), null)
        return
      }
      historyRef.current.push({
        role: 'user',
        content: `ACTION ${e.event} from ${e.nodeName}/${e.nodeId}${
          e.data ? ` data ${JSON.stringify(redact(e.data))}` : ''
        } (page "${pageId}")`
      })
      // Bound what long sessions re-send: old screens become stubs and whole
      // old turns drop — never a tool result without its call.
      historyRef.current = compactHistory(historyRef.current)

      // Page-free key: the same control (id + event + data) is the same action
      // wherever it sits, so every page's copy shares one cache slot — the
      // prompt's "one action, one id" contract, enforced here. Only presses
      // that just open a page read it (a submit, a Delete or a press on a
      // record's page must reach the API every time). A replay switches the
      // screen like any navigation: it interrupts the running user turn.
      // Partitioned by auth state: a signed-in answer never replays signed out.
      const cacheKey = actionCacheKey(e, loggedInRef.current)
      // A data-free press shows the destination's current (maybe edited)
      // copy; a data press its own record's copy (replayView).
      const plainReplay = plan.answer.dataKey === undefined
      if (plan.replayable) {
        const cached = session.cacheGet(cacheKey)
        if (cached) {
          interruptTurn()
          finalizeSpec(replayView(cached, knownRef.current, plainReplay), cacheKey, undefined, {
            answers: plan.answer
          })
          return
        }
        // Persisted across restarts — but only while every endpoint it embeds
        // still answers with the shape the screen was built on.
        const stored = screensRef.current?.get(cacheKey, schemaHashes())
        if (stored) {
          interruptTurn()
          session.cacheSet(cacheKey, stored.spec)
          finalizeSpec(
            replayView(stored.spec, knownRef.current, plainReplay),
            cacheKey,
            undefined,
            { answers: plan.answer }
          )
          return
        }
      }

      // Where this press heads, when that is known before the model answers:
      // the [actions] goto it declares, the tab it opens, the page the button
      // names, or the page the graph saw it land on.
      const guidedTo = plan.guidedTo
      const destination = guidedTo
        ? pendingDestination(guidedTo, {
            nav: navRef.current,
            known: knownRef.current,
            plan: plannedPages(domino)
          })
        : null
      const dest = destination && destination.pageId !== cs?.page ? destination : null
      const observed = !declaredTarget && guidedTo !== null && e.event !== 'navigate'
      const prompt = declaredTarget
        ? `The user acted on the current screen (see ACTION above). The app declares that this action opens page "${declaredTarget}" — render that page (use exactly that page id).`
        : observed
          ? `The user acted on the current screen (see ACTION above). This action leads to page "${guidedTo}" — render that page${
              plan.recordDependent ? ' for this press (fresh record/data)' : ''
            } (use exactly that page id; bind its known endpoints, call_api only for unknown ones or writes).`
          : `The user acted on the current screen (see ACTION above). Compute and render the next screen.`
      const opts: TurnOptions & { action: InflightAction } = {
        action: { nodeId: e.nodeId, event: e.event, pageId },
        answers: plan.answer,
        cache: plan.replayable,
        ...(declaredTarget ? { declaredPage: declaredTarget } : {}),
        // A record-dependent destination must be re-rendered for THIS press:
        // the model may only switch to record-independent pages.
        ...(plan.recordDependent
          ? {
              knownPages: turnKnownPages(
                knownRef.current,
                navRef.current,
                recordPagesRef.current,
                true
              )
            }
          : {})
      }
      // A background build is already making this answer: take it over
      // (builds are generic — only a press that just opens a page may).
      const build =
        plan.replayable && !plan.recordDependent
          ? findBuildFor(cacheKey, dest?.pageId ?? guidedTo)
          : null
      if (build && adoptBuild(build, cacheKey, prompt, opts, dest)) return
      // Show where the press goes right away: the destination's skeleton
      // (and its tab lit) instead of the old page for the first-token wait.
      if (dest) {
        setPendingNav(dest)
        if (dest.navId) setActiveNav(dest.navId)
      }
      void runTurn(prompt, cacheKey, opts)
    },
    [
      adoptBuild,
      domino,
      finalizeSpec,
      findBuildFor,
      interruptTurn,
      recordGraphEdge,
      runTurn,
      schemaHashes,
      session
    ]
  )

  /**
   * [actions]-bound widgets run entirely in the runtime — set state, call the
   * backend, refresh [data] sources, switch to a built page — with no model
   * turn. A goto for a page not built yet falls through to the agent with the
   * declared target (designed against the just-refreshed snapshot), so a
   * bound button can never dead-end.
   */
  const runBoundAction = useCallback(
    async (decl: ActionDecl, e: ActionEvent, pageId: string): Promise<void> => {
      const label = actionLabel(currentSpecRef.current, e.nodeId, e.nodeId)
      let gotoTarget: string | null = null
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
        } else if (step.kind === 'call') {
          // `call METHOD /path [with form]`: {form.x}/{row.x} from the press,
          // {key} from page state — a half-filled path never runs.
          const path = interpolateCallPath(step.path, { data: e.data, state: stateRef.current })
          if (!path) {
            armResultToast(
              { kind: 'notice', text: t('rt.callMissing', { path: step.path }), target: null },
              6_000
            )
            return
          }
          const api = apiRuntime()
          const result = await executeApi(api, {
            path,
            method: step.method,
            body: step.body === 'form' ? e.data : undefined
          })
          logApi(`${step.method} ${path}`, result.status, result.ms ?? 0)
          // An expired session signs out (and lands on the login side).
          if (reportApiResult(result, Boolean(api.token))) return
          if (step.method === 'GET') rememberApiSnapshot(endpointKey('GET', path), result)
          // A failed write stops the action, on the page as it is: later
          // steps would show a state the backend never reached, and a model
          // re-render would not make the write succeed. The user is told.
          if (result.status === 0 || result.status >= 400) {
            armResultToast(
              {
                kind: 'notice',
                text: t('rt.callFail', { status: result.status, path: `${step.method} ${path}` }),
                target: null
              },
              6_000
            )
            return
          }
          // A write landed: the lists it changed refetch (bound cells update).
          if (step.method !== 'GET') invalidateAfterWrite(path)
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
          gotoTarget = step.page
        }
      }
      if (gotoTarget === null) {
        // set/call/refresh only: the page stays; its bound props just got new data.
        recordGraphEdge({ from: pageId, to: pageId, action: e.nodeId, label, kind: 'data' })
        return
      }
      dispatchToAgent(e, pageId, gotoTarget)
    },
    [
      actionLabel,
      apiRuntime,
      applyLocalState,
      armResultToast,
      dispatchToAgent,
      fetchSource,
      finalizeSpec,
      interruptTurn,
      invalidateAfterWrite,
      logApi,
      recordGraphEdge,
      rememberApiSnapshot,
      reportApiResult
    ]
  )

  const handleEvent = useCallback(
    (e: ActionEvent): void => {
      // In-flight policy: a second press of the control whose turn is still
      // running is the same request (a double submit would write twice), and
      // a half-streamed NEW page is not pressable yet. Anything else
      // supersedes the running turn — the latest intent wins.
      if (
        shouldIgnorePress(e, {
          turnActive: turnActiveRef.current,
          turnKind: turnKindRef.current,
          turnAction: turnActionRef.current,
          previewPage: previewPageRef.current,
          currentPage: currentSpecRef.current?.page ?? null
        })
      ) {
        return
      }
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
            armResultToast(
              { kind: 'notice', text: '이미 구독 중인 피드입니다', target: null },
              4_000
            )
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
        void signOut('logout')
        return
      }

      // Back, and Cancel on a form page, step back in the runtime's own
      // history (a sheet closes) — no model round trip. With nothing behind
      // (a cold start) the press still reaches the model, never a dead button.
      // What the author declared wins: a control bound in [actions] or named
      // by a [script] rule ("send-back" returning a request) runs that, never
      // a history step that would silently skip its write.
      const declared =
        domino.actions.some((a) => a.id === e.nodeId) || pressScriptEvent(domino, e) !== null
      if (
        !declared &&
        dismissesPage(e, currentSpec) &&
        (sheetBehindIndex() >= 0 || session.canBack)
      ) {
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

      // A control whose id names a [script] `on <id>` rule fires that event:
      // its call runs and its route lands — no model turn when the
      // destination is built.
      const scriptEvent = pressScriptEvent(domino, e)
      if (scriptEvent) {
        const outcome = scriptEventOutcome(
          domino,
          scriptEvent,
          sessionVarsRef.current,
          loggedInRef.current,
          lastErrorRef.current
        )
        const routed = scriptRoute(outcome, currentSpec?.page ?? null)
        if (routed || outcome.call) {
          void routeByScript(outcome, routed, `the user pressed "${e.nodeId}"`)
          return
        }
      }

      // Pages the agent already delivered switch instantly, like a real app —
      // resolved through the nav↔page links, so a nav id that drifted from the
      // page id still lands on the stored page instead of asking the model to
      // draw it again ("yet another, different page"). Nav items, breadcrumbs
      // and in-app Links ("#page-id") all arrive as navigate.
      const target = e.event === 'navigate' ? String(e.data?.page ?? e.nodeId) : null
      // "history:<index>" (the agent restoring a moment) — same restore the
      // history panel runs; invalid indices are ignored.
      const histTarget = target ? /^history:(\d+)$/.exec(target) : null
      if (histTarget) {
        restoreAt(Number(histTarget[1]), true)
        return
      }
      // Resolved against everything the runtime knows — pages built in the
      // background included, even before they reached this render's spec.
      const knownPages = (knownRef.current ?? currentSpec)?.pages ?? []
      const resolved = target ? resolvePageId(navRef.current, knownPages, target) : null
      const navItem = target ? navRef.current.find((i) => i.id === target) : undefined
      if (resolved && currentSpec && resolved === currentSpec.page) {
        // Re-tapping where you already are never redraws the page: a running
        // turn heading elsewhere stops, a sheet on top closes, the page
        // scrolls to its top and only its live data refreshes.
        if (navItem) setActiveNav(navItem.id)
        if (turnActiveRef.current && turnKindRef.current === 'user') interruptTurn()
        if (sheetBehindIndex() >= 0) {
          goBack()
          return
        }
        document.querySelector('.runtime-body')?.scrollTo({ top: 0, behavior: 'smooth' })
        const used = referencedDataKeys(currentSpec)
        for (const d of domino.data) if (used.has(d.key)) void fetchSource(d.key)
        refreshApiBindingsRef.current?.(currentSpec)
        return
      }
      // A record page (one order-detail for every order) shows whichever
      // record was opened last: an in-app Link to it re-renders for this
      // press instead of switching to the stale record. The tabs are lists.
      const staleRecord = Boolean(
        resolved && e.nodeName !== 'nav' && recordPagesRef.current.has(resolved)
      )
      if (resolved && currentSpec && !staleRecord) {
        recordGraphEdge({
          from: pageId,
          to: resolved,
          action: e.nodeId,
          label: actionLabel(currentSpec, e.nodeId, target ?? e.nodeId),
          kind: e.nodeName === 'nav' ? 'nav' : 'action'
        })
        interruptTurn()
        finalizeSpec(withKnownPages({ ...currentSpec, page: resolved }, knownRef.current), null)
        return
      }
      if (navItem) setActiveNav(navItem.id)

      dispatchToAgent(e, pageId)
    },
    [
      actionLabel,
      applyLocalState,
      armResultToast,
      currentSpec,
      dispatchToAgent,
      domino,
      fetchSource,
      finalizeSpec,
      goBack,
      handleLogin,
      interruptTurn,
      recordGraphEdge,
      refreshSubscriptions,
      restoreAt,
      routeByScript,
      runBoundAction,
      runTurn,
      session,
      sheetBehindIndex,
      signOut,
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
      historyRef.current = compactHistory(historyRef.current)

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
      // History keeps only stubs of older screens: the page being edited
      // travels inline, as it stands right now.
      return await runTurn(editTurnPrompt(item.pageId, knownRef.current), cacheKey)
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
    cancelPreGen() // any background build targets pages that no longer exist
    setPendingNav(null)
    // The observed action graph described the old pages: a rebuilt button
    // reusing an id must not auto-link or steer the model by it.
    graphEdgesRef.current = []
    setGraphTick((t) => t + 1)
    void savePageGraph(storage, domino.id, [])
    recordPagesRef.current.clear()
    setError(null)
    setDefChanged(false)
    // The bodies stored call_api answers left behind fed the old pages'
    // bindings: they go too (memory, the bindable snapshots and storage) —
    // the rebuilt pages fetch what they bind.
    apiSnapsRef.current = {}
    dataSnapRef.current = Object.fromEntries(
      Object.entries(dataSnapRef.current).filter(([k]) => !k.startsWith('api:'))
    )
    setDataSnap(dataSnapRef.current)
    void saveApiSnaps(storage, domino.id, {})
    // schemaBookRef stays: API response shapes are unrelated to page tangles
    // and re-learning them would only cost extra calls.
    // Boot's opening move, unchanged: one turn draws the first page.
    const target = scriptLandingPage(domino, {
      loggedIn: loggedInRef.current,
      vars: sessionVarsRef.current
    })
    const auth = domino.auth.required ? ` Logged in: ${loggedInRef.current ? 'yes' : 'no'}.` : ''
    void runTurn(
      `INITIAL SCREEN.${auth} Show the "${target}" page following the screen patterns.`,
      `init::${target}::auth:${loggedInRef.current}`
    )
  }, [
    cancelPreGen,
    clearEditHighlight,
    clearResultToast,
    domino,
    interruptTurn,
    runTurn,
    session,
    storage,
    syncNav
  ])

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
          loaded.text ??
          (await getCachedText(storage, loaded.source)) ??
          (await loadDominoText(loaded.source))
        const link = `domino://${encodeURIComponent(loaded.name || 'app')}?c=${encodeURIComponent(text)}`
        await navigator.clipboard.writeText(link)
        armResultToast({ kind: 'notice', text: t('rt.shareDone'), target: null }, 5_000)
      } catch (err) {
        setError(t('rt.shareFail', { msg: (err as Error).message }))
      }
    })()
  }, [armResultToast, loaded, storage])

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
          // The text this app was parsed from — not the cached copy, which a
          // background revalidation may already have replaced with a newer
          // file the running screens were never built for.
          const text =
            loaded.text ??
            (await getCachedText(storage, loaded.source)) ??
            (await loadDominoText(loaded.source))
          if (!withScreens) {
            downloadDomino(text)
            return
          }
          const known = knownRef.current
          if (!known) return
          // The embed is stamped with the definition its screens were built
          // against; a text that no longer matches it would ship screens as
          // current for a file they do not fit.
          const parsed = parseDomino(text)
          if (!parsed.domino || dominoFingerprint(parsed.domino) !== fingerprint) {
            setError(t('rt.exportFail'))
            return
          }
          // A previous embed is replaced wholesale — the file always ships
          // the screens as they stand right now — and only the [screens]
          // section goes: [guide], [data], [actions] after it all stay.
          const out = withScreensSection(
            text,
            { spec: known, graph: graphEdgesRef.current, def: fingerprint },
            [
            `완성된 앱 포함 내보내기 — 페이지 ${known.pages.length}개와 액션 연결이 함께 저장됩니다.`,
            '이 파일을 여는 누구나 LLM 없이 그대로 앱을 실행할 수 있습니다.'
            ]
          )
          downloadDomino(out, '-app')
        } catch {
          setError(t('rt.exportFail'))
        }
      })()
    },
    [downloadDomino, fingerprint, loaded, storage]
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

  // File diagnostics show once per distinct set: dismissing the banner
  // remembers that set for this domino; an edited file shows its new ones.
  const warningsHash = useMemo(() => (warningsKey ? hashContext(warningsKey) : ''), [warningsKey])
  useEffect(() => {
    if (!warningsHash) return
    let live = true
    void storage
      .get(DIAG_SEEN_KEY)
      .then((raw) => {
        if (!live || !raw) return
        const seen = JSON.parse(raw) as Record<string, unknown>
        if (seen && seen[domino.id] === warningsHash) setWarningsSeen(warningsKey)
      })
      .catch(() => undefined) // unreadable: the banner simply shows again
    return () => {
      live = false
    }
  }, [domino.id, storage, warningsHash, warningsKey])
  const dismissWarnings = useCallback((): void => {
    setWarningsSeen(warningsKey)
    void (async () => {
      try {
        const raw = await storage.get(DIAG_SEEN_KEY)
        const parsed: unknown = raw ? JSON.parse(raw) : {}
        const seen =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
        delete seen[domino.id]
        // Newest last, bounded: a long list of opened files never grows the key.
        const next = Object.entries({ ...seen, [domino.id]: warningsHash }).slice(-DIAG_SEEN_MAX)
        await storage.set(DIAG_SEEN_KEY, JSON.stringify(Object.fromEntries(next)))
      } catch {
        /* not remembered: the banner shows again next open */
      }
    })()
  }, [domino.id, storage, warningsHash, warningsKey])
  const showWarnings = warningsKey !== '' && warningsSeen !== warningsKey

  // Budget guard: once per session, when cumulative tokens cross the
  // configured threshold, surface a dismissible warning — BYOK is real money.
  useEffect(() => {
    const limit = tokenWarnRef.current
    if (!tokenWarned && limit > 0 && usageTotal >= limit) setTokenWarned(true)
  }, [usageTotal, tokenWarned])

  /* -------------------------------- render -------------------------------- */
  const view = useMemo(() => {
    if (!previewSpec) return null
    const v = streamView(currentSpec, previewSpec)
    // Local writes made while the turn streams beat the preview's older
    // state — the same overlay finalizeSpec applies when the screen lands.
    const writes = pendingStateWrites.current
    return Object.keys(writes).length > 0
      ? { ...v, spec: { ...v.spec, state: { ...v.spec.state, ...writes } } }
      : v
  }, [currentSpec, previewSpec])
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
  // A screen still streaming already knows its name and navigation; a
  // destination known up front names itself before the first token.
  const title = (previewSpec && shownPage?.name) || pendingNav?.name || pageName
  // Heading to a page that is not built yet, and nothing streamed so far:
  // its skeleton stands in (inert) instead of the old, still-clickable page.
  const navPending = pendingNav !== null && !previewSpec && !sheetMode
  const pendingPage =
    navPending && knownRef.current ? (findPage(knownRef.current, pendingNav.pageId) ?? null) : null
  const rawNav = previewSpec?.nav?.length ? previewSpec.nav : nav
  // Bound badges ({"$data": …} / {"$state": …}) follow the live snapshots and
  // the screen state, like any bound prop — no model turn to update a count.
  const shownState = shown?.state
  const navItems = useMemo(
    () => resolveNavItems(rawNav, dataSnap, shownState),
    [rawNav, dataSnap, shownState]
  )
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

  // Android back / browser back closes the topmost runtime overlay before it
  // ever moves the page behind it (the newest registration wins, and each
  // registers when it opens).
  useBackHandler(menuOpen, () => {
    menuOpenRef.current = false
    setMenuOpen(false)
    setDevMenuOpen(false)
  })
  useBackHandler(editOpen, () => setEditOpen(false))
  useBackHandler(rebuildOpen, () => setRebuildOpen(false))
  useBackHandler(exportOpen, () => setExportOpen(false))
  useBackHandler(graphOpen, () => setGraphOpen(false))
  useBackHandler(paletteOpen, () => setPaletteOpen(false))
  useBackHandler(diagOpen, () => setDiagOpen(false))

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
    ...(loaded.warnings.length > 0
      ? [
          {
            key: 'diagnostics',
            label: t('rt.diagnostics'),
            icon: 'info',
            run: () => setDiagOpen(true)
          }
        ]
      : []),
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
                {loaded.warnings.length > 0 ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      menuOpenRef.current = false
                      setMenuOpen(false)
                      setDevMenuOpen(false)
                      setDiagOpen(true)
                    }}
                  >
                    <Icon name="info" />
                    {t('rt.diagnostics')} ({loaded.warnings.length})
                  </button>
                ) : null}
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

      {/* File diagnostics: every line the parser dropped or doubts while the
          file still opened — the developer's view of why something is missing. */}
      <Modal.Backdrop
        isOpen={diagOpen}
        onOpenChange={(o) => {
          if (!o) setDiagOpen(false)
        }}
        variant="blur"
      >
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog aria-label={t('rt.diagnostics')}>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{t('rt.diagnostics')}</Modal.Heading>
              <p className="text-sm text-muted">{t('rt.diagnosticsDesc')}</p>
            </Modal.Header>
            <Modal.Body>
              <ul className="flex flex-col gap-1 text-sm">
                {loaded.warnings.map((w, i) => (
                  <li key={`${w.line}-${i}`} className="font-mono text-xs">
                    {t('load.parseLine', { line: w.line, msg: w.message })}
                  </li>
                ))}
              </ul>
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
          {defChanged ? (
            <div className="runtime-banner">
              <Alert
                variant="warning"
                title={t('rt.defChangedTitle')}
                message={t('rt.defChangedBody')}
                action={{
                  label: t('rt.rebuild'),
                  onPress: () => {
                    setDefChanged(false)
                    setRebuildOpen(true)
                  }
                }}
                onClose={() => setDefChanged(false)}
              />
            </div>
          ) : null}
          {showWarnings ? (
            <div className="runtime-banner">
              <Alert
                variant="warning"
                title={t('rt.warnTitle', { n: loaded.warnings.length })}
                message={t('load.parseLine', {
                  line: loaded.warnings[0].line,
                  msg: loaded.warnings[0].message
                })}
                action={{ label: t('rt.warnShow'), onPress: () => setDiagOpen(true) }}
                onClose={dismissWarnings}
              />
            </div>
          ) : null}
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
                  // Retry re-runs the failed request from the page it was
                  // asked on — from any other page it would answer the wrong screen.
                  lastTurnRef.current && lastTurnRef.current.page === (currentSpec?.page ?? null)
                    ? {
                        label: t('rt.retry'),
                        onPress: () => {
                          const last = lastTurnRef.current
                          if (last) void runTurn(last.prompt, last.cacheKey, last.opts)
                        }
                      }
                    : undefined
                }
                onClose={() => setError(null)}
              />
            </div>
          ) : null}
          {navPending ? (
            <PageSkeleton
              page={pendingPage}
              title={pendingNav.name}
              density={domino.ui.density}
              chrome={chrome}
              label={t('rt.composing')}
            />
          ) : bodyPage && bodySpec ? (
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

// Deep: form data nests (data.user.password) and secret keys come in more
// spellings than the top level alone (pwd, pin, credential…). Depth-capped so
// a pathological payload can't blow the stack; over-redacting is safe.
// `pw` and the Korean words for password (비밀번호, 암호) too: a field named
// after its id or label must never carry a plaintext password to the model.
/**
 * The ScreenStore key a finished click pre-generation is remembered under:
 * a different key than the press's own, so it is never replayed as that
 * press's answer (the build ran read-only), only consulted to skip
 * building the same button again.
 */
function clickPregenMark(pressKey: string): string {
  return `pregen-click::${pressKey}`
}

const REDACT_KEY = /pass|pwd|(?:^|[^a-z])pw(?:$|[^a-z])|secret|token|key|pin|credential|auth|비밀번호|암호/i

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
