import { expect, test } from '@playwright/test'
import { seedMockLlm } from './helpers'

test.describe('share link', () => {
  test.use({
    viewport: { width: 1280, height: 720 },
    permissions: ['clipboard-read', 'clipboard-write']
  })

  test('copy link round-trips through the URL box', async ({ page }) => {
    await seedMockLlm(page)
    await page.goto('/')
    await page.getByLabel('domino URL').fill('http://localhost:8790/app.domino')
    await page.getByRole('button', { name: '열기' }).click()
    await expect(page.locator('.runtime')).toBeVisible({ timeout: 25_000 })

    const offer = page.locator('.runtime-banner')
    if (await offer.count()) await offer.getByRole('button', { name: 'Dismiss' }).click()

    await page.getByRole('button', { name: '링크 복사' }).click()
    await expect(page.locator('.result-toast')).toContainText('공유 링크를 복사했습니다', {
      timeout: 10_000
    })

    const link = await page.evaluate(() => navigator.clipboard.readText())
    expect(link.startsWith('domino://')).toBe(true)
    expect(link).toContain('?c=')

    // Round trip: close, paste the copied link, open — the definition runs again.
    await page.getByRole('button', { name: 'domino 닫기' }).click()
    await page.getByLabel('domino URL').fill(link)
    await page.getByRole('button', { name: '열기' }).click()
    await expect(page.locator('.runtime')).toBeVisible({ timeout: 25_000 })
    await expect(page.getByText('ExampleCRM').first()).toBeVisible()
  })
})
