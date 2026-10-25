import { describe, expect, it } from 'vitest'
import { detectSpecLanguage } from './specLang'
import type { UiSpec } from './spec'

const specWith = (text: string): UiSpec =>
  ({
    version: 1,
    page: 'main',
    pages: [
      {
        id: 'main',
        name: 'Main',
        layout: [
          {
            name: 'Card',
            id: 'c',
            children: [
              { name: 'Paragraph', id: 'p', props: { text } },
              { name: 'Button', id: 'b', props: { text: 'OK' } }
            ]
          }
        ]
      }
    ]
  }) as UiSpec

describe('detectSpecLanguage', () => {
  it('detects the five UI languages by script', () => {
    expect(detectSpecLanguage(specWith('실시간 피드를 확인하세요'))).toBe('ko')
    expect(detectSpecLanguage(specWith('今日のタスクを確認する'))).toBe('ja')
    expect(detectSpecLanguage(specWith('查看今天的任务列表'))).toBe('zh')
    expect(detectSpecLanguage(specWith('Проверить задачи на сегодня'))).toBe('ru')
    expect(detectSpecLanguage(specWith('Check the tasks for today'))).toBe('en')
  })

  it('hangul wins over incidental hanja/latin, kana wins over han', () => {
    const mixed = specWith('할 일 목록 — Task 管理 화면')
    expect(detectSpecLanguage(mixed)).toBe('ko')
    const jaMixed = specWith('タスク一覧 — 管理')
    expect(detectSpecLanguage(jaMixed)).toBe('ja')
  })

  it('returns null when there is too little text to decide', () => {
    // A screen whose only strings are digits/code — nothing script-shaped.
    const bare = {
      version: 1,
      page: 'a',
      pages: [{ id: 'a', name: '123', layout: [{ name: 'Paragraph', id: 'p', props: { text: '456 789' } }] }]
    } as UiSpec
    expect(detectSpecLanguage(bare)).toBeNull()
  })
})
