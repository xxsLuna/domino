import { useState } from 'react'
import { PROVIDER_META, type LLMConfig, type ProviderId } from '@core/llm/types'
import { defaultLlmConfig, saveLlmConfig } from '@core/session/prefs'
import { getStorage, isElectron } from '../platform'

interface SettingsProps {
  config: LLMConfig
  onSaved: (config: LLMConfig) => void
  onClose: () => void
}

export function Settings({ config, onSaved, onClose }: SettingsProps): React.JSX.Element {
  const [draft, setDraft] = useState<LLMConfig>({ ...config })
  const [saved, setSaved] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const meta = PROVIDER_META[draft.provider]

  const pickProvider = (provider: ProviderId): void => {
    const p = PROVIDER_META[provider]
    setDraft((d) => ({
      ...d,
      provider,
      baseUrl: p.defaultBaseUrl,
      model: p.defaultModel || d.model
    }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    await saveLlmConfig(getStorage(), draft)
    onSaved(draft)
    setSaved(true)
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>설정</h2>
          <button className="icon-btn" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        <section className="settings-section">
          <h3>LLM Provider (BYOK)</h3>
          <p className="muted">
            직접 발급한 API 키를 넣어 사용합니다. 키는{' '}
            {isElectron()
              ? 'OS 키체인 기반 safeStorage로 암호화 저장됩니다.'
              : '이 기기의 브라우저 저장소에만 저장됩니다(공용 PC 주의).'}{' '}
            서버로 전송되지 않습니다.
          </p>

          <label className="field">
            <span className="field-label">Provider</span>
            <select
              value={draft.provider}
              onChange={(e) => pickProvider(e.target.value as ProviderId)}
            >
              {(Object.keys(PROVIDER_META) as ProviderId[]).map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_META[id].label} · {PROVIDER_META[id].endpoint}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{meta.note}</p>

          <label className="field">
            <span className="field-label">Base URL</span>
            <input
              type="text"
              value={draft.baseUrl ?? ''}
              placeholder={meta.defaultBaseUrl}
              onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            />
          </label>

          <label className="field">
            <span className="field-label">모델</span>
            <input
              type="text"
              value={draft.model}
              placeholder={meta.defaultModel}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            />
          </label>

          <label className="field">
            <span className="field-label">API 키 (BYOK)</span>
            <div className="key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey ?? ''}
                placeholder={meta.keyHint}
                autoComplete="off"
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              />
              <button className="ghost-btn" onClick={() => setShowKey((v) => !v)} type="button">
                {showKey ? '숨기기' : '보기'}
              </button>
            </div>
          </label>
        </section>

        <footer className="settings-foot">
          <button
            className="btn btn-secondary"
            onClick={() => setDraft({ ...defaultLlmConfig(), provider: draft.provider })}
          >
            기본값 복원
          </button>
          <div className="settings-foot-right">
            {saved ? <span className="saved-ok">저장됨 ✓</span> : null}
            <button className="btn btn-primary" onClick={() => void save()}>
              저장
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
