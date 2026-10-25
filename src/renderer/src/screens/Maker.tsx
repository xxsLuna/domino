import { useRef, useState } from 'react'
import { Button, Card, Chip, Label, Spinner, TextArea, TextField, Tooltip } from '@heroui/react'
import { createAdapter, needsApiKey, type ChatMessage, type LLMConfig } from '@core/llm'
import { formatAnswers, runMakerTurn, type MakerQuestion, type MakerStep } from '@core/maker/maker'
import { Alert } from '@core/ui/components'
import { Icon } from '@core/ui/icons'
import { t } from '../i18n'

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

/**
 * One-tap starting points: a rich, well-specified description beats a blank
 * textarea — picking a tile drops a complete brief into the composer.
 */
const TEMPLATES: Array<{ key: string; icon: string; title: string; desc: string; prompt: string }> =
  [
    {
      key: 't1',
      icon: 'list',
      title: '할 일 · 업무 관리',
      desc: '목록 · 상태 변경 · 담당자',
      prompt:
        '팀 할 일 관리 앱. GET /tasks 가 [{id, title, assignee, status(todo|doing|done), due}] 목록을 주고, POST /tasks {title, assignee} 로 새 할 일을 만들고, POST /tasks/:id/status {status} 로 상태를 바꾼다. 화면: 오늘 할 일 목록(상태 칩), 새 할 일 폼, 담당자별 필터. 로그인 없음.'
    },
    {
      key: 't2',
      icon: 'inbox',
      title: '실시간 RSS 리더',
      desc: '주소 입력 → 라이브 피드 스택',
      prompt:
        '원하는 RSS 주소를 입력하면 그 피드가 실시간으로 갱신되는 구독 앱. [data] 로 feed = GET /feed?url={rssUrl} every 20s 를 선언하고, 입력 폼(id add-feed-form)은 [actions] 로 set rssUrl = form.url ; refresh feed ; goto feed 를 실행한다. 피드 화면의 기사 목록은 {"$data": "feed.items"} 로 바인딩하고 새로고침 버튼(id feed-refresh)은 refresh feed. 페이지: 구독 입력(main), 실시간 피드(feed), 저장함(saved).'
    },
    {
      key: 't3',
      icon: 'chart',
      title: '매출 대시보드',
      desc: 'KPI · 추이 · 최근 주문',
      prompt:
        '소규모 쇼핑몰 매출 대시보드. GET /stats 가 {todayRevenue, orders, avgOrder, topProducts[{name, qty}]}를 주고 GET /orders?limit=10 이 최근 주문 [{id, customer, total, status}]를 준다. 화면: KPI 카드 4개, 상품별 BarChart/Progress, 최근 주문 표. 로그인 없음, 다크 톤 강조색 #0ea5e9.'
    },
    {
      key: 't4',
      icon: 'file',
      title: '게시판 · 문서',
      desc: '목록 · 상세 · 새 글',
      prompt:
        '팀 공지 게시판. GET /posts 가 [{id, title, author, tags, updatedAt}] 목록, GET /posts/:id 가 {title, author, body, tags} 를 주고 POST /posts {title, body, tags} 로 새 글을 쓴다. 화면: 검색+태그 필터가 있는 목록, 글 상세, 새 글 작성 폼. 로그인 없음.'
    },
    {
      key: 't5',
      icon: 'users',
      title: '고객 관리 (CRM)',
      desc: '리드 목록 · 상세 · 후속조치',
      prompt:
        '영업팀 리드 관리. 로그인 필수 — POST /login {email, password} → access_token. GET /leads 가 [{id, name, company, stage, value, owner}] 를 주고 POST /leads {name, company, value} 로 리드를 추가하며 POST /leads/:id/stage {stage} 로 단계를 옮긴다. 화면: 파이프라인 대시보드(KPI+단계별 표), 리드 상세(탭: 정보/활동), 새 리드 폼, 설정.'
    },
    {
      key: 't6',
      icon: 'check',
      title: '신청 · 승인 워크플로',
      desc: '신청서 → 승인/반려',
      prompt:
        '사내 비품 신청 앱. 직원 로그인(POST /login {email, password} → access_token). GET /requests 가 내 신청 [{id, item, reason, status, createdAt}], POST /requests {item, reason} 로 신청, POST /requests/:id/decision {approve, note} 는 관리자만. 화면: 내 신청 목록, 새 신청 폼, 관리자 승인 대기 목록(승인/반려 버튼).'
    }
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

  const needsKey = needsApiKey(config)

  const step = async (userMessage: string): Promise<void> => {
    const mine = ++run.current
    setError(null)
    setPhase({ kind: 'working' })
    history.current.push({ role: 'user', content: userMessage })
    // Without this catch a network/provider failure leaves the UI wedged on
    // "working" and the rejection goes unhandled.
    try {
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
    } catch (err) {
      if (run.current !== mine) return
      setError((err as Error).message)
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

  /** Skip the questions: every blank already means "알아서" — send them all. */
  const decideAll = (questions: MakerQuestion[]): void => {
    setRounds((r) => [...r, { questions, answers: {} }])
    void step(formatAnswers(questions, {}))
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
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError(t('maker.clipboardFail'))
    }
  }

  return (
    <div className="welcome">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Tooltip delay={600}>
            <Button isIconOnly variant="ghost" aria-label={t('maker.home')} onPress={onBack}>
              <Icon name="back" size={18} />
            </Button>
            <Tooltip.Content>{t('maker.home')}</Tooltip.Content>
          </Tooltip>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">domino maker</h1>
            <p className="text-sm text-muted">{t('maker.subtitle')}</p>
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

      {needsKey ? (
        <Card>
          <Card.Content className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className="flex-1 text-sm">{t('maker.needKey')}</p>
            <Button variant="secondary" onPress={onOpenSettings}>
              <Icon name="key" />
              {t('maker.openSettings')}
            </Button>
          </Card.Content>
        </Card>
      ) : null}

      {error ? (
        <Alert
          variant="danger"
          title={t('maker.failTitle')}
          message={error}
          onClose={() => setError(null)}
        />
      ) : null}

      {phase.kind === 'compose' ? (
        <Card>
          <Card.Header>
            <Card.Title>{t('maker.composeTitle')}</Card.Title>
            <Card.Description>{t('maker.composeDesc')}</Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-3">
            <TextField
              value={description}
              onChange={setDescription}
              aria-label={t('maker.descAria')}
              fullWidth
            >
              <TextArea rows={9} placeholder={t('maker.composePlaceholder')} />
            </TextField>
            <div className="maker-templates" aria-label={t('maker.templatesAria')}>
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.title}
                  type="button"
                  className="maker-template"
                  onClick={() => setDescription(`${tpl.prompt}\n\n${t('maker.templateLangNote')}`)}
                  title={tpl.prompt}
                >
                  <Icon name={tpl.icon} size={18} />
                  <span className="maker-template-text">
                    <strong>{t(`maker.${tpl.key}.title`)}</strong>
                    <span>{t(`maker.${tpl.key}.desc`)}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <Button onPress={start} isDisabled={!description.trim() || needsKey}>
                <Icon name="rocket" />
                {t('maker.make')}
              </Button>
            </div>
          </Card.Content>
        </Card>
      ) : (
        <Card>
          <Card.Content className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted">{t('maker.summaryLabel')}</p>
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm">{description}</p>
              </div>
              <Button size="sm" variant="ghost" onPress={reset}>
                {t('maker.reset')}
              </Button>
            </div>
            {rounds.map((round, i) => (
              <div key={i} className="border-t border-separator pt-3">
                <p className="text-xs font-medium text-muted">{t('maker.answers', { n: i + 1 })}</p>
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {round.questions.map((q) => (
                    <li key={q.id}>
                      <span className="text-muted">{q.question}</span>{' '}
                      <span>{round.answers[q.id]?.trim() || t('maker.anyAnswer')}</span>
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
              {phase.draft ? t('maker.workingWrite') : t('maker.workingRead')}
            </p>
            {phase.draft ? <pre className="maker-code">{phase.draft}</pre> : null}
          </Card.Content>
        </Card>
      ) : null}

      {phase.kind === 'failed' ? (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={reset}>
            {t('maker.reset')}
          </Button>
          <Button onPress={() => void step('Please continue from where you stopped.')}>
            <Icon name="refresh" />
            {t('maker.retry')}
          </Button>
        </div>
      ) : null}

      {phase.kind === 'questions' ? (
        <Card>
          <Card.Header>
            <Card.Title>{t('maker.questionsTitle')}</Card.Title>
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
                      placeholder={q.placeholder ?? t('maker.answerPlaceholder')}
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
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onPress={() => decideAll(phase.step.questions)}
                >
                  {t('maker.decideAll')}
                </Button>
                <Button type="submit">
                  <Icon name="send" />
                  {t('maker.sendAnswers')}
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
                <Chip.Label>{t('maker.validated')}</Chip.Label>
              </Chip>
            </div>
            {phase.step.summary ? <Card.Description>{phase.step.summary}</Card.Description> : null}
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            {phase.step.assumptions.length ? (
              <div className="rounded-2xl bg-default p-3 text-sm">
                <p className="mb-1 font-medium">{t('maker.assumptions')}</p>
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
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
              <Button variant="secondary" onPress={() => save(phase.step.name, phase.step.content)}>
                <Icon name="download" />
                {t('maker.saveFile')}
              </Button>
              <Button onPress={() => onOpenDomino(phase.step.content)}>
                <Icon name="rocket" />
                {t('maker.runNow')}
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
                <Label>{t('maker.refineLabel')}</Label>
                <TextArea rows={2} placeholder={t('maker.refinePlaceholder')} />
              </TextField>
              <div className="flex justify-end">
                <Button type="submit" variant="secondary" isDisabled={!refine.trim()}>
                  {t('maker.refineSubmit')}
                </Button>
              </div>
            </form>
          </Card.Content>
        </Card>
      ) : null}
    </div>
  )
}
