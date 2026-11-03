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

    // An edit turn no longer cancels the warm-up: both run side by side, so
    // the rebuilt app's pages are built while the edit streams.
    const beforeEdit = (await stats(request)).llm
    await submitEdit(page, request, 'tweak the dashboard wording')
    const afterEdit = await stats(request)
    expect(afterEdit.edits).toBeGreaterThan(0)
    expect(afterEdit.llm).toBeGreaterThan(beforeEdit + 1)
    await waitForQuietStats(request, 4_000, 60_000)

    // Every warm page now switches instantly: no model turn for the page. A
    // settled screen may still start a couple of predicted button builds
    // (ACTION click …) in the background — those are not turns for the tap.
    const asked: string[] = []
    page.on('request', (r) => {
      if (!r.url().includes('chat%2Fcompletions')) return
      const body = JSON.parse(r.postData() ?? '{}') as { messages?: Array<{ role: string; content?: string }> }
      const users = (body.messages ?? []).filter((m) => m.role === 'user')
      asked.push(String(users.at(-1)?.content ?? ''))
    })
    for (const [name, heading] of [
      [/^Inbox/, 'Inbox'],
      [/^Deals/, 'Deals'],
      [/^Reports/, 'Reports']
    ] as const) {
      await page.getByRole('button', { name }).click()
      await expect(page.locator('.runtime-body h1')).toHaveText(heading)
    }
    await waitForQuietStats(request)
    expect(asked.filter((text) => !text.startsWith('ACTION click from Button/'))).toEqual([])
  })
})
