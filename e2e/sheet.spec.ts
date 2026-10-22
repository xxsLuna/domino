import { expect, test } from '@playwright/test'
import { login, openExample, seedMockLlm, stats, waitForQuietStats } from './helpers'

test.describe('short forms open as a full-screen sheet', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('quick contact sheets over Leads, auto-submits save, cancel returns instantly', async ({
    page,
    request
  }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)

    await page.getByRole('button', { name: /^Leads/ }).click()
    await expect(page.locator('.runtime-body h1')).toHaveText('Leads')
    // Wait for the page to LAND (a live turn's preview shows the heading
    // before the snapshot is pushed — the sheet's "behind" reads the stack).
    await expect(page.locator('.render-gauge')).toHaveCount(0, { timeout: 20_000 })

    await page.getByRole('button', { name: 'Quick contact' }).click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    // Both the sheet header and the form title carry the same name.
    await expect(dialog.getByRole('heading', { name: 'Quick contact' }).first()).toBeVisible()

    // The cancel-only form gets its submit action injected by the runtime…
    const save = dialog.getByRole('button', { name: '저장' })
    await expect(save).toBeVisible()
    // …and the page behind the sheet stays put.
    await expect(page.locator('.runtime-body h1')).toHaveText('Leads')

    // Cancel closes through the fast path: no model turn at all. (First let
    // any background warm-up settle so a stray build can't move the counter.)
    await waitForQuietStats(request)
    const before = (await stats(request)).llm
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('.runtime-body h1')).toHaveText('Leads')
    await expect
      .poll(async () => (await stats(request)).llm, { timeout: 3_000 })
      .toBe(before)
  })
})
