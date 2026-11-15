import { expect, test } from '@playwright/test'
import { seedMockLlm, submitEdit } from './helpers'

const ROW_APP = 'http://localhost:8790/rowapp.domino'

/**
 * "Make it prettier" never means "delete my data". A restyle draft that stops
 * reading the [data] source the screen was drawing is refused: the user keeps
 * the records they were looking at and the banner names what the draft dropped.
 */
test.describe('an edit never deletes the records on screen', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('a draft that dropped the bound list is refused and the screen is kept', async ({
    page,
    request
  }) => {
    test.setTimeout(120_000)
    await seedMockLlm(page)
    await page.goto('/')
    await page.getByLabel('domino URL').fill(ROW_APP)
    await page.getByRole('button', { name: '열기' }).click()

    const rows = page.locator('.runtime-body ul li button')
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    const firstRow = await rows.first().textContent()
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(1)

    // The mock answers this exact request with the page stripped to one header.
    await submitEdit(page, request, 'REMOVE THE LIST and make it prettier')

    // The records are still there — same rows, same count.
    await expect(rows).toHaveCount(rowCount, { timeout: 10_000 })
    await expect(rows.first()).toHaveText(firstRow ?? '')
    // The refused draft never reached the screen.
    await expect(page.getByText('Much prettier')).toHaveCount(0)
    // The user is told the edit was not applied, and the banner offers a retry.
    // (The app also carries its own language-mismatch banner, so scope by text.)
    await expect(
      page.locator('.runtime-banner', { hasText: '적용하지 않았습니다' })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible()
  })
})
