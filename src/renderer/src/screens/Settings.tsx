import { useState } from 'react'
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
import { defaultLlmConfig, saveLlmConfig } from '@core/session/prefs'
import { Icon } from '@core/ui/icons'
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

  const edit = (patch: Partial<LLMConfig>): void => {
    setDraft((d) => ({ ...d, ...patch }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    await saveLlmConfig(getStorage(), draft)
    onSaved(draft)
    setSaved(true)
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

            <TextField value={draft.model} onChange={(v) => edit({ model: v })} fullWidth>
              <Label>모델</Label>
              <Input placeholder={meta.defaultModel} />
            </TextField>

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
