import { expect, test } from '@playwright/test'
import { login, openExample, seedMockLlm, submitEdit } from './helpers'

test.describe('screen history drawer', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('restoring an earlier moment rewinds the page content in time', async ({ page, request }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)

    const desc = page.getByText(/Pipeline overview/)
    await expect(desc).toBeVisible()
    expect(await desc.textContent()).not.toContain('· edit')

    await submitEdit(page, request, 'tweak the dashboard wording')
    await expect(desc).toContainText('· edit')

    // Newest first: [수정 Dashboard, 시작 Dashboard, 시작 Sign in …]
    await page.getByRole('button', { name: '화면 히스토리' }).click()
    const panel = page.locator('.history-panel.is-open')
    await expect(panel).toBeVisible()

    // The login flow's call_api is logged with timing in the drawer's API section.
    await expect(panel.locator('.history-api')).toBeVisible()
    await expect(panel.locator('.api-item').first()).toContainText('/leads')
    await expect(panel.locator('.api-item').first().locator('.api-badge')).toHaveAttribute(
      'data-ok',
      'true'
    )

    const rows = panel.locator('.history-item')
    expect(await rows.count()).toBeGreaterThanOrEqual(3)
    await expect(rows.first()).toHaveAttribute('aria-current', 'true')
    await expect(rows.first().locator('.history-badge')).toHaveAttribute('data-kind', 'edit')
    await expect(rows.nth(1).locator('.history-badge')).toHaveAttribute('data-kind', 'start')

    // The pre-edit moment: dashboard without the edit tag.
    await rows.nth(1).click()
    await expect(panel).toBeHidden() // closes after restoring
    await expect(desc).not.toContainText('· edit')

    // …and the current marker moved with the jump (forward branch preserved).
    await page.getByRole('button', { name: '화면 히스토리' }).click()
    await expect(panel.locator('.history-item').nth(1)).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('button', { name: '다음 화면 (⌘])' })).toBeEnabled()

    // The edit row carries the request itself…
    await expect(panel.locator('.history-item').first().locator('.history-note')).toContainText(
      'tweak the dashboard wording'
    )
    await panel.locator('.history-item').first().click() // close back onto the edited moment

    // …and the stack survives a restart: reload lands on home (nothing
    // auto-reopens), so reopen the app — the runtime restores the view AND
    // the persisted stack.
    await page.reload()
    await page.getByLabel('domino URL').fill('http://localhost:8787/app.domino')
    await page.getByRole('button', { name: '열기' }).click()
    await expect(page.getByRole('button', { name: '화면 히스토리' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: '화면 히스토리' }).click()
    const restoredRows = page.locator('.history-panel.is-open .history-item')
    await expect(restoredRows.first()).toBeVisible({ timeout: 20_000 })
    expect(await restoredRows.count()).toBeGreaterThanOrEqual(3)
    // The moment we jumped to before the reload is still the current one.
    await expect(restoredRows.first()).toHaveAttribute('aria-current', 'true')
  })
})
