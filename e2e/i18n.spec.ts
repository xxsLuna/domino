import { expect, test } from '@playwright/test'
import { login, openExample, seedMockLlm, waitForQuietStats } from './helpers'

/**
 * Language UX + settings management coverage:
 * - the UI language seeds are honored (Korean suite default)
 * - an English domino under a Korean UI gets the ONE-SHOT re-translate offer
 * - settings carries the domino management section with real rows
 * - the maker ships the template gallery
 */

test.describe('language & management', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('welcome follows the persisted language preference', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('domino:lang', 'en')
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Open a domino' })).toBeVisible()

    await page.addInitScript(() => {
      localStorage.setItem('domino:lang', 'ko')
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'domino 열기' })).toBeVisible()
  })

  test('an English domino under Korean UI offers a one-time translation', async ({ page }) => {
    await seedMockLlm(page) // pins domino:lang=ko
    await openExample(page) // mock app screens are English

    const banner = page.locator('.runtime-banner')
    await expect(banner).toBeVisible({ timeout: 20_000 })
    await expect(banner).toContainText('설정된 언어와 다른 domino입니다')
    await expect(banner).toContainText('English')
    await expect(banner).toContainText('한국어')
    await expect(banner.getByRole('button', { name: '변경' })).toBeVisible()

    // Dismissing is final for this open — later screen settles must not nag.
    await banner.getByRole('button', { name: 'Dismiss' }).click()
    await expect(banner).toHaveCount(0)
    await page.waitForTimeout(1_500)
    await expect(banner).toHaveCount(0)
  })

  test('settings shows domino management with stored rows', async ({ page }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)
    await waitForQuietStats(page.request)
    // let the screen store persist at least one entry
    await page.waitForTimeout(500)

    await page.getByRole('button', { name: '설정' }).click()
    const section = page.locator('section[aria-label="domino 관리"]')
    await expect(section).toBeVisible()
    await expect(section.locator('.storage-summary')).toContainText('도미노')
    await expect(section.locator('.storage-row').first()).toBeVisible({ timeout: 10_000 })
    // Management must never touch the LLM key setting: the provider select stays.
    await expect(page.getByLabel('Provider')).toBeVisible()
  })

  test('maker ships the template gallery', async ({ page }) => {
    await seedMockLlm(page)
    await page.goto('/')
    await page.getByRole('button', { name: '새로 만들기' }).click()
    const tiles = page.locator('.maker-template')
    await expect(tiles).toHaveCount(6)
    await expect(tiles.first()).toBeVisible()
    // Picking a tile fills a full brief into the composer.
    await page.locator('.maker-template').first().click()
    const composer = page.getByLabel('앱 설명')
    await expect(composer).not.toHaveValue('')
  })
})

test.describe('per-domino LLM override', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('a domino can pin its own provider setting and unpin it', async ({ page }) => {
    await seedMockLlm(page)
    // Only "a domino is open" matters for the override section — any settled
    // runtime screen counts, so the assertion never depends on the mock's
    // exact login wording.
    await page.goto('/')
    await page.getByLabel('domino URL').fill('http://localhost:8790/app.domino')
    await page.getByRole('button', { name: '열기' }).click()
    await expect(page.locator('.runtime')).toBeVisible({ timeout: 25_000 })
    // The language offer only appears once a screen settles — the settle signal.
    await expect(page.locator('.runtime-banner').first()).toBeVisible({ timeout: 25_000 })
    // The language offer banner sits above the app bar — dismiss it so it can
    // never shadow the settings button.
    await page.locator('.runtime-banner').getByRole('button', { name: 'Dismiss' }).click()

    await page.getByRole('button', { name: '설정' }).click()
    await expect(page.locator('[role="dialog"][aria-label="설정"]')).toBeVisible({ timeout: 15_000 })
    const section = page.locator('section[aria-label="이 domino에만 LLM 설정 적용"]')
    await expect(section).toBeVisible({ timeout: 15_000 })

    // Off by default: no per-domino key exists yet.
    const dominoId = 'ExampleCRM|http://127.0.0.1:8790'
    expect(await page.evaluate((id) => localStorage.getItem(`domino:llm-config:${id}`), dominoId)).toBeNull()

    // Pin an override: flip the switch, set a model, save. (force: the
    // dialog's enter animation can outlive playwright's stability window.)
    await section.getByRole('switch').click({ force: true })
    const modelField = section.getByLabel('모델')
    await modelField.fill('mock-override-v9')
    await section.getByRole('button', { name: '이 domino 설정 저장' }).click()

    const stored = await page.evaluate((id) => localStorage.getItem(`domino:llm-config:${id}`), dominoId)
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!).model).toBe('mock-override-v9')

    // Reopen settings: the override loads back on.
    await page.reload()
    await openExample(page)
    await page.getByRole('button', { name: '설정' }).click()
    const section2 = page.locator('section[aria-label="이 domino에만 LLM 설정 적용"]')
    await expect(section2.getByLabel('모델')).toHaveValue('mock-override-v9')

    // Unpin clears the key entirely.
    await section2.getByRole('switch').click({ force: true })
    await page.waitForTimeout(400)
    expect(await page.evaluate((id) => localStorage.getItem(`domino:llm-config:${id}`), dominoId)).toBeNull()
  })
})
