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
  Switch,
  TextField
} from '@heroui/react'
import { PROVIDER_META, type LLMConfig, type ProviderId } from '@core/llm/types'
import {
  DEFAULT_TOKEN_WARN,
  clearDominoLlmConfig,
  loadDominoLlmConfig,
  saveDominoLlmConfig,
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
import { t, useI18n, LANGUAGES, type LangPref } from '../i18n'
import type { MessageKey } from '../i18nMessages'

interface SettingsProps {
  config: LLMConfig
  /** Open domino — enables the per-domino LLM override section. */
  dominoId?: string | null
  onSaved: (config: LLMConfig) => void
  /** Called after the per-domino override is saved or cleared. */
  onDominoChanged?: () => void
  onClose: () => void
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
      {armed ? t('common.confirm') : label}
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
              {t(`set.part${part[0].toUpperCase()}${part.slice(1)}` as MessageKey)}
            </span>
          ))}
          <span className="storage-size">{fmtBytes(domino.bytes)}</span>
          {domino.lastUsed ? (
            <span className="text-xs text-muted">
              {t('set.lastUsed', { when: fmtWhen(domino.lastUsed) })}
            </span>
          ) : null}
        </div>
      </div>
      <DangerConfirm label={t('set.mgmtClear')} onConfirm={onCleared} busy={busy} />
    </div>
  )
}

export function Settings({
  config,
  dominoId,
  onSaved,
  onDominoChanged,
  onClose
}: SettingsProps): React.JSX.Element {
  const [draft, setDraft] = useState<LLMConfig>({ ...config })
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [tokenWarn, setTokenWarn] = useState<number>(DEFAULT_TOKEN_WARN)
  const [audit, setAudit] = useState<StorageAudit | null>(null)
  const [busy, setBusy] = useState(false)
  // Per-domino override: independent draft so saving the global tab never
  // accidentally rewrites the override (and vice versa).
  const [useOverride, setUseOverride] = useState(false)
  const [ovDraft, setOvDraft] = useState<LLMConfig | null>(null)
  const meta = PROVIDER_META[draft.provider]
  const { pref, setPref } = useI18n()

  useEffect(() => {
    const storage = getStorage()
    void (async () => {
      setTokenWarn(await loadTokenWarn(storage))
      setAudit(await readStorageAudit(storage))
      if (dominoId) {
        const existing = await loadDominoLlmConfig(storage, dominoId)
        if (existing) {
          setUseOverride(true)
          setOvDraft(existing)
        } else {
          setOvDraft({ ...config })
        }
      }
    })()
    // Only when the dialog (re)opens for a domino — config edits don't re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dominoId])

  const toggleOverride = (on: boolean): void => {
    setUseOverride(on)
    if (!dominoId) return
    if (on) {
      setOvDraft((d) => d ?? { ...config })
      return
    }
    void (async () => {
      await clearDominoLlmConfig(getStorage(), dominoId)
      onDominoChanged?.()
    })()
  }

  const saveOverride = async (): Promise<void> => {
    if (!dominoId || !ovDraft) return
    setSaveError(null)
    try {
      await saveDominoLlmConfig(getStorage(), dominoId, ovDraft)
      onDominoChanged?.()
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2_000)
    } catch (err) {
      setSaveError(t('set.saveFail', { msg: (err as Error).message }))
    }
  }

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
      setSaveError(t('set.saveFail', { msg: (err as Error).message }))
    }
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()} variant="blur">
      <Modal.Container size="md" placement="auto" scroll="inside">
        <Modal.Dialog aria-label={t('common.settings')}>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{t('common.settings')}</Modal.Heading>
            <p className="text-sm text-muted">
              LLM Provider (BYOK) — {isElectron() ? t('set.llmDescElectron') : t('set.llmDescWeb')}{' '}
              {t('set.llmDescTail')}
            </p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <Select
              value={draft.provider}
              onChange={(key) => key && pickProvider(key as ProviderId)}
              fullWidth
            >
              <Label>{t('set.provider')}</Label>
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
              <Label>{t('set.baseUrl')}</Label>
              <Input placeholder={meta.defaultBaseUrl} />
            </TextField>
            <p className="-mt-2 text-xs text-muted">{t('set.baseUrlNote')}</p>

            <TextField value={draft.model} onChange={(v) => edit({ model: v })} fullWidth>
              <Label>{t('set.model')}</Label>
              <Input placeholder={meta.defaultModel} />
            </TextField>

            <div className="flex flex-col gap-1">
              <span className="text-sm">
                {t('set.temp')}{' '}
                <span className="text-muted">({(draft.temperature ?? 0.7).toFixed(1)})</span>
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature ?? 0.7}
                onChange={(e) => edit({ temperature: Number(e.target.value) })}
                aria-label={t('set.temp')}
                className="h-2 w-full cursor-pointer accent-[var(--accent)]"
              />
              <span className="text-xs text-muted">{t('set.tempNote')}</span>
            </div>

            <TextField
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey ?? ''}
              onChange={(v) => edit({ apiKey: v })}
              autoComplete="off"
              fullWidth
            >
              <Label>{t('set.apiKey')}</Label>
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
                    aria-label={showKey ? t('set.hideKey') : t('set.showKey')}
                    onPress={() => setShowKey((v) => !v)}
                  >
                    <Icon name="eye" />
                  </Button>
                </InputGroup.Suffix>
              </InputGroup>
            </TextField>

            <Select value={pref} onChange={(key) => key && setPref(key as LangPref)} fullWidth>
              <Label>{t('set.lang')}</Label>
              <Select.Trigger>
                <Select.Value>{({ selectedText }) => selectedText}</Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Description>{t('set.langNote')}</Description>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item key="auto" id="auto" textValue={t('set.langAuto')}>
                    <span>{t('set.langAuto')}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  {LANGUAGES.map((l) => (
                    <ListBox.Item key={l.id} id={l.id} textValue={l.label}>
                      <span>{l.label}</span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

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
              <Label>{t('set.tokenWarn')}</Label>
              <Input type="number" min={0} step={10000} />
              <Description>{t('set.tokenWarnNote')}</Description>
            </TextField>

            {dominoId ? (
              <section aria-label={t('set.dominoLlmTitle')} className="storage-section">
                <Switch
                  isSelected={useOverride}
                  onChange={toggleOverride}
                  aria-label={t('set.dominoLlmTitle')}
                >
                  <Switch.Content className="flex w-full items-center justify-between gap-4">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium">{t('set.dominoLlmTitle')}</span>
                      <span className="text-xs text-muted">{t('set.dominoLlmNote')}</span>
                    </span>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
                {useOverride && ovDraft ? (
                  <div className="storage-row storage-row--override">
                    <Select
                      value={ovDraft.provider}
                      onChange={(key) =>
                        key && setOvDraft((d) => d && { ...d, provider: key as ProviderId })
                      }
                      fullWidth
                    >
                      <Label>{t('set.provider')}</Label>
                      <Select.Trigger>
                        <Select.Value>{({ selectedText }) => selectedText}</Select.Value>
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {(Object.keys(PROVIDER_META) as ProviderId[]).map((id) => (
                            <ListBox.Item key={id} id={id} textValue={PROVIDER_META[id].label}>
                              <span>{PROVIDER_META[id].label}</span>
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    <TextField
                      value={ovDraft.baseUrl ?? ''}
                      onChange={(v) => setOvDraft((d) => d && { ...d, baseUrl: v })}
                      fullWidth
                    >
                      <Label>{t('set.baseUrl')}</Label>
                      <Input placeholder={PROVIDER_META[ovDraft.provider].defaultBaseUrl} />
                    </TextField>
                    <TextField
                      value={ovDraft.model}
                      onChange={(v) => setOvDraft((d) => d && { ...d, model: v })}
                      fullWidth
                    >
                      <Label>{t('set.model')}</Label>
                      <Input placeholder={PROVIDER_META[ovDraft.provider].defaultModel} />
                    </TextField>
                    <TextField
                      value={ovDraft.apiKey ?? ''}
                      onChange={(v) => setOvDraft((d) => d && { ...d, apiKey: v })}
                      type="password"
                      autoComplete="off"
                      fullWidth
                    >
                      <Label>{t('set.apiKey')}</Label>
                      <Input placeholder={t('set.ovKeyHint')} />
                    </TextField>
                    <div className="flex justify-end">
                      <Button size="sm" onPress={() => void saveOverride()}>
                        {t('set.dominoLlmSave')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* ------------------------ domino 관리 ------------------------ */}
            <section aria-label="domino 관리" className="storage-section">
              <h4 className="storage-heading">{t('set.mgmtTitle')}</h4>
              <p className="text-xs text-muted">{t('set.mgmtDesc')}</p>

              {audit === null ? (
                <p className="text-xs text-muted">{t('set.mgmtUnsupported')}</p>
              ) : audit.dominoes.length === 0 ? (
                <p className="text-xs text-muted">{t('set.mgmtNone')}</p>
              ) : (
                <>
                  <p className="storage-summary">
                    <Icon name="box" size={14} />{' '}
                    {t('set.mgmtSummary', {
                      n: audit.dominoes.length,
                      size: fmtBytes(audit.totalBytes)
                    })}
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
                      <strong>{t('set.textsTitle')}</strong>
                      <span className="storage-size">{fmtBytes(audit.texts.bytes)}</span>
                    </div>
                    <span className="text-xs text-muted">
                      {t('set.textsDesc', { n: audit.texts.keys })}
                    </span>
                  </div>
                  <DangerConfirm
                    label={t('set.textsClear')}
                    onConfirm={() => runMaintenance(() => clearTextCache(getStorage()))}
                    busy={busy}
                  />
                </div>
              ) : null}

              {audit && audit.dominoes.length > 0 ? (
                <div className="storage-row storage-row--maintenance">
                  <div className="storage-row-main">
                    <div className="storage-row-title">
                      <strong>{t('set.allTitle')}</strong>
                    </div>
                    <span className="text-xs text-muted">{t('set.allDesc')}</span>
                  </div>
                  <DangerConfirm
                    label={t('set.allBtn')}
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
              {t('set.restore')}
            </Button>
            <div className="flex items-center gap-3">
              {saveError ? (
                <span className="text-sm text-danger" role="alert">
                  {saveError}
                </span>
              ) : null}
              {saved ? (
                <span className="flex items-center gap-1 text-sm text-success" role="status">
                  <Icon name="check" /> {t('set.saved')}
                </span>
              ) : null}
              <Button onPress={() => void save()}>{t('set.save')}</Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
