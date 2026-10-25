import { useEffect, useRef, useState } from 'react'
import { Button, Card, InputGroup, Spinner, TextField, Tooltip } from '@heroui/react'
import { loadRecents, pushRecent, type DominoSource, type RecentEntry } from '@core/session/prefs'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'
import { DEMO_DOMINO_TEXT } from '../demoDomino'
import { DominoLoadError, loadAndParse, type LoadedDomino } from '../loadDomino'
import { getStorage } from '../platform'
import { t } from '../i18n'

declare const __APP_VERSION__: string
declare const __GIT_HASH__: string

// A release identifies its version and the commit it was cut from; a dev
// build only needs the commit — the version is whatever the tree is headed to.
const buildInfo = import.meta.env.DEV ? __GIT_HASH__ : `v${__APP_VERSION__} · ${__GIT_HASH__}`

interface WelcomeProps {
  onLoaded: (loaded: LoadedDomino) => void
  onOpenSettings: () => void
  onOpenMaker: () => void
}

export function Welcome({
  onLoaded,
  onOpenSettings,
  onOpenMaker
}: WelcomeProps): React.JSX.Element {
  const storage = getStorage()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // A storage failure just means no recents list — never a crash.
    void loadRecents(storage)
      .then(setRecents)
      .catch(() => {})
  }, [storage])

  const open = async (source: DominoSource): Promise<void> => {
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
    void open({ type: 'url', url: trimmed })
  }

  const openFile = async (file: File): Promise<void> => {
    // file.text() runs outside open()'s own try/catch — guard it here too.
    try {
      const text = await file.text()
      await open({ type: 'text', text })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const reopen = (entry: RecentEntry): void => {
    void (async () => {
      if (entry.source.type === 'file' && entry.source.text === undefined && !window.dominoBridge) {
        setError(t('welcome.fileGone'))
        return
      }
      await open(entry.source)
    })().catch((err) => setError((err as Error).message))
  }

  return (
    <div className="welcome">
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent text-accent-foreground">
            <DominoMark />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Domino UI</h1>
            <p className="text-sm text-muted">{t('welcome.tagline')}</p>
          </div>
        </div>
        <Tooltip delay={600}>
          <Button
            isIconOnly
            variant="secondary"
            aria-label={t('common.settings')}
            onPress={onOpenSettings}
          >
            <Icon name="settings" size={18} />
          </Button>
          <Tooltip.Content>{t('common.settings')}</Tooltip.Content>
        </Tooltip>
      </header>

      <Card>
        <Card.Header>
          <Card.Title>{t('welcome.openTitle')}</Card.Title>
          <Card.Description>{t('welcome.openDesc')}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              openUrl()
            }}
          >
            <TextField
              className="flex-1 min-w-0"
              value={url}
              onChange={setUrl}
              isDisabled={busy}
              aria-label="domino URL"
              variant="secondary"
            >
              <InputGroup variant="secondary" fullWidth>
                <InputGroup.Prefix>
                  <Icon name="link" className="text-muted" />
                </InputGroup.Prefix>
                <InputGroup.Input placeholder={t('welcome.urlPlaceholder')} />
              </InputGroup>
            </TextField>
            <Button type="submit" isDisabled={busy || !url.trim()} aria-label={t('welcome.open')}>
              <Icon name="arrow-right" className="phone-only" />
              <span className="hide-phone">{t('welcome.open')}</span>
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onPress={() => fileInput.current?.click()}
              isDisabled={busy}
            >
              <Icon name="file" />
              {t('welcome.pickFile')}
            </Button>
            <Button
              variant="tertiary"
              onPress={() => void open({ type: 'text', text: DEMO_DOMINO_TEXT })}
              isDisabled={busy}
            >
              <Icon name="rocket" />
              {t('welcome.demo')}
            </Button>
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
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted" role="status">
              <Spinner size="sm" /> {t('welcome.loading')}
            </p>
          ) : null}
          {error ? (
            <Alert
              variant="danger"
              title={t('welcome.errTitle')}
              message={error}
              onClose={() => setError(null)}
            />
          ) : null}
        </Card.Content>
      </Card>

      <Card>
        <Card.Content className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
              <Icon name="lightbulb" size={22} />
            </span>
            <div className="min-w-0">
              <p className="font-semibold">domino maker</p>
              <p className="text-sm text-muted">{t('welcome.makerDesc')}</p>
            </div>
          </div>
          <Button onPress={onOpenMaker} isDisabled={busy}>
            <Icon name="plus" />
            {t('welcome.makeNew')}
          </Button>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>{t('welcome.recents')}</Card.Title>
        </Card.Header>
        <Card.Content>
          {recents.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t('welcome.recentsNone')}</p>
          ) : (
            <ul className="-mx-2 flex flex-col" aria-label={t('welcome.recents')}>
              {recents.map((entry, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-default disabled:cursor-default disabled:opacity-50"
                    onClick={() => reopen(entry)}
                    disabled={busy}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-sm font-semibold text-accent-soft-foreground">
                      {entry.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{entry.name}</span>
                      <span className="truncate text-xs text-muted">
                        {entry.source.type === 'url'
                          ? entry.source.url
                          : entry.source.type === 'file'
                            ? entry.source.path
                            : t('welcome.uploaded')}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">
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
        </Card.Content>
      </Card>

      <footer className="text-center text-xs text-muted">
        {t('welcome.footerA')} <code className="rounded bg-default px-1">.domino</code>{' '}
        {t('welcome.footerB')} <code className="rounded bg-default px-1">domino://</code>{' '}
        {t('welcome.footerC')}
        <p className="mt-2">
          <code className="rounded bg-default px-1" aria-label="빌드 정보">
            {buildInfo}
          </code>
        </p>
      </footer>
    </div>
  )
}

/** A domino tile — the app mark (emoji tiles are missing from most system fonts). */
function DominoMark(): React.JSX.Element {
  return (
    <svg width="22" height="30" viewBox="0 0 22 30" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="19" height="27" rx="4" stroke="currentColor" strokeWidth="2" />
      <path d="M5 15h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="11" cy="8.25" r="1.8" fill="currentColor" />
      <circle cx="7" cy="19.5" r="1.6" fill="currentColor" />
      <circle cx="15" cy="23.5" r="1.6" fill="currentColor" />
    </svg>
  )
}
