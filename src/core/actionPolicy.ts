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
  // Actions that create or start something (an item in a cart, an order, a
  // booking, a membership, a job): their first press must reach the API.
  // `order` itself is left out — `order-detail` / `view-order` open pages.
  'add',
  'create',
  'buy',
  'place',
  'book',
  'reserve',
  'join',
  'leave',
  'start',
  'stop',
  'run',
  'execute',
  'invite',
  'duplicate',
  'clone',
  'copy',
  'apply',
  'generate',
  'transfer',
  'vote',
  'rate',
  'claim',
  'redeem',
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
  '추가',
  '생성',
  '주문하기',
  '예약',
  '참여',
  '가입',
  '초대',
  '복제',
  '실행',
  '시작',
  '신청'
]

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

function hasMutatingWord(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  if (words(raw).some((w) => MUTATING_WORDS.has(w))) return true
  return MUTATING_KO.some((k) => raw.includes(k))
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
 * sign-out… — see MUTATING_WORDS).
 */
export function isMutatingControl(
  node: CardNode | null | undefined,
  ctx?: { inForm?: boolean }
): boolean {
  if (!node) return false
  if (ctx?.inForm) return true
  if (node.name === 'Form') return true
  const props = node.props ?? {}
  if (props.type === 'submit') return true
  if (typeof props.variant === 'string' && /danger/i.test(props.variant)) return true
  if (props.confirm !== undefined && props.confirm !== null && props.confirm !== false) return true
  if (typeof props.stateKey === 'string' && props.stateKey) return true
  return (
    hasMutatingWord(node.id) ||
    hasMutatingWord(props.text) ||
    hasMutatingWord(props.label) ||
    hasMutatingWord(props.title)
  )
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
 */
export function canAutoLink(
  edge: Pick<GraphEdge, 'to' | 'kind'> | null | undefined,
  node: CardNode | null | undefined,
  fromPage: string
): boolean {
  if (!edge || !edge.to || edge.to === fromPage) return false
  if (edge.kind !== 'action' && edge.kind !== 'nav') return false
  if (!node) return edge.kind === 'nav'
  return !isMutatingControl(node)
}
