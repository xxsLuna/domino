import type { DominoFile } from './types'

/**
 * A definition fingerprint: changes when anything a BUILT screen depends on
 * changes — [api], [auth], [data], [actions], [pages], [guide] and the home
 * page — so persisted screens can be recognized as outdated after the file
 * was edited or re-made in the maker. Deliberately left out:
 *  - [ui] (theme/colors/density are applied live, never baked into specs);
 *  - [script] (routing only picks which built page shows);
 *  - [screens] (the embed itself — exporting must not invalidate itself);
 *  - name/logo/description and comments/whitespace/ordering of sets.
 */
export function dominoFingerprint(domino: DominoFile): string {
  const byKey = <T>(items: T[], key: (t: T) => string): T[] =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  const structure = {
    home: domino.meta.home,
    auth: {
      required: domino.auth.required,
      loginEndpoint: domino.auth.loginEndpoint ?? null,
      tokenKey: domino.auth.tokenKey,
      skipIfLoggedIn: domino.auth.skipIfLoggedIn
    },
    api: {
      baseUrl: domino.api.baseUrl ?? null,
      allow: [...domino.api.allow].sort()
    },
    data: byKey(domino.data, (d) => d.key).map((d) => [d.key, d.method, d.path, d.everySec ?? 0]),
    actions: byKey(domino.actions, (a) => a.id).map((a) => [a.id, a.steps]),
    // Plan order is nav order — it matters.
    pages: domino.pages.map((p) => [p.id, p.name, p.purpose ?? '', p.nav]),
    guide: normalizeProse(domino.guide ?? '')
  }
  return `d1-${cyrb53(stableStringify(structure))}`
}

/** Trailing spaces and runs of blank lines don't change what a brief says. */
function normalizeProse(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** JSON with sorted object keys, so field order never changes the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** cyrb53: a fast 53-bit string hash (base36) — plenty for change detection. */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
