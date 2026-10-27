/**
 * RSS/Atom/RDF feed parsing: untrusted XML in, compact JSON out.
 *
 * Feed bodies are raw XML — handing them to the model verbatim floods the
 * context (executeApi's response cap is 400k chars). Every consumer of this
 * module wants the same narrow shape: feed title plus a bounded item list.
 * Full-HTML entries (`content:encoded`) are deliberately dropped; a feed item
 * is a headline and a link, not an article.
 *
 * DOMParser handles CDATA, entity decoding and namespaces natively, so this
 * module stays a thin extractor. It runs in the renderer (Chromium-family on
 * every platform); `parseFeed` returns null where DOMParser is unavailable
 * (node tests without the happy-dom environment).
 */

export interface FeedItem {
  title: string
  link: string
  date?: string
  summary?: string
}

export interface FeedData {
  title: string
  items: FeedItem[]
}

/** Items beyond this are dropped — a feed is a headline list, not an archive. */
const MAX_ITEMS = 50
const MAX_TITLE_CHARS = 200
const MAX_SUMMARY_CHARS = 300

/**
 * Descendants whose local name matches, prefix-agnostic (`atom:link` counts
 * as `link`). A plain `getElementsByTagName` only finds unprefixed names, and
 * `getElementsByTagNameNS('*', …)` is unsupported in the happy-dom test
 * environment — scanning `*` and comparing `localName` works in both.
 */
function byLocalName(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === name)
}

/** Text of the first descendant with the given local name (any namespace). */
function firstText(root: Element, ...names: string[]): string {
  for (const name of names) {
    const text = byLocalName(root, name)[0]?.textContent?.trim()
    if (text) return text
  }
  return ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Summary text as plain, whitespace-collapsed prose. Descriptions routinely
 * carry HTML; re-parsing as text/html and reading textContent strips tags
 * without regex guesswork (script/style text would leak through a naive
 * tag-removal regex). Some DOMParser implementations (the xmldom used in
 * node tests) build no body — documentElement then carries the same text.
 */
function stripHtml(text: string): string {
  if (!text) return ''
  let plain = text
  try {
    const doc = new DOMParser().parseFromString(text, 'text/html')
    plain = doc.body?.textContent ?? doc.documentElement?.textContent ?? text
  } catch {
    /* keep raw */
  }
  return plain.replace(/\s+/g, ' ').trim()
}

/** RSS `<link>` text, else Atom `<link href>` (alternate/relative first). */
function itemLink(item: Element): string {
  const text = firstText(item, 'link')
  if (text) return text
  const links = byLocalName(item, 'link')
  const preferred = links.find((l) => {
    const rel = l.getAttribute('rel')
    return !rel || rel === 'alternate'
  })
  return (preferred ?? links[0])?.getAttribute('href')?.trim() ?? ''
}

function parseItem(el: Element): FeedItem | null {
  const title = clip(firstText(el, 'title'), MAX_TITLE_CHARS)
  const link = itemLink(el)
  if (!title && !link) return null
  const summary = clip(stripHtml(firstText(el, 'description', 'summary')), MAX_SUMMARY_CHARS)
  const date = firstText(el, 'pubDate', 'updated', 'published', 'date')
  return {
    title,
    link,
    ...(date ? { date } : {}),
    ...(summary ? { summary } : {})
  }
}

/**
 * Parse a feed document, or return null when the XML isn't RSS 2.0, RDF 1.0
 * or Atom. A malformed document never throws: browsers surface parse errors
 * as a `parsererror` root, which fails the root-name check below.
 */
export function parseFeed(xml: string): FeedData | null {
  if (typeof DOMParser === 'undefined' || !xml) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
  } catch {
    return null
  }
  const root = doc.documentElement
  if (!root) return null

  const local = root.localName.toLowerCase()
  let channel: Element
  let itemEls: Element[]
  if (local === 'rss') {
    // RSS 2.0: <rss><channel><title>…<item>…</channel></rss>
    channel = byLocalName(root, 'channel')[0] ?? root
    itemEls = byLocalName(root, 'item')
  } else if (local === 'rdf') {
    // RDF 1.0: the channel holds the title; items are its siblings.
    channel = byLocalName(root, 'channel')[0] ?? root
    itemEls = byLocalName(root, 'item')
  } else if (local === 'feed') {
    // Atom: <feed><title>…<entry>…
    channel = root
    itemEls = byLocalName(root, 'entry')
  } else {
    return null
  }

  const items: FeedItem[] = []
  for (const el of itemEls) {
    if (items.length >= MAX_ITEMS) break
    const item = parseItem(el)
    if (item) items.push(item)
  }
  return { title: clip(firstText(channel, 'title'), MAX_TITLE_CHARS), items }
}
