import { useEffect, useState } from 'react'
import { loadLlmConfig, pushRecent } from '@core/session/prefs'
import type { LLMConfig } from '@core/llm'
import { DominoLoadError, loadAndParse, type LoadedDomino } from './loadDomino'
import { getStorage } from './platform'
import { Settings } from './screens/Settings'
import { Welcome } from './screens/Welcome'
import { Runtime } from './screens/Runtime'

// StrictMode runs effects twice in dev; register the IPC listener only once.
let openFileRegistered = false

export function App(): React.JSX.Element {
  const storage = getStorage()
  const [config, setConfig] = useState<LLMConfig | null>(null)
  const [loaded, setLoaded] = useState<LoadedDomino | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Boot: BYOK config + OS-level *.domino open requests (double click / open-with).
  useEffect(() => {
    void loadLlmConfig(storage).then(setConfig)
    const bridge = window.dominoBridge
    if (!bridge || openFileRegistered) return
    openFileRegistered = true
    bridge.onOpenFile((filePath) => {
      void (async () => {
        try {
          const result = await loadAndParse({ type: 'file', path: filePath })
          await pushRecent(storage, {
            source: { type: 'file', path: filePath },
            name: result.name
          })
          setLoaded(result)
          setLoadError(null)
        } catch (err) {
          setLoaded(null)
          setLoadError(err instanceof DominoLoadError ? err.message : (err as Error).message)
        }
      })()
    })
  }, [storage])

  if (!config) {
    return (
      <div className="boot-state">
        <span className="spinner" />
        <p>불러오는 중…</p>
      </div>
    )
  }

  return (
    <div className="app">
      {loaded ? (
        <Runtime
          loaded={loaded}
          config={config}
          onHome={() => setLoaded(null)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <>
          {loadError ? <pre className="error-box top">{loadError}</pre> : null}
          <Welcome
            onLoaded={(result) => {
              setLoaded(result)
              setLoadError(null)
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </>
      )}

      {settingsOpen ? (
        <Settings
          config={config}
          onSaved={(next) => setConfig(next)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  )
}
