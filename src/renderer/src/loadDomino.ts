import { parseDomino } from '@core/domino/parse'
import type { DominoFile, ParseError } from '@core/domino/types'
import type { DominoSource } from '@core/session/prefs'
import { clearCachedText, getCachedText, putCachedText } from '@core/session/registry'
import { httpFetch, readTextCapped } from '@core/net'
import { getStorage, isElectron } from './platform'

/**
 * Resolves a DominoSource into raw text, then parses it.
 * Handles domino:// (inline `c=` payload or remote host), plain http(s)
 * .domino URLs, local files (Electron) and raw text (web uploads).
 */

export interface LoadedDomino {
  domino: DominoFile
  source: DominoSource
  name: string
  warnings: ParseError[]
}

export class DominoLoadError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: ParseError[] = []
  ) {
    super(message)
  }
}

export async function loadDominoText(source: DominoSource): Promise<string> {
  switch (source.type) {
    case 'text':
      return source.text
    case 'file': {
      if (source.text !== undefined) return source.text
      if (window.dominoBridge) return window.dominoBridge.readFile(source.path)
      throw new DominoLoadError('파일 접근은 데스크톱 앱에서만 가능합니다. 파일을 업로드해 주세요.')
    }
    case 'url':
      return loadUrl(source.url)
  }
}

async function loadUrl(raw: string): Promise<string> {
  const url = raw.trim()

  if (url.startsWith('domino://')) {
    // Inline payload: domino://<name>?c=<urlencoded content>
    try {
      const parsed = new URL(url)
      const inline = parsed.searchParams.get('c')
      if (inline) return inline
    } catch {
      throw new DominoLoadError(`잘못된 domino URL: ${url}`)
    }
    // Remote: rewrite the custom scheme to https for fetch (web), or let
    // Electron's privileged scheme handle it natively.
    if (isElectron()) {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new DominoLoadError(`domino 프로토콜 요청 실패 (HTTP ${res.status})`)
      const text = await readTextCapped(res, MAX_DOMINO_CHARS)
      if (text.length >= MAX_DOMINO_CHARS) {
        throw new DominoLoadError(`.domino 파일이 너무 큽니다 (최대 ${MAX_DOMINO_CHARS}자)`)
      }
      return text
    }
    const httpsUrl = url.replace(/^domino:\/\//, 'https://')
    return fetchRemote(httpsUrl)
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return fetchRemote(url)
  }

  // Bare host/path → assume domino scheme intent.
  return loadUrl(`domino://${url}`)
}

/** Remote .domino files are small text; cap and time-box the fetch. */
const MAX_DOMINO_CHARS = 4_000_000

async function fetchRemote(url: string): Promise<string> {
  let res: Response
  try {
    res = await httpFetch(url, { signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    throw new DominoLoadError(`요청 실패: ${(err as Error).message}`)
  }
  if (!res.ok) throw new DominoLoadError(`HTTP ${res.status} ${res.statusText} — ${url}`)
  const text = await readTextCapped(res, MAX_DOMINO_CHARS)
  if (text.length >= MAX_DOMINO_CHARS) {
    throw new DominoLoadError(`.domino 파일이 너무 큽니다 (최대 ${MAX_DOMINO_CHARS}자) — ${url}`)
  }
  return text
}

export async function loadAndParse(source: DominoSource): Promise<LoadedDomino> {
  const storage = getStorage()

  // Remote opens parse from the local copy first: reopening is instant and
  // works offline. The fresh copy is fetched in the background and wins on
  // the NEXT open, so a mid-session redefinition can't pull the rug out.
  if (source.type === 'url') {
    const cached = await getCachedText(storage, source)
    if (cached !== null) {
      const hit = tryParse(cached, source)
      if (hit) {
        revalidate(source, cached, storage)
        return hit
      }
      await clearCachedText(storage, source) // corrupt cache: fall through to fetch
    }
  }

  let text: string
  try {
    text = await loadDominoText(source)
  } catch (err) {
    // Offline / file moved: the cached copy still opens the app.
    if (source.type !== 'text') {
      const cached = await getCachedText(storage, source)
      if (cached !== null) {
        const hit = tryParse(cached, source)
        if (hit) return hit
      }
    }
    throw err
  }

  const parsed = tryParse(text, source)
  if (!parsed) {
    const result = parseDomino(text)
    const detail = result.errors.map((e) => `${e.line}행: ${e.message}`).join('\n')
    throw new DominoLoadError(
      `.domino 파일을 파싱할 수 없습니다.\n${detail || '알 수 없는 오류'}`,
      result.errors
    )
  }
  await putCachedText(storage, source, text)
  return parsed
}

function tryParse(text: string, source: DominoSource): LoadedDomino | null {
  const result = parseDomino(text)
  if (!result.ok || !result.domino) return null
  return {
    domino: result.domino,
    source,
    name: result.domino.meta.name,
    warnings: result.errors
  }
}

/** Refresh the cached copy in the background; the open one stays as served. */
function revalidate(
  source: DominoSource,
  served: string,
  storage: ReturnType<typeof getStorage>
): void {
  void loadDominoText(source)
    .then(async (fresh) => {
      if (fresh !== served) await putCachedText(storage, source, fresh)
    })
    .catch(() => {}) // staying offline on the cached copy is a valid outcome
}
