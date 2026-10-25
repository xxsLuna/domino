/**
 * LiveRSS demo backend — feeds addressed by `?url=<rss url>`, normalized to
 * List-ready items, kept live for the mobile-UX test.
 *
 *   GET  /feed?url=<enc>  → { feed, items } — tries the REAL RSS at that url
 *        (5s timeout), then keeps it alive: newly arrived real items are
 *        detected, and when a quiet feed would show nothing the server adds
 *        clearly-marked demo items so the stack visibly grows. Without ?url
 *        a standalone simulated feed answers (the app supplies it from the
 *        [rssUrl] state once the user types an address).
 *   GET  /rss.domino      → the LiveRSS definition (input → live feed)
 *   GET  /stats           → counters
 *
 * Run: node samples/rss-demo.mjs   (port 8788, or PORT=…)
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8788)
const NEW_WINDOW_MS = 90_000
const SIM_INTERVAL_MS = Number(process.env.FEED_INTERVAL_MS ?? 20_000)
const REAL_RECHECK_MS = 60_000
const FETCH_TIMEOUT_MS = 5_000
const MAX_ITEMS = 60
const SIM_ONLY = process.env.SIM_LIVE === '0' // SIM_LIVE=0: never invent items

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
}

const HEADLINES = [
  'DOM 기반 UI 런타임, 브라우저에서 앱을 다시 그리다',
  '온디바이스 LLM 추론 속도, 1년 새 3배 빨라졌다',
  '국내 스타트업, AI 에이전트 시장서 400억 시리즈B 유치',
  '웹 컴포넌트가 부활하는 이유 — 프레임워크 피로의 시대',
  '모바일 UX 설문: 하단 탭바가 여전히 가장 빠르다',
  'SSE 스트리밍으로 실시간 대시보드 만들기',
  '로컬 퍼스트 앱의 귀환: 오프라인이 기본값인 시대',
  '보안 감사 보고서, 브라우저 저장소 암호화 표준 제안',
  '엣지 컴퓨팅, RSS 재조명 — 폴링은 단순하게',
  '접근성 심사 기준 2026, 터치 타깃 최소 44px 고정'
]

const stats = { served: 0, realFetches: 0, feeds: 0, sim: 0 }

/* ------------------------------- feed sessions ------------------------------ */

/** url → { title, items, seen, firstSeen, fetchedAt, lastArrival } */
const sessions = new Map()
let simSeq = 0

const stripTags = (s) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

/** Pull <title>/<link>/<pubDate>… out of one <item> or <entry> block. */
function parseEntry(block) {
  const pickTag = (name) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)
    if (!m) return ''
    return decode(stripTags(m[1])).trim()
  }
  const title = pickTag('title')
  if (!title) return null
  const linkTag = /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block) ?? /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block)
  const url = linkTag ? decode(stripTags(linkTag[1] || linkTag[0])).trim() : ''
  const dateRaw = pickTag('pubDate') || pickTag('published') || pickTag('updated') || pickTag('date')
  const summary = pickTag('description') || pickTag('summary') || pickTag('content')
  return { title, url, dateRaw, summary }
}

async function fetchRealFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const xml = await res.text()
  const feedTitle = (() => {
    const head = xml.slice(0, 4000)
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
    return m ? decode(stripTags(m[1])).trim() : ''
  })()
  const entries = []
  for (const m of xml.matchAll(/<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const e = parseEntry(m[2])
    if (e) entries.push(e)
    if (entries.length >= 40) break
  }
  return { feedTitle: feedTitle || new URL(url).hostname, entries }
}

/** Readiness snapshot: newest first, List-prop-ready, isNew per arrival age. */
function itemsFor(session) {
  const now = Date.now()
  return session.items.map((it) => ({
    id: it.id,
    title: it.title,
    description: it.description,
    url: it.url,
    source: it.source,
    publishedAt: new Date(it.arrivedAt).toISOString(),
    isNew: now - it.arrivedAt < NEW_WINDOW_MS,
    ...(now - it.arrivedAt < NEW_WINDOW_MS ? { badge: 'NEW', badgeVariant: 'success' } : {})
  }))
}

function makeSimItem() {
  simSeq += 1
  const title = HEADLINES[(simSeq - 1) % HEADLINES.length]
  return {
    id: `sim-${simSeq}`,
    title: `[데모 실시간] ${title}`,
    description: `LiveRSS 데모 · ${new Date().toTimeString().slice(0, 5)} — 서버가 새로 도착한 기사를 시뮬레이션한 항목입니다 (#${simSeq}).`,
    url: `https://example.test/articles/${simSeq}`,
    source: 'LiveRSS 데모',
    arrivedAt: Date.now(),
    demo: true
  }
}

async function sessionFor(rawUrl) {
  const key = rawUrl || '(default)'
  let s = sessions.get(key)
  if (!s) {
    stats.feeds += 1
    s = { url: rawUrl, title: '', items: [], seen: new Set(), fetchedAt: 0, lastArrival: 0, simSeq0: simSeq }
    sessions.set(key, s)
  }
  const now = Date.now()

  // Real RSS: fetch on first use, then re-check for arrivals every minute.
  if (rawUrl && (s.fetchedAt === 0 || now - s.fetchedAt > REAL_RECHECK_MS)) {
    s.fetchedAt = now
    try {
      const { feedTitle, entries } = await fetchRealFeed(rawUrl)
      stats.realFetches += 1
      s.title = feedTitle
      let added = 0
      for (const e of entries) {
        const id = e.url || `${e.title}`
        if (s.seen.has(id)) continue
        s.seen.add(id)
        const arrivedAt = e.dateRaw ? Date.parse(e.dateRaw) || now : now
        const time = new Date(arrivedAt).toTimeString().slice(0, 5)
        s.items.unshift({
          id: `r-${s.seen.size}-${simSeq + added}`,
          title: e.title,
          description: `${s.title} · ${time}${e.summary ? ` — ${e.summary.slice(0, 180)}` : ''}`,
          url: e.url,
          source: s.title,
          arrivedAt
        })
        added += 1
        s.lastArrival = now
      }
      if (added > 0) s.items.sort((a, b) => b.arrivedAt - a.arrivedAt)
    } catch {
      // offline / blocked / not rss — fall through to simulation only
      s.title = s.title || ''
    }
  }
  if (!s.title) s.title = rawUrl ? `${new URL(rawUrl).hostname} (도달 실패·데모)` : 'LiveRSS 데모 피드'

  // Keep the feed visibly live: one demo arrival per SIM_INTERVAL when the
  // real feed produced nothing (clearly marked — this is a UX test backend).
  if (!SIM_ONLY && (s.lastArrival === 0 || now - s.lastArrival > SIM_INTERVAL_MS)) {
    s.items.unshift(makeSimItem())
    s.lastArrival = now
    stats.sim += 1
    if (s.items.length > MAX_ITEMS) s.items.length = MAX_ITEMS
  }
  return s
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cors })
  res.end(JSON.stringify(body))
}

/* --------------------------------- server --------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  if (url.pathname === '/feed' && req.method === 'GET') {
    stats.served += 1
    const rawUrl = (url.searchParams.get('url') ?? '').trim()
    try {
      const session = await sessionFor(rawUrl)
      return json(res, 200, {
        feed: {
          title: session.title,
          url: session.url || null,
          updated: new Date().toISOString(),
          count: session.items.length
        },
        items: itemsFor(session)
      })
    } catch (err) {
      return json(res, 500, { error: String(err) })
    }
  }

  if (url.pathname === '/rss.domino' && req.method === 'GET') {
    const origin = `http://127.0.0.1:${PORT}`
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...cors })
    res.end(
      [
        '; LiveRSS — 주소를 입력하면 그 RSS가 실시간으로 갱신되는 구독 뷰어 (모바일 UX 테스트).',
        '[meta]',
        'name = LiveRSS',
        'description = 원하는 RSS 주소를 입력하면 실시간으로 갱신되는 뉴스 구독 앱',
        'home = main',
        '[api]',
        `base_url = ${origin}`,
        'allow = /feed, /feed/*',
        '[ui]',
        'theme = auto',
        'primary = #e11d48',
        'density = compact',
        '[script]',
        'when not logged_in -> goto main',
        '[data]',
        'feed = GET /feed?url={rssUrl} every 20s',
        '[actions]',
        'add-feed-form = set rssUrl = form.url ; refresh feed ; goto feed',
        'feed-refresh = refresh feed',
        '[guide]',
        '실시간 RSS 구독 뷰어다. 앱은 RSS 내용을 미리 가지고 있지 않다 — 사용자가 원하는 RSS 주소를 입력하면 그 주소의 피드가 20초마다 실시간으로 갱신된다.',
        '',
        '페이지 구성:',
        '- main (홈): 구독 추가 화면. Form(id 는 정확히 "add-feed-form") 안에 Input(name="url", type="url", label="RSS 주소", placeholder="https://example.com/feed.xml")를 두고, primary 제출 Button(text="구독 시작")을 Form의 마지막 자식으로 둔다. 아직 구독 전이므로 EmptyState("RSS 주소를 입력해 구독을 시작하세요")를 위에 표시. nav 는 main, feed, saved.',
        '- feed (피드): 실시간 스택 화면. PageHeader(title="실시간 피드", description 에는 {"$data": "feed.feed.title"} 을 바인딩) + 헤더 자식 Button(id="feed-refresh", text="새로고침", variant="secondary"). 기사는 Card가 아니라 List 컴포넌트로 만들고, List( id="feed-list" )의 items 는 반드시 {"$data": "feed.items"} 로 바인딩한다 — 서버가 List 항목 형태({id, title, description, badge:"NEW", badgeVariant, url, source, publishedAt, isNew})로 정제해 준다. 새 항목이 맨 위에 쌓이고 90초 안의 항목은 NEW 배지를 단다. 목록 위에 Paragraph로 "20초마다 자동 갱신됩니다"를 표시.',
        '- saved (저장함): 나중에 읽기 목록 자리. API가 없으니 EmptyState만.',
        '',
        '중요 규칙:',
        '- feed 페이지의 데이터(List items, 헤더 제목/기사 수)는 전부 {"$data": "feed.<path>"} 바인딩으로만 보여 준다. 리터럴 값을 넣지 않는다 — 런타임이 20초마다 갱신한다. 기사 수는 {"$data": "feed.feed.count"}.',
        '- id "feed-refresh" 와 "add-feed-form" 은 [actions]가 선언한 런타임 전용 컨트롤이다 — 가이드대로 정확히 그 id를 사용한다.',
        '- /feed 를 call_api로 직접 호출하지 않는다. 스냅샷이 이미 제공된다.',
        '- 첫 화면(main)에서는 아직 rssUrl이 비어 있으므로 $data 바인딩이 빈 값으로 렌더된다 — EmptyState가 그 역할을 하므로 문제가 없다.'
      ].join('\n')
    )
    return
  }

  if (url.pathname === '/stats' && req.method === 'GET') {
    return json(res, 200, { ...stats, openFeeds: sessions.size })
  }

  json(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LiveRSS demo backend on http://127.0.0.1:${PORT}/rss.domino`)
})
