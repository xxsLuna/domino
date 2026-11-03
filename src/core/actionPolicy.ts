import type { CardNode } from './spec'
import type { GraphEdge } from './pageGraph'

/**
 * actionPolicy — which presses may skip the model.
 *
 * The runtime has three shortcuts past an LLM turn: replaying a cached screen
 * for an identical event, auto-linking a press to the page an earlier press
 * landed on, and pre-generating a button's destination in the background.
 * All three are only correct for presses that DON'T DO anything besides
 * showing another screen. A Delete, Approve, Save or Refresh replayed from a
 * cache never reaches the backend: the button works once and then silently
 * stops working — for the rest of the session and, through the persisted
 * graph, after restarts. Everything here leans conservative: a false
 * "mutating" costs one LLM turn, a false "plain" breaks the app.
 */

/**
 * Words that mark a control as doing something (writing, deleting, sending,
 * re-fetching, signing out) rather than opening a page. Matched as whole
 * id/text tokens, so `saved-items` or `refreshments` stay plain.
 */
const MUTATING_WORDS = new Set([
  'delete',
  'del',
  'remove',
  'rm',
  'destroy',
  'trash',
  'erase',
  'purge',
  'clear',
  'reset',
  'save',
  'submit',
  'archive',
  'unarchive',
  'approve',
  'reject',
  'decline',
  'deny',
  'send',
  'resend',
  'complete',
  'done',
  'finish',
  'mark',
  'refresh',
  'reload',
  'sync',
  'resync',
  'logout',
  'signout',
  'publish',
  'unpublish',
  'confirm',
  'pay',
  'purchase',
  'checkout',
  'toggle',
  'enable',
  'disable',
  'activate',
  'deactivate',
  'restore',
  'undo',
  'retry',
  'follow',
  'unfollow',
  'like',
  'unlike',
  'subscribe',
  'unsubscribe',
  'upload',
  'import',
  'assign',
  'unassign',
  'close',
  'reopen',
  'accept',
  // Actions that create or start something on the spot: their first press
  // must reach the API. `order` itself is left out — `order-detail` /
  // `view-order` open pages.
  'buy',
  'place',
  'leave',
  'stop',
  'run',
  'execute',
  'duplicate',
  'clone',
  'copy',
  'generate',
  'transfer',
  'vote',
  'rate',
  'claim',
  'redeem'
])

/**
 * Verbs that either act on the spot ("Add to cart", "Join") or merely open
 * the page where that happens ("Add item" → an entry form). Neither the
 * words, a `to`, nor one observed answer can tell which for the next press
 * (already joined, job already running…), so they count as mutating like
 * MUTATING_WORDS. Two model signals together let one link anyway: the
 * button declares its page (`to`) and a press was answered by a pure switch
 * to exactly that page (see canAutoLink). An app that knows a button only
 * opens a page can also declare it in [actions] (`add-item = goto item_add`).
 */
const OPENER_WORDS = new Set([
  'add',
  'create',
  'book',
  'reserve',
  'join',
  'start',
  'invite',
  'apply',
  'enroll',
  'register'
])

/**
 * The same verbs in Korean (substring match — Korean labels glue particles
 * onto the stem: "삭제하기", "저장됨").
 */
const MUTATING_KO = [
  '삭제',
  '제거',
  '지우기',
  '초기화',
  '저장',
  '제출',
  '보관',
  '승인',
  '거절',
  '반려',
  '보내기',
  '전송',
  '발송',
  '완료',
  '읽음',
  '새로고침',
  '새로 고침',
  '갱신',
  '동기화',
  '로그아웃',
  '게시',
  '결제',
  '구매',
  '확정',
  '활성화',
  '비활성화',
  '복원',
  '취소하기',
  '구독하기',
  '업로드',
  '가져오기',
  '주문하기',
  '복제',
  '실행'
]

/** OPENER_WORDS in Korean ("품목 추가" opens the entry form; "장바구니에 추가" adds on the spot). */
const OPENER_KO = ['추가', '생성', '예약', '참여', '가입', '초대', '시작', '신청']

/** kebab/snake/camel/space-separated words, lowercased; adjacent pairs joined too ("log-out" → "logout"). */
function words(raw: string): string[] {
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const joined = parts.slice(1).map((p, i) => parts[i] + p)
  return [...parts, ...joined]
}

function hasWord(raw: unknown, en: ReadonlySet<string>, ko: readonly string[]): boolean {
  if (typeof raw !== 'string' || !raw) return false
  if (words(raw).some((w) => en.has(w))) return true
  return ko.some((k) => raw.includes(k))
}

/** Whether the control's id, text, label or title names one of the verbs. */
function namesVerb(node: CardNode, en: ReadonlySet<string>, ko: readonly string[]): boolean {
  const props = node.props ?? {}
  return [node.id, props.text, props.label, props.title].some((raw) => hasWord(raw, en, ko))
}

/**
 * How a press on this control is treated:
 * - `mutating` — a Form (its press is a submit), a submit-type button,
 *   `inForm` (every press there carries field values), a danger variant, a
 *   `confirm` prompt, a local `stateKey` stepper, or a verb that always acts
 *   (delete, save, approve, refresh, sign-out… — see MUTATING_WORDS);
 * - `opener` — otherwise plain, but named with a verb that may act or may
 *   only open a page (add, create, join… — see OPENER_WORDS);
 * - `plain` — everything else.
 */
function classify(node: CardNode, ctx?: { inForm?: boolean }): 'mutating' | 'opener' | 'plain' {
  if (ctx?.inForm) return 'mutating'
  if (node.name === 'Form') return 'mutating'
  const props = node.props ?? {}
  if (props.type === 'submit') return 'mutating'
  if (typeof props.variant === 'string' && /danger/i.test(props.variant)) return 'mutating'
  if (props.confirm !== undefined && props.confirm !== null && props.confirm !== false)
    return 'mutating'
  if (typeof props.stateKey === 'string' && props.stateKey) return 'mutating'
  if (namesVerb(node, MUTATING_WORDS, MUTATING_KO)) return 'mutating'
  return namesVerb(node, OPENER_WORDS, OPENER_KO) ? 'opener' : 'plain'
}

/**
 * The page id a Button/Link `to` names, decorations (`#/`, `page:`)
 * stripped; null when it names none.
 */
export function declaredPageLink(node: CardNode | null | undefined): string | null {
  if (!node || (node.name !== 'Button' && node.name !== 'Link')) return null
  const to = node.props?.to
  if (typeof to !== 'string') return null
  const target = to
    .trim()
    .replace(/^(?:#\/?|page:)/, '')
    .trim()
  return target || null
}

/**
 * Whether pressing this control may change data (or session state), so its
 * result must never be replayed, auto-linked or pre-generated.
 *
 * Mutating when any of: a Form (its press is a submit), a submit-type button,
 * `inForm` (the caller knows the node sits inside a Form — every press there
 * carries field values), a danger variant, a `confirm` prompt, a local
 * `stateKey` stepper (handled by the runtime, never a page link), or an
 * id/text/label naming a mutating verb (delete, save, approve, refresh,
 * sign-out, add, create… — see MUTATING_WORDS and OPENER_WORDS).
 */
export function isMutatingControl(
  node: CardNode | null | undefined,
  ctx?: { inForm?: boolean }
): boolean {
  if (!node) return false
  return classify(node, ctx) !== 'plain'
}

/**
 * Whether an event's resulting screen may be served from the screen cache.
 *
 * Only pure navigation qualifies: `navigate` (nav, breadcrumbs, internal
 * links), a `click` with no payload, and a row/item `select` (the cached
 * layout is reused; its bound data still re-fetches). `submit`, `search`,
 * `page` and `change` carry a query or a write — they must reach the API
 * fresh every time. A click that carries data is a per-record action.
 */
export function isReplayableEvent(e: { event: string; data?: Record<string, unknown> }): boolean {
  if (e.event === 'navigate' || e.event === 'select') return true
  if (e.event === 'click') return !e.data || Object.keys(e.data).length === 0
  return false
}

/**
 * Whether a press may jump straight to an observed edge's destination with
 * no model turn: the edge must lead to a DIFFERENT page (a self-loop means
 * the press updated the page in place — replaying it would freeze the
 * button), be a plain action/nav link (not a form submit, data refresh or
 * state change), and the control itself must not mutate anything. An
 * unknown widget (null) only links through nav edges — the tab bar is
 * navigation by definition.
 *
 * An opener ("품목 추가", "Add") links only along a learned edge (`reused`)
 * to `learnable`: the built page its own `to` names right now, given only
 * while the press has never been seen writing (see planPress). An edge
 * alone is never enough — graphs from older builds recorded writes as plain
 * links — and an edit that drops or changes the `to` drops the link.
 */
export function canAutoLink(
  edge: Pick<GraphEdge, 'to' | 'kind' | 'reused'> | null | undefined,
  node: CardNode | null | undefined,
  fromPage: string,
  learnable?: string | null
): boolean {
  if (!edge || !edge.to || edge.to === fromPage) return false
  if (edge.kind !== 'action' && edge.kind !== 'nav') return false
  if (!node) return edge.kind === 'nav'
  if (!isMutatingControl(node)) return true
  return (
    isOpenerControl(node) &&
    edge.kind === 'action' &&
    edge.reused === true &&
    Boolean(learnable) &&
    edge.to === learnable
  )
}

/**
 * Whether the control is mutating ONLY because of an opener verb ("품목
 * 추가", "Add", "Join"): no structural signal, no verb that always acts.
 * Such a press may just open a built page — the runtime still can't know,
 * so it asks the model to reuse that page rather than design it again.
 */
export function isOpenerControl(
  node: CardNode | null | undefined,
  ctx?: { inForm?: boolean }
): boolean {
  return node ? classify(node, ctx) === 'opener' : false
}
