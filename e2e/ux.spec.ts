import { expect, test } from '@playwright/test'
import { login, openExample, seedMockLlm, stats, submitEdit, waitForQuietStats } from './helpers'

test.describe('turn UX affordances', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('re-render refreshes the current page with exactly one turn', async ({ page, request }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)
    await waitForQuietStats(request)

    const before = (await stats(request)).llm
    await page.getByRole('button', { name: '화면 다시 그리기' }).click()
    await expect
      .poll(async () => (await stats(request)).llm, { timeout: 20_000 })
      .toBe(before + 1)
    await expect(page.locator('.render-gauge')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
    // The stack survives a refresh: back is available again.
    await expect(page.getByRole('button', { name: '이전 화면 (⌘[' })).toBeEnabled()
  })

  test('a landed edit offers one-tap undo that rewinds the page', async ({ page, request }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)

    const desc = page.getByText(/Pipeline overview/)
    await submitEdit(page, request, 'tweak the dashboard wording')
    await expect(desc).toContainText('· edit')

    const toast = page.locator('.result-toast')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('수정이 반영되었습니다')

    await toast.getByRole('button', { name: '되돌리기' }).click()
    await expect(toast).not.toBeVisible()
    await expect(desc).not.toContainText('· edit')
  })

  test('the command palette jumps to pages and opens screens', async ({ page }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)

    await page.keyboard.press('Control+k')
    const input = page.getByLabel('명령 검색')
    await expect(input).toBeVisible()
    await input.fill('설정')
    await input.press('Enter')
    // Settings opens as a modal over the runtime.
    await expect(page.getByRole('dialog', { name: '설정' })).toBeVisible()
  })

  test('export downloads the open .domino source', async ({ page }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'domino 내보내기' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.domino$/)
  })

  test('a failed turn shows a banner with a working retry', async ({ page }) => {
    // Point the chat endpoint at a dead port: boot fails before anything renders.
    await page.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem(
        'domino:llm-config',
        JSON.stringify({
          provider: 'chat_completions',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'mock',
          apiKey: 'e2e-key'
        })
      )
    })
    await page.goto('/')
    await page.getByLabel('domino URL').fill('http://localhost:8787/app.domino')
    await page.getByRole('button', { name: '열기' }).click()

    const alert = page.locator('[role="alert"]')
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(alert).toContainText('화면을 만들지 못했습니다')
    const retry = alert.getByRole('button', { name: '다시 시도' })
    await expect(retry).toBeVisible()

    // Retry re-runs the same turn — it fails again (endpoint still dead).
    await retry.click()
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await alert.getByRole('button', { name: 'Dismiss' }).click()
    await expect(alert).not.toBeVisible()
  })
})
