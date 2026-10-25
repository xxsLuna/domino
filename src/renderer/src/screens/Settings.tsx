import { useEffect, useState } from 'react'
import {
  Button,
  Description,
  InputGroup,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextField
} from '@heroui/react'
import { PROVIDER_META, type LLMConfig, type ProviderId } from '@core/llm/types'
import {
  DEFAULT_TOKEN_WARN,
  defaultLlmConfig,
  loadTokenWarn,
  saveLlmConfig,
  saveTokenWarn
} from '@core/session/prefs'
import {
  clearAllDominoData,
  clearDominoData,
  clearTextCache,
  readStorageAudit,
  type DominoStorage,
  type StorageAudit
} from '@core/session/storageAudit'
import { Icon } from '@core/ui/icons'
import { getStorage, isElectron } from '../platform'

interface SettingsProps {
  config: LLMConfig
  onSaved: (config: LLMConfig) => void
  onClose: () => void
}

const PART_LABELS: Record<string, string> = {
  screens: '화면 캐시',
  views: '마지막 화면',
  history: '기록',
  graph: '관계도',
  schemas: 'API 스키마',
  token: '로그인 토큰'
}

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fmtWhen(at: number | null): string {
  if (!at) return ''
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Destructive actions confirm in place: the first press arms the button for
 * 4s (label flips to 확인), the second press runs — no nested modal inside
 * the settings dialog, no accidental one-tap data loss.
 */
function DangerConfirm({
  label,
  onConfirm,
  busy
}: {
  label: string
  onConfirm: () => Promise<void> | void
  busy?: boolean
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 4_000)
    return () => window.clearTimeout(t)
  }, [armed])
  return (
    <Button
      size="sm"
      variant={armed ? 'danger' : 'secondary'}
      isDisabled={busy}
      onPress={() => {
        if (armed) {
          setArmed(false)
          void onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {armed ? '확인' : label}
    </Button>
  )
}

function DominoRow({
  domino,
  busy,
  onCleared
}: {
  domino: DominoStorage
  busy: boolean
  onCleared: () => Promise<void> | void
}): React.JSX.Element {
  const host = domino.id.split('|')[1] || ''
  const parts = Object.entries(domino.parts)
  return (
    <div className="storage-row">
      <div className="storage-row-main">
        <div className="storage-row-title">
          <strong>{domino.name}</strong>
          {host ? <span className="text-xs text-muted">{host}</span> : null}
        </div>
        <div className="storage-parts">
          {parts.map(([part]) => (
            <span key={part} className="storage-part">
              {PART_LABELS[part] ?? part}
            </span>
          ))}
          <span className="storage-size">{fmtBytes(domino.bytes)}</span>
          {domino.lastUsed ? (
            <span className="text-xs text-muted">마지막 사용 {fmtWhen(domino.lastUsed)}</span>
          ) : null}
        </div>
      </div>
      <DangerConfirm label="데이터 초기화" onConfirm={onCleared} busy={busy} />
    </div>
  )
}

export function Settings({ config, onSaved, onClose }: SettingsProps): React.JSX.Element {
  const [draft, setDraft] = useState<LLMConfig>({ ...config })
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [tokenWarn, setTokenWarn] = useState<number>(DEFAULT_TOKEN_WARN)
  const [audit, setAudit] = useState<StorageAudit | null>(null)
  const [busy, setBusy] = useState(false)
  const meta = PROVIDER_META[draft.provider]

  useEffect(() => {
    const storage = getStorage()
    void (async () => {
      setTokenWarn(await loadTokenWarn(storage))
      setAudit(await readStorageAudit(storage))
    })()
  }, [])

  const refreshAudit = async (): Promise<void> => {
    setAudit(await readStorageAudit(getStorage()))
  }

  const runMaintenance = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await refreshAudit()
    } finally {
      setBusy(false)
    }
  }

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

  const edit = (patch: Partial<LLMConfig>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setSaveError(null)
    try {
      await saveLlmConfig(getStorage(), draft)
      onSaved(draft)
      setSaved(true)
    } catch (err) {
      // e.g. a corrupt secure store refuses to be overwritten
      setSaveError(`설정을 저장하지 못했습니다: ${(err as Error).message}`)
    }
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()} variant="blur">
      <Modal.Container size="md" placement="auto" scroll="inside">
        <Modal.Dialog aria-label="설정">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>설정</Modal.Heading>
            <p className="text-sm text-muted">
              LLM Provider (BYOK) — 직접 발급한 API 키를 사용합니다. 키는{' '}
              {isElectron()
                ? 'OS 키체인 기반 safeStorage로 암호화 저장되며'
                : '이 기기의 브라우저 저장소에만 저장되며(공용 PC 주의)'}{' '}
              서버로 전송되지 않습니다.
            </p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <Select
              value={draft.provider}
              onChange={(key) => key && pickProvider(key as ProviderId)}
              fullWidth
            >
              <Label>Provider</Label>
              <Select.Trigger>
                <Select.Value>{({ selectedText }) => selectedText}</Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Description>{meta.note}</Description>
              <Select.Popover>
                <ListBox>
                  {(Object.keys(PROVIDER_META) as ProviderId[]).map((id) => (
                    <ListBox.Item key={id} id={id} textValue={PROVIDER_META[id].label}>
                      <span className="flex flex-col">
                        <span>{PROVIDER_META[id].label}</span>
                        <span className="text-xs text-muted">{PROVIDER_META[id].endpoint}</span>
                      </span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <TextField value={draft.baseUrl ?? ''} onChange={(v) => edit({ baseUrl: v })} fullWidth>
              <Label>Base URL</Label>
              <Input placeholder={meta.defaultBaseUrl} />
            </TextField>
            <p className="-mt-2 text-xs text-muted">
              이 주소는 LLM 호출 전용입니다 — 앱이 직접 부르는 비즈니스 API 주소는 .domino 파일의
              [api] base_url을 따릅니다.
            </p>

            <TextField value={draft.model} onChange={(v) => edit({ model: v })} fullWidth>
              <Label>모델</Label>
              <Input placeholder={meta.defaultModel} />
            </TextField>

            <div className="flex flex-col gap-1">
              <span className="text-sm">
                Temperature{' '}
                <span className="text-muted">({(draft.temperature ?? 0.7).toFixed(1)})</span>
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature ?? 0.7}
                onChange={(e) => edit({ temperature: Number(e.target.value) })}
                aria-label="Temperature"
                className="h-2 w-full cursor-pointer accent-[var(--accent)]"
              />
              <span className="text-xs text-muted">
                낮을수록 일관되고 높을수록 다양해집니다 (0–2).
              </span>
            </div>

            <TextField
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey ?? ''}
              onChange={(v) => edit({ apiKey: v })}
              autoComplete="off"
              fullWidth
            >
              <Label>API 키 (BYOK)</Label>
              <InputGroup fullWidth>
                <InputGroup.Prefix>
                  <Icon name="key" className="text-muted" />
                </InputGroup.Prefix>
                <InputGroup.Input placeholder={meta.keyHint} />
                <InputGroup.Suffix>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={showKey ? '키 숨기기' : '키 보기'}
                    onPress={() => setShowKey((v) => !v)}
                  >
                    <Icon name="eye" />
                  </Button>
                </InputGroup.Suffix>
              </InputGroup>
            </TextField>

            <TextField
              value={String(tokenWarn)}
              onChange={(v) => {
                const n = Number(v)
                if (Number.isFinite(n) && n >= 0) {
                  setTokenWarn(Math.round(n))
                  // A guard setting must never wait for another 저장 press.
                  void saveTokenWarn(getStorage(), Math.round(n))
                }
              }}
              fullWidth
            >
              <Label>세션 토큰 경고 임계값 (0 = 끔)</Label>
              <Input type="number" min={0} step={10000} />
              <Description>
                한 세션에서 누적 사용 토큰이 이 값을 넘으면 앱 화면에 경고 배너를 띄웁니다.
              </Description>
            </TextField>

            {/* ------------------------ domino 관리 ------------------------ */}
            <section aria-label="domino 관리" className="storage-section">
              <h4 className="storage-heading">domino 관리</h4>
              <p className="text-xs text-muted">
                기기에 저장된 각 domino의 데이터(화면 캐시 · 마지막 화면 · 기록 · 관계도 · API
                스키마 · 로그인 토큰)를 확인하고 지웁니다. LLM 설정과 원본 정의는 유지되며, 지운
                앱은 다음 실행 때 처음부터 다시 만들어집니다.
              </p>

              {audit === null ? (
                <p className="text-xs text-muted">
                  이 환경의 저장소에서는 용량 조회를 지원하지 않습니다.
                </p>
              ) : audit.dominoes.length === 0 ? (
                <p className="text-xs text-muted">저장된 domino 데이터가 없습니다.</p>
              ) : (
                <>
                  <p className="storage-summary">
                    <Icon name="box" size={14} /> 도미노 {audit.dominoes.length}개 · 전체{' '}
                    {fmtBytes(audit.totalBytes)}
                  </p>
                  {audit.dominoes.map((d) => (
                    <DominoRow
                      key={d.id}
                      domino={d}
                      busy={busy}
                      onCleared={() => runMaintenance(() => clearDominoData(getStorage(), d.id))}
                    />
                  ))}
                </>
              )}

              {audit && (audit.texts.keys > 0 || audit.dominoes.length > 0) ? (
                <div className="storage-row storage-row--maintenance">
                  <div className="storage-row-main">
                    <div className="storage-row-title">
                      <strong>원본 캐시</strong>
                      <span className="storage-size">{fmtBytes(audit.texts.bytes)}</span>
                    </div>
                    <span className="text-xs text-muted">
                      불러온 .domino 원문 {audit.texts.keys}건 — 지워도 최근 목록에서 다시
                      불러옵니다.
                    </span>
                  </div>
                  <DangerConfirm
                    label="캐시 정리"
                    onConfirm={() => runMaintenance(() => clearTextCache(getStorage()))}
                    busy={busy}
                  />
                </div>
              ) : null}

              {audit && audit.dominoes.length > 0 ? (
                <div className="storage-row storage-row--maintenance">
                  <div className="storage-row-main">
                    <div className="storage-row-title">
                      <strong>전체 도미노 데이터 초기화</strong>
                    </div>
                    <span className="text-xs text-muted">
                      모든 domino의 저장 데이터를 지웁니다 (LLM 키 · 설정은 유지).
                    </span>
                  </div>
                  <DangerConfirm
                    label="전체 초기화"
                    onConfirm={() => runMaintenance(() => clearAllDominoData(getStorage()))}
                    busy={busy}
                  />
                </div>
              ) : null}
            </section>
          </Modal.Body>
          <Modal.Footer className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="tertiary"
              onPress={() => {
                setDraft({ ...defaultLlmConfig(), provider: draft.provider })
                setSaved(false)
              }}
            >
              기본값 복원
            </Button>
            <div className="flex items-center gap-3">
              {saveError ? (
                <span className="text-sm text-danger" role="alert">
                  {saveError}
                </span>
              ) : null}
              {saved ? (
                <span className="flex items-center gap-1 text-sm text-success" role="status">
                  <Icon name="check" /> 저장됨
                </span>
              ) : null}
              <Button onPress={() => void save()}>저장</Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
