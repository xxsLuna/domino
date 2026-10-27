import { DOMParser } from '@xmldom/xmldom'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseFeed } from './parse'

// parseFeed uses the platform DOMParser (Chromium in every real shell); node
// has none, so the tests inject @xmldom/xmldom — CDATA, entities and
// localName included, unlike happy-dom's XML support.
beforeAll(() => {
  ;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser
})

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com</link>
    <item>
      <title>First post</title>
      <link>https://example.com/posts/1</link>
      <pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/posts/2</link>
      <description>Plain &amp; simple</description>
    </item>
  </channel>
</rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Entry one</title>
    <link rel="alternate" href="https://example.org/e/1"/>
    <updated>2026-10-19T10:00:00Z</updated>
    <summary>Short summary</summary>
  </entry>
  <entry>
    <link href="https://example.org/e/2"/>
  </entry>
</feed>`

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://example.net">
    <title>RDF Feed</title>
  </channel>
  <item rdf:about="https://example.net/1">
    <title>RDF item</title>
    <link>https://example.net/1</link>
  </item>
</rdf:RDF>`

describe('parseFeed', () => {
  it('parses RSS 2.0 with CDATA and entities', () => {
    const feed = parseFeed(RSS2)
    expect(feed?.title).toBe('Example Blog')
    expect(feed?.items).toHaveLength(2)
    expect(feed?.items[0]).toEqual({
      title: 'First post',
      link: 'https://example.com/posts/1',
      date: 'Mon, 19 Oct 2026 10:00:00 GMT',
      summary: 'Hello world'
    })
    expect(feed?.items[1].summary).toBe('Plain & simple')
  })

  it('parses Atom entries, preferring the alternate link', () => {
    const feed = parseFeed(ATOM)
    expect(feed?.title).toBe('Atom Feed')
    expect(feed?.items[0]).toEqual({
      title: 'Entry one',
      link: 'https://example.org/e/1',
      date: '2026-10-19T10:00:00Z',
      summary: 'Short summary'
    })
    // An entry with only a link still yields an item.
    expect(feed?.items[1].link).toBe('https://example.org/e/2')
  })

  it('parses RDF 1.0 where items are channel siblings', () => {
    const feed = parseFeed(RDF)
    expect(feed?.title).toBe('RDF Feed')
    expect(feed?.items).toHaveLength(1)
    expect(feed?.items[0].title).toBe('RDF item')
  })

  it('caps items and text lengths', () => {
    const items = Array.from(
      { length: 80 },
      (_, i) => `<item><title>${'t'.repeat(300)}${i}</title><link>https://e.com/${i}</link></item>`
    ).join('')
    const feed = parseFeed(`<rss><channel><title>big</title>${items}</channel></rss>`)
    expect(feed?.items).toHaveLength(50)
    expect(feed?.items[0].title.length).toBe(201) // 200 chars + ellipsis
  })

  it('drops full HTML content and empty items', () => {
    const xml = `<rss><channel><title>t</title>
      <item><title>x</title><link>https://e.com/x</link><content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/">&lt;p&gt;full article&lt;/p&gt;</content:encoded></item>
      <item><description>only a description</description></item>
      <item></item>
    </channel></rss>`
    const feed = parseFeed(xml)
    expect(feed?.items).toHaveLength(1)
    expect(feed?.items[0].summary).toBeUndefined()
  })

  it('rejects non-feed XML and malformed documents', () => {
    expect(parseFeed('<html><body>nope</body></html>')).toBeNull()
    expect(parseFeed('not xml at all')).toBeNull()
    // XML-mode parsers surface unclosed tags as a parse error, not recovery.
    expect(parseFeed('<rss><channel>unclosed')).toBeNull()
    expect(parseFeed('')).toBeNull()
  })
})
