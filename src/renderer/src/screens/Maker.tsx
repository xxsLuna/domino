import { useRef, useState } from 'react'
import { Button, Card, Chip, Label, Spinner, TextArea, TextField, Tooltip } from '@heroui/react'
import { createAdapter, type ChatMessage, type LLMConfig } from '@core/llm'
import { formatAnswers, runMakerTurn, type MakerQuestion, type MakerStep } from '@core/maker/maker'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'

interface MakerProps {
  config: LLMConfig
  onBack: () => void
  onOpenSettings: () => void
  /** Open the finished file in the runtime. */
  onOpenDomino: (text: string) => void
}

type Phase =
  | { kind: 'compose' }
  | { kind: 'working'; draft?: string }
  | { kind: 'failed' }
  | { kind: 'questions'; step: Extract<MakerStep, { type: 'questions' }> }
  | { kind: 'result'; step: Extract<MakerStep, { type: 'domino' }> }

interface Round {
  questions: MakerQuestion[]
  answers: Record<string, string>
}

const EXAMPLES = [
  '사내 비품 신청 앱. 직원이 로그인해서 비품을 신청하고, 관리자는 승인/반려한다. API는 https://api.example.com 에 있고 /login 은 email, password를 받아 access_token을 준다.',
  '내 블로그 글 관리 화면. GET /posts 는 글 목록(id, title, status, updatedAt)을 주고, POST /posts 로 새 글을 만든다. 로그인은 없다.',
  'A personal habit tracker: daily check-ins, streaks and a weekly summary chart. No backend yet.'
]

export function Maker({
  config,
  onBack,
  onOpenSettings,
  onOpenDomino
}: MakerProps): React.JSX.Element {
  const [description, setDescription] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' })
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [rounds, setRounds] = useState<Round[]>([])
  const [refine, setRefine] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const history = useRef<ChatMessage[]>([])
  const run = useRef(0)

  const needsKey = !config.apiKey && !/localhost|127\.0\.0\.1/.test(config.baseUrl ?? '')

  const step = async (userMessage: string): Promise<void> => {
    const mine = ++run.current
    setError(null)
    setPhase({ kind: 'working' })
    history.current.push({ role: 'user', content: userMessage })
    const result = await runMakerTurn({
      adapter: createAdapter(config),
      history: history.current,
      onProgress: (p) => {
        if (run.current === mine && p.draft) setPhase({ kind: 'working', draft: p.draft })
      }
    })
    if (run.current !== mine) return
    if (result.type === 'questions') {
      setAnswers({})
      setPhase({ kind: 'questions', step: result })
    } else if (result.type === 'domino') {
      setRefine('')
      setPhase({ kind: 'result', step: result })
    } else {
      setError(result.message)
      setPhase(
        history.current.some((m) => m.role === 'assistant')
          ? { kind: 'failed' }
          : { kind: 'compose' }
      )
    }
  }

  const start = (): void => {
    history.current = []
    setRounds([])
    void step(description.trim())
  }

  const submitAnswers = (questions: MakerQuestion[]): void => {
    setRounds((r) => [...r, { questions, answers }])
    void step(formatAnswers(questions, answers))
  }

  const reset = (): void => {
    run.current++
    history.current = []
    setRounds([])
    setError(null)
    setPhase({ kind: 'compose' })
  }

  const save = (name: string, content: string): void => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.domino`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const copy = async (content: string): Promise<void> => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="welcome">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Tooltip delay={600}>
            <Button isIconOnly variant="ghost" aria-label="홈으로" onPress={onBack}>
              <Icon name="back" size={18} />
            </Button>
            <Tooltip.Content>홈으로</Tooltip.Content>
          </Tooltip>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">domino maker</h1>
            <p className="text-sm text-muted">설명을 .domino 파일로 바꿉니다</p>
          </div>
        </div>
        <Tooltip delay={600}>
          <Button isIconOnly variant="secondary" aria-label="설정" onPress={onOpenSettings}>
            <Icon name="settings" size={18} />
          </Button>
          <Tooltip.Content>설정</Tooltip.Content>
        </Tooltip>
      </header>

      {needsKey ? (
        <Card>
          <Card.Content className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className="flex-1 text-sm">
              domino maker는 설정에 등록한 LLM으로 파일을 만듭니다. 먼저 Provider와 API 키를 등록해
              주세요.
            </p>
            <Button variant="secondary" onPress={onOpenSettings}>
              <Icon name="key" />
              설정 열기
            </Button>
          </Card.Content>
        </Card>
      ) : null}

      {error ? (
        <Alert
          variant="danger"
          title="만들지 못했습니다"
          message={error}
          onClose={() => setError(null)}
        />
      ) : null}

      {phase.kind === 'compose' ? (
        <Card>
          <Card.Header>
            <Card.Title>어떤 앱을 만들까요?</Card.Title>
            <Card.Description>
              서비스가 무엇인지, 어떤 API에 무엇을 보내면 어떻게 되어야 하는지, 필요한 화면을
              자유롭게 적어 주세요. 부족한 정보는 이어서 물어봅니다.
            </Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-3">
            <TextField value={description} onChange={setDescription} aria-label="앱 설명" fullWidth>
              <TextArea
                rows={9}
                placeholder="예) 우리 팀 휴가 신청 앱이야. /api/leaves 에 GET 하면 신청 목록이 오고…"
              />
            </TextField>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  type="button"
                  className="max-w-full cursor-pointer truncate rounded-full bg-default px-3 py-1 text-left text-xs text-muted transition-colors hover:text-foreground"
                  onClick={() => setDescription(ex)}
                  title={ex}
                >
                  예시 {i + 1}: {ex.slice(0, 28)}…
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <Button onPress={start} isDisabled={!description.trim() || needsKey}>
                <Icon name="rocket" />
                만들기
              </Button>
            </div>
          </Card.Content>
        </Card>
      ) : (
        <Card>
          <Card.Content className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted">설명</p>
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm">{description}</p>
              </div>
              <Button size="sm" variant="ghost" onPress={reset}>
                처음부터
              </Button>
            </div>
            {rounds.map((round, i) => (
              <div key={i} className="border-t border-separator pt-3">
                <p className="text-xs font-medium text-muted">답변 {i + 1}</p>
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {round.questions.map((q) => (
                    <li key={q.id}>
                      <span className="text-muted">{q.question}</span>{' '}
                      <span>{round.answers[q.id]?.trim() || '알아서'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card.Content>
        </Card>
      )}

      {phase.kind === 'working' ? (
        <Card>
          <Card.Content className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-muted" role="status">
              <Spinner size="sm" />
              {phase.draft ? '.domino 파일을 작성하는 중…' : '설명을 읽고 정리하는 중…'}
            </p>
            {phase.draft ? <pre className="maker-code">{phase.draft}</pre> : null}
          </Card.Content>
        </Card>
      ) : null}

      {phase.kind === 'failed' ? (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={reset}>
            처음부터
          </Button>
          <Button onPress={() => void step('Please continue from where you stopped.')}>
            <Icon name="refresh" />
            이어서 다시 시도
          </Button>
        </div>
      ) : null}

      {phase.kind === 'questions' ? (
        <Card>
          <Card.Header>
            <Card.Title>조금만 더 알려 주세요</Card.Title>
            {phase.step.intro ? <Card.Description>{phase.step.intro}</Card.Description> : null}
          </Card.Header>
          <Card.Content>
            <form
              className="flex flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault()
                submitAnswers(phase.step.questions)
              }}
            >
              {phase.step.questions.map((q) => (
                <div key={q.id} className="flex flex-col gap-2">
                  <TextField
                    value={answers[q.id] ?? ''}
                    onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                    variant="secondary"
                    fullWidth
                  >
                    <Label>{q.question}</Label>
                    <TextArea
                      rows={2}
                      placeholder={q.placeholder ?? '모르면 비워 두세요 — 알아서 정합니다'}
                    />
                  </TextField>
                  {q.why ? <p className="text-xs text-muted">{q.why}</p> : null}
                  {q.options?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {q.options.map((o) => (
                        <button
                          key={o}
                          type="button"
                          className="cursor-pointer"
                          onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}
                        >
                          <Chip
                            size="sm"
                            variant={answers[q.id] === o ? 'primary' : 'soft'}
                            color="accent"
                          >
                            {o}
                          </Chip>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              <div className="flex justify-end">
                <Button type="submit">
                  <Icon name="send" />
                  답변 보내기
                </Button>
              </div>
            </form>
          </Card.Content>
        </Card>
      ) : null}

      {phase.kind === 'result' ? (
        <Card>
          <Card.Header>
            <div className="flex flex-wrap items-center gap-2">
              <Card.Title>{phase.step.name}.domino</Card.Title>
              <Chip size="sm" variant="soft" color="success">
                <Icon name="check" size={12} />
                <Chip.Label>검증 완료</Chip.Label>
              </Chip>
            </div>
            {phase.step.summary ? <Card.Description>{phase.step.summary}</Card.Description> : null}
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            {phase.step.assumptions.length ? (
              <div className="rounded-2xl bg-default p-3 text-sm">
                <p className="mb-1 font-medium">임의로 정한 부분</p>
                <ul className="list-disc pl-5 text-muted">
                  {phase.step.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <pre className="maker-code">{phase.step.content}</pre>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onPress={() => void copy(phase.step.content)}>
                <Icon name={copied ? 'check' : 'copy'} />
                {copied ? '복사됨' : '복사'}
              </Button>
              <Button variant="secondary" onPress={() => save(phase.step.name, phase.step.content)}>
                <Icon name="download" />
                파일로 저장
              </Button>
              <Button onPress={() => onOpenDomino(phase.step.content)}>
                <Icon name="rocket" />
                바로 실행
              </Button>
            </div>
            <form
              className="flex flex-col gap-2 border-t border-separator pt-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (refine.trim()) void step(refine.trim())
              }}
            >
              <TextField value={refine} onChange={setRefine} variant="secondary" fullWidth>
                <Label>고치고 싶은 점</Label>
                <TextArea rows={2} placeholder="예) 관리자 화면에 통계 차트를 추가해 줘" />
              </TextField>
              <div className="flex justify-end">
                <Button type="submit" variant="secondary" isDisabled={!refine.trim()}>
                  다시 만들기
                </Button>
              </div>
            </form>
          </Card.Content>
        </Card>
      ) : null}
    </div>
  )
}
