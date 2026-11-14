import { expect, test } from '@playwright/test'
import { seedMockLlm, stats, waitForQuietStats } from './helpers'

const ROW_APP = 'http://localhost:8790/rowapp.domino'

/**
 * The `[pages]` rowAction contract: a plan line (`rowAction -> memo`) makes
 * the RUNTIME open the detail itself when a row is selected — the record id
 * lands in state.selected, the detail reads a `GET /memos/{selected}` [data]
 * source, and once the page is built the open is instant with no model turn.
 * A row tap on a not-yet-built target falls through to a turn for THAT exact
 * page id, never a generic "compute the next screen" guess.
 */
test.describe('rowAction pages open at runtime', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('a row tap opens the bound detail; built repeats cost zero turns', async ({
    page,
    request
  }) => {
    test.setTimeout(120_000)
    await seedMockLlm(page)
    await page.goto('/')
    await page.getByLabel('domino URL').fill(ROW_APP)
    await page.getByRole('button', { name: '열기' }).click()

    // Home: the List bound to the memos source, rows tappable because the
    // records carry ids. No auth on this app — it boots straight in.
    await expect(page.getByRole('heading', { name: 'Memos', exact: true })).toBeVisible({
      timeout: 20_000
    })
    const row = (n: number) => page.locator('.runtime-body ul li button').nth(n)
    await expect(row(0)).toBeVisible({ timeout: 15_000 })
    // Let the boot turn and the post-finalize warm-up (which pre-builds the
    // memo page) settle, so the deltas below measure the TAPS alone.
    await waitForQuietStats(request)

    // Tap record 901: the detail shows THIS memo's own bound fields.
    const before1 = (await stats(request)).llm
    await row(0).click()
    await expect(page.getByRole('heading', { name: 'Weekly sync notes' })).toBeVisible({
      timeout: 20_000
    })
    // The target was pre-generated, so this open must not need a model.
    expect((await stats(request)).llm).toBe(before1)

    // Back to the list and tap record 902: the memo page is built now, so the
    // open is instant AND shows 902 — never 901's frozen copy: the {selected}
    // source follows the selection, which is what makes repeats right.
    await page.getByRole('button', { name: 'Memos', exact: true }).first().click()
    await expect(row(1)).toBeVisible({ timeout: 10_000 })
    await waitForQuietStats(request)
    const before2 = (await stats(request)).llm
    await row(1).click()
    await expect(page.getByRole('heading', { name: 'Retro: shipping week' })).toBeVisible({
      timeout: 20_000
    })
    await expect(page.getByText('Detail pages read the selection.')).toBeVisible()
    await waitForQuietStats(request)
    expect((await stats(request)).llm).toBe(before2)
  })
})
