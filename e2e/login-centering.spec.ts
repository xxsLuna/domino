import { expect, test } from '@playwright/test'
import { openExample, pageCentering, seedMockLlm } from './helpers'

test.describe('login vertical centering', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('stays centered when a pinned Alert appears (desktop)', async ({ page }) => {
    await seedMockLlm(page)
    await openExample(page)

    const before = await pageCentering(page)
    expect(Math.abs(before.body - before.grid)).toBeLessThanOrEqual(2)

    // The mock renders its login-failed spec (Alert + form) for this request.
    // (This text is routed by an earlier mock branch, so there is no edit
    // counter to wait on — wait for the Alert itself.)
    await page.getByLabel('현재 화면 수정 요청').fill('Login attempt FAILED')
    await page.getByLabel('현재 화면 수정 요청').press('Enter')

    const alert = page.locator('[data-node="Alert"]')
    await expect(alert).toBeVisible({ timeout: 20_000 })
    const alertStyle = await alert.evaluate((el) => ({
      position: getComputedStyle(el).position,
      top: Math.round(el.getBoundingClientRect().top)
    }))
    expect(alertStyle.position).toBe('absolute')
    expect(alertStyle.top).toBeLessThan(140)

    const after = await pageCentering(page)
    expect(Math.abs(after.body - after.grid)).toBeLessThanOrEqual(2)
    expect(after.body).toBe(before.body)
  })

  test.describe('phone width', () => {
    test.use({ viewport: { width: 360, height: 780 } })

    test('login card sits in the vertical middle', async ({ page }) => {
      await seedMockLlm(page)
      await openExample(page)
      await expect(page.locator('.runtime-body')).toHaveAttribute('data-centered', 'true')
      const c = await pageCentering(page)
      expect(Math.abs(c.body - c.grid)).toBeLessThanOrEqual(2)
    })
  })
})
