import { expect, test } from '@playwright/test'
import { login, openExample, seedMockLlm, stats, waitForQuietStats } from './helpers'

test.describe('short forms open as a sheet over their page', () => {
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
    // A phone-width sheet is a bottom card, not an edge-to-edge takeover:
    // the window edge and the page behind stay visible around it.
    const phoneBox = await dialog.boundingBox()
    expect(phoneBox).not.toBeNull()
    expect(phoneBox!.width).toBeLessThan(360)
    expect(phoneBox!.height).toBeLessThan(780)

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

test.describe('in a wide window the short form is a centered card', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the sheet floats over the page, window edges visible on every side', async ({ page }) => {
    await seedMockLlm(page)
    await openExample(page)
    await login(page)

    await page.getByRole('button', { name: /^Leads/ }).click()
    await expect(page.locator('.runtime-body h1')).toHaveText('Leads')
    await expect(page.locator('.render-gauge')).toHaveCount(0, { timeout: 20_000 })

    await page.getByRole('button', { name: 'Quick contact' }).click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 20_000 })

    // A card, not a takeover: narrower than the window, away from both edges,
    // and the page behind keeps drawing underneath the blurred backdrop.
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThan(700)
    expect(box!.height).toBeLessThan(800)
    expect(box!.x).toBeGreaterThan(200)
    expect(box!.x + box!.width).toBeLessThan(1080)
    await expect(page.locator('.runtime-body h1')).toHaveText('Leads')
  })
})
