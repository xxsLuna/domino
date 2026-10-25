import { useEffect, useMemo, useState } from 'react'
import { Button, ProgressBar, Spinner } from '@heroui/react'
import { Icon } from '@core/ui/icons'
import { isNewer, RELEASES_REPO, RELEASES_URL } from '@core/version'
import type { UpdateInfo, UpdateProgress } from '../platform'
import { t } from '../i18n'

declare const __APP_VERSION__: string

interface UpdateSource {
  /** desktop installs in place; mobile hands the APK to the system installer. */
  mode: 'desktop' | 'mobile'
  check(): Promise<UpdateInfo | null>
  install(onProgress: (p: UpdateProgress) => void, onError: (message: string) => void): void
  openReleases(): void
}

/** Android (Capacitor): Android always asks the user to confirm an APK install. */
function mobileSource(): UpdateSource | null {
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  if (!cap?.isNativePlatform?.()) return null
  let apkUrl: string | null = null
  return {
    mode: 'mobile',
    async check() {
      const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json' }
      })
      if (!res.ok) return null
      const rel = (await res.json()) as {
        tag_name: string
        body?: string
        html_url: string
        assets: Array<{ name: string; browser_download_url: string; size: number }>
      }
      const version = rel.tag_name.replace(/^v/i, '')
      const apk = rel.assets.find((a) => a.name.endsWith('-android.apk'))
      if (!apk || !isNewer(version, __APP_VERSION__)) return null
      apkUrl = apk.browser_download_url
      return {
        current: __APP_VERSION__,
        version,
        notes: rel.body ?? '',
        url: rel.html_url,
        assetName: apk.name,
        size: apk.size
      }
    },
    install(_onProgress, onError) {
      if (apkUrl) window.open(apkUrl, '_blank', 'noopener')
      else onError('no APK in the release')
    },
    openReleases: () => window.open(RELEASES_URL, '_blank', 'noopener')
  }
}

function useUpdateSource(): UpdateSource | null {
  return useMemo(() => {
    const desktop = window.dominoBridge?.update
    if (desktop) return { mode: 'desktop', ...desktop }
    return mobileSource()
  }, [])
}

type State =
  | { kind: 'hidden' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'downloading'; info: UpdateInfo; pct: number }
  | { kind: 'installing'; info: UpdateInfo }
  | { kind: 'handedOff'; info: UpdateInfo }
  | { kind: 'failed'; info: UpdateInfo; message: string }

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`

/**
 * Checks GitHub Releases once at launch and offers a one-click update:
 * desktop downloads, installs and relaunches; Android downloads the APK for
 * the system installer. Silent when nothing is new or the check fails.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const source = useUpdateSource()
  const [state, setState] = useState<State>({ kind: 'hidden' })

  useEffect(() => {
    if (!source) return
    let alive = true
    source
      .check()
      .then((info) => alive && info && setState({ kind: 'available', info }))
      .catch(() => {
        /* offline or rate-limited: no banner */
      })
    return () => {
      alive = false
    }
  }, [source])

  if (!source || state.kind === 'hidden') return null
  const { info } = state

  const install = (): void => {
    if (source.mode === 'mobile') {
      source.install(
        () => {},
        (message) => setState({ kind: 'failed', info, message })
      )
      setState({ kind: 'handedOff', info })
      return
    }
    setState({ kind: 'downloading', info, pct: 0 })
    source.install(
      (p) =>
        setState(
          p.phase === 'install'
            ? { kind: 'installing', info }
            : {
                kind: 'downloading',
                info,
                pct: p.total ? Math.round((p.received / p.total) * 100) : 0
              }
        ),
      (message) => setState({ kind: 'failed', info, message })
    )
  }

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <Icon name="download" size={16} />
      {state.kind === 'available' ? (
        <>
          <span className="update-text">
            {t('up.available', { v: info.version })} <strong>v{info.version}</strong> (
            {t('up.current', { c: info.current })}, {mb(info.size)})
          </span>
          <Button size="sm" onPress={install}>
            {t('up.install')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={t('up.later')}
            onPress={() => setState({ kind: 'hidden' })}
          >
            <Icon name="close" size={14} />
          </Button>
        </>
      ) : state.kind === 'downloading' ? (
        <>
          <span className="update-text">
            {t('up.downloading', { v: info.version, p: state.pct })}
          </span>
          <ProgressBar
            aria-label={t('up.downloadAria')}
            value={state.pct}
            size="sm"
            className="update-progress"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        </>
      ) : state.kind === 'installing' ? (
        <span className="update-text flex items-center gap-2">
          <Spinner size="sm" color="current" /> {t('up.restart')}
        </span>
      ) : state.kind === 'handedOff' ? (
        <>
          <span className="update-text">{t('up.apk', { v: info.version })}</span>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={t('common.close')}
            onPress={() => setState({ kind: 'hidden' })}
          >
            <Icon name="close" size={14} />
          </Button>
        </>
      ) : (
        <>
          <span className="update-text">업데이트하지 못했습니다: {state.message}</span>
          <Button size="sm" variant="secondary" onPress={install}>
            다시 시도
          </Button>
          <Button size="sm" variant="ghost" onPress={() => source.openReleases()}>
            직접 받기
          </Button>
        </>
      )}
    </div>
  )
}
