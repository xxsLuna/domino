import { parseDomino } from '@core/domino/parse'
import type { DominoFile, ParseError } from '@core/domino/types'
import type { DominoSource } from '@core/session/prefs'
import { isElectron } from './platform'

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
      const res = await fetch(url)
      if (!res.ok) throw new DominoLoadError(`domino 프로토콜 요청 실패 (HTTP ${res.status})`)
      return res.text()
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

async function fetchRemote(url: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    throw new DominoLoadError(`요청 실패: ${(err as Error).message}`)
  }
  if (!res.ok) throw new DominoLoadError(`HTTP ${res.status} ${res.statusText} — ${url}`)
  return res.text()
}

export async function loadAndParse(source: DominoSource): Promise<LoadedDomino> {
  const text = await loadDominoText(source)
  const result = parseDomino(text)
  if (!result.ok || !result.domino) {
    const detail = result.errors.map((e) => `${e.line}행: ${e.message}`).join('\n')
    throw new DominoLoadError(
      `.domino 파일을 파싱할 수 없습니다.\n${detail || '알 수 없는 오류'}`,
      result.errors
    )
  }
  return {
    domino: result.domino,
    source,
    name: result.domino.meta.name,
    warnings: result.errors
  }
}
