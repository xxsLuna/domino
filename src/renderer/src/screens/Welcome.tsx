import { useEffect, useRef, useState } from 'react'
import { loadRecents, pushRecent, type DominoSource, type RecentEntry } from '@core/session/prefs'
import { DEMO_DOMINO_NAME, DEMO_DOMINO_TEXT } from '../demoDomino'
import { DominoLoadError, loadAndParse, type LoadedDomino } from '../loadDomino'
import { getStorage } from '../platform'

interface WelcomeProps {
  onLoaded: (loaded: LoadedDomino) => void
  onOpenSettings: () => void
}

export function Welcome({ onLoaded, onOpenSettings }: WelcomeProps): React.JSX.Element {
  const storage = getStorage()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadRecents(storage).then(setRecents)
  }, [storage])

  const open = async (source: DominoSource, name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const loaded = await loadAndParse(source)
      await pushRecent(storage, { source, name: loaded.name })
      setRecents(await loadRecents(storage))
      onLoaded(loaded)
    } catch (err) {
      setError(err instanceof DominoLoadError ? err.message : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const openUrl = (): void => {
    const trimmed = url.trim()
    if (!trimmed) return
    void open({ type: 'url', url: trimmed }, trimmed)
  }

  const openFile = async (file: File): Promise<void> => {
    const text = await file.text()
    await open({ type: 'text', text }, file.name)
  }

  const reopen = (entry: RecentEntry): void => {
    void (async () => {
      if (entry.source.type === 'file' && entry.source.text === undefined && !window.dominoBridge) {
        setError('이 파일은 이 기기에 남아 있지 않습니다. 다시 업로드해 주세요.')
        return
      }
      await open(entry.source, entry.name)
    })()
  }

  return (
    <div className="welcome">
      <header className="welcome-head">
        <div className="brand">
          <span className="brand-mark">🁫</span>
          <div>
            <h1>Dom-In-O</h1>
            <p className="muted">.domino 파일로 열리는, LLM이 실시간 만드는 앱 런타임</p>
          </div>
        </div>
        <button className="icon-btn" onClick={onOpenSettings} title="설정">
          ⚙
        </button>
      </header>

      <section className="load-card">
        <h2>domino 열기</h2>
        <div className="load-row">
          <input
            className="url-input"
            placeholder="domino://app.example.com/crm.domino  또는  https://…/app.domino"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && openUrl()}
            disabled={busy}
          />
          <button className="btn btn-primary" onClick={openUrl} disabled={busy || !url.trim()}>
            열기
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            파일 선택
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".domino,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void openFile(f)
              e.target.value = ''
            }}
          />
        </div>
        <div className="load-actions">
          <button
            className="ghost-btn"
            onClick={() => void open({ type: 'text', text: DEMO_DOMINO_TEXT }, DEMO_DOMINO_NAME)}
            disabled={busy}
          >
            예시로 시작하기
          </button>
        </div>
        {busy ? (
          <p className="muted">
            <span className="spinner small" /> 불러오는 중…
          </p>
        ) : null}
        {error ? <pre className="error-box">{error}</pre> : null}
      </section>

      <section className="recent-card">
        <h2>최근 domino</h2>
        {recents.length === 0 ? (
          <p className="muted">아직 사용한 domino가 없습니다. 위에서 열어보세요.</p>
        ) : (
          <ul className="recent-list">
            {recents.map((entry, i) => (
              <li key={i}>
                <button className="recent-item" onClick={() => reopen(entry)} disabled={busy}>
                  <span className="recent-name">{entry.name}</span>
                  <span className="recent-src muted">
                    {entry.source.type === 'url'
                      ? entry.source.url
                      : entry.source.type === 'file'
                        ? entry.source.path
                        : '직접 업로드/예시'}
                  </span>
                  <span className="recent-date muted">
                    {new Date(entry.at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="welcome-foot muted">
        데스크톱에서는 <code>.domino</code> 파일을 바로 열거나 <code>domino://</code> 링크를
        클릭해 실행할 수 있습니다. 설정에서 LLM Provider(BYOK)를 등록하세요.
      </footer>
    </div>
  )
}
