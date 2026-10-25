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
    const section = page.locator('.storage-section')
    await expect(section).toBeVisible()
    await expect(section).toContainText('domino 관리')
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
