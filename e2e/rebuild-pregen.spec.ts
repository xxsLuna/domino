import { expect, test } from '@playwright/test'
import { login, openExample, seedMockLlm, stats, submitEdit, waitForQuietStats } from './helpers'

test.describe('rebuild and pre-generation resume', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('rebuild warns, regenerates once, and interrupted warm-up resumes', async ({
    page,
    request
  }) => {
    test.setTimeout(120_000)
    await seedMockLlm(page)
    await openExample(page)
    await login(page)
    // Let the post-login warm-up settle so the rebuild delta is exactly +1.
    await waitForQuietStats(request)

    // Rebuild: warning copy + exactly one new turn + a fresh stack.
    await page.getByRole('button', { name: '처음부터 다시 만들기' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('토큰을 많이 소모할 수 있습니다')
    const beforeRebuild = (await stats(request)).llm
    await dialog.getByRole('button', { name: '다시 만들기' }).click()

    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible({
      timeout: 30_000
    })
    // Read before the 400ms warm-up window fires: exactly the rebuild turn.
    expect((await stats(request)).llm).toBe(beforeRebuild + 1)
    await expect(page.getByRole('button', { name: '이전 화면 (⌘[' })).toBeDisabled()

    // An edit turn interrupts whatever warm-up started…
    await submitEdit(page, request, 'tweak the dashboard wording')
    const afterEdit = await stats(request)
    expect(afterEdit.edits).toBeGreaterThan(0)

    // …and the interrupted warm-up resumes on its own afterwards.
    await expect
      .poll(async () => (await stats(request)).llm, { timeout: 30_000 })
      .toBeGreaterThan(afterEdit.llm)
    const warmed = await waitForQuietStats(request)

    // A warm page now switches instantly: no extra model turn.
    const beforeTap = warmed.llm
    await page.getByRole('button', { name: /^Inbox/ }).click()
    await expect(page.locator('.runtime-body h1')).toHaveText('Inbox')
    await expect
      .poll(async () => (await stats(request)).llm, { timeout: 3_000 })
      .toBe(beforeTap)
  })
})
