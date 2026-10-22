import { expect, test } from '@playwright/test'
import { openExample, seedMockLlm } from './helpers'

test.describe('phone menu handle', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('tap opens the menu, a drag moves the handle without opening it, the wall flip persists', async ({
    page
  }) => {
    await seedMockLlm(page)
    await openExample(page)

    const handle = page.locator('.runtime-handle')
    await expect(handle).toBeVisible()
    // The old square button is gone: the handle IS the trigger.
    await expect(page.locator('.runtime-pill')).toHaveCount(0)

    // Tap → menu opens directly (assert on its items: the popover itself is
    // a portalled layer whose labelled container varies).
    const firstItem = page.getByRole('menuitem', { name: '화면 수정' })
    await handle.click()
    await expect(firstItem).toBeVisible()
    // The menu anchors bottom-end, so the top-left corner is always outside it.
    await page.mouse.click(5, 5)
    await expect(firstItem).not.toBeVisible()

    // Vertical drag → the handle follows, suppressed press = no menu.
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 180, { steps: 8 })
    await page.mouse.up()
    const moved = (await handle.boundingBox())!
    expect(moved.y).toBeGreaterThan(box.y + 100)
    await expect(firstItem).not.toBeVisible()
    const saved = await page.evaluate(() => localStorage.getItem('domino:handle-pos'))
    expect(saved).toBeTruthy()

    // Menu item flips the wall (the mirrored side + context-aware label).
    await handle.click()
    await expect(firstItem).toBeVisible()
    await page.getByRole('menuitem', { name: '핸들을 왼쪽으로' }).click()
    await expect(handle).toHaveAttribute('data-side', 'left')

    // Reload: config survives (seeded once), position survives.
    await page.reload()
    await openExample(page)
    await expect(page.locator('.runtime-handle')).toHaveAttribute('data-side', 'left', {
      timeout: 20_000
    })
  })
})
