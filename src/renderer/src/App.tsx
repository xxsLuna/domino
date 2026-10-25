import { useCallback, useEffect, useState } from 'react'
import { Spinner } from '@heroui/react'
import { App as CapacitorApp } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import {
  defaultLlmConfig,
  loadDominoLlmConfig,
  loadLlmConfig,
  pushRecent,
  type DominoSource
} from '@core/session/prefs'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'
import type { LLMConfig } from '@core/llm'
import { DominoLoadError, loadAndParse, type LoadedDomino } from './loadDomino'
import { useBackHandler } from './backStack'
import { getStorage, isNativeMobile, syncSystemBars } from './platform'
import { useFileDrop } from './useFileDrop'
import { useSystemTheme } from './useSystemTheme'
import { t, useI18n } from './i18n'
import { Maker } from './screens/Maker'
import { Settings } from './screens/Settings'
import { UpdateBanner } from './screens/UpdateBanner'
import { Welcome } from './screens/Welcome'
import { Runtime } from './screens/Runtime'

// StrictMode runs effects twice in dev; register the IPC listener only once.
let openFileRegistered = false

export function App(): React.JSX.Element {
  const storage = getStorage()
  const [config, setConfig] = useState<LLMConfig | null>(null)
  const [loaded, setLoaded] = useState<LoadedDomino | null>(null)
  // Bumped on every open so a newly opened domino gets a fresh runtime.
  const [openSeq, setOpenSeq] = useState(0)
  const [makerOpen, setMakerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // A domino may run on its own provider/model (kept next to, never inside,
  // the .domino file). The open domino's override wins over the global one.
  const [dominoLlm, setDominoLlm] = useState<LLMConfig | null>(null)
  const refreshDominoLlm = useCallback(() => {
    if (!loaded) {
      setDominoLlm(null)
      return
    }
    void loadDominoLlmConfig(storage, loaded.domino.id)
      .then(setDominoLlm)
      .catch(() => setDominoLlm(null))
  }, [loaded, storage])
  const systemTheme = useSystemTheme()
  useI18n() // re-render everything when the language changes

  useEffect(() => {
    refreshDominoLlm()
  }, [refreshDominoLlm])

  // Explicit domino theme wins; theme=auto (and the shell screens) follow the OS.
  const effectiveTheme =
    loaded && loaded.domino.ui.theme !== 'auto' ? loaded.domino.ui.theme : systemTheme
  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme
    syncSystemBars(effectiveTheme)
  }, [effectiveTheme])

  // Android back / browser back: settings closes first, then the maker.
  // (The runtime registers its own handler for its screen history.)
  useBackHandler(makerOpen && !loaded, () => setMakerOpen(false))
  useBackHandler(settingsOpen, () => setSettingsOpen(false))

  const show = useCallback((result: LoadedDomino) => {
    setLoaded(result)
    setOpenSeq((n) => n + 1)
    setMakerOpen(false)
    setLoadError(null)
  }, [])

  /** One path for every way a domino gets opened (file, drop, OS, maker). */
  const openSource = useCallback(
    async (source: DominoSource): Promise<void> => {
      try {
        const result = await loadAndParse(source)
        await pushRecent(storage, { source, name: result.name })
        show(result)
      } catch (err) {
        setLoaded(null)
        setLoadError(err instanceof DominoLoadError ? err.message : (err as Error).message)
      }
    },
    [show, storage]
  )

  // Drag a .domino file anywhere onto the window to open it.
  const dragging = useFileDrop((file) => {
    if (!/\.domino$/i.test(file.name)) {
      setLoadError(t('app.dropOnly', { name: file.name }))
      return
    }
    const path = window.dominoBridge?.pathForFile?.(file)
    void (async () => {
      await openSource(path ? { type: 'file', path } : { type: 'text', text: await file.text() })
    })().catch((err) => setLoadError((err as Error).message))
  })

  // Boot: BYOK config + OS-level *.domino open requests (double click / open-with).
  useEffect(() => {
    void loadLlmConfig(storage)
      .then(setConfig)
      // Boot must never hang on the spinner: fall back to defaults instead.
      .catch(() => setConfig(defaultLlmConfig()))
    const bridge = window.dominoBridge
    if (!bridge || openFileRegistered) return
    openFileRegistered = true
    bridge.onOpenFile((filePath) => void openSource({ type: 'file', path: filePath }))
  }, [openSource, storage])

  // Android/iOS deep links: domino://… arrives through the intent-filter and
  // opens via the same path as files and drops — loadDomino decodes or
  // rewrites the URL (inline ?c= payloads and hosted .domino files alike).
  useEffect(() => {
    if (!isNativeMobile()) return
    let live = true
    let handle: PluginListenerHandle | undefined
    void CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      void openSource({ type: 'url', url })
    }).then((h) => {
      if (live) handle = h
      else void h.remove()
    })
    return () => {
      live = false
      void handle?.remove()
    }
  }, [openSource])

  if (!config) {
    return (
      <div className="boot-state" role="status">
        <Spinner />
        <p>{t('app.loading')}</p>
      </div>
    )
  }

  const errorBanner = loadError ? (
    <div className="mx-auto w-full max-w-[760px] px-4 pt-4">
      <Alert
        variant="danger"
        title={t('app.openFailTitle')}
        message={loadError}
        onClose={() => setLoadError(null)}
      />
    </div>
  ) : null

  return (
    <div className="app">
      <UpdateBanner />
      {loaded ? (
        <Runtime
          key={openSeq}
          loaded={loaded}
          config={dominoLlm ?? config}
          onHome={() => setLoaded(null)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : makerOpen ? (
        <Maker
          config={config}
          onBack={() => setMakerOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDomino={(text) => void openSource({ type: 'text', text })}
        />
      ) : (
        <>
          {errorBanner}
          <Welcome
            onLoaded={show}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenMaker={() => setMakerOpen(true)}
          />
        </>
      )}

      {dragging ? (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-card">
            <Icon name="file" size={28} />
            <p className="text-base font-semibold">{t('app.dropHint')}</p>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <Settings
          config={config}
          dominoId={loaded?.domino.id ?? null}
          onSaved={(next) => setConfig(next)}
          onDominoChanged={refreshDominoLlm}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  )
}
