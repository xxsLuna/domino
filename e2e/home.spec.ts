import { expect, test } from '@playwright/test'
import { seedMockLlm } from './helpers'

test.describe('home on a phone-width viewport', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('URL input shrinks to the card instead of painting past the edge', async ({ page }) => {
    await seedMockLlm(page)
    await page.goto('/')

    const input = page.getByLabel('domino URL')
    await expect(input).toBeVisible()

    const sizes = await input.evaluate((el) => {
      const field = el.closest('.textfield') as HTMLElement | null
      const welcome = el.closest('.welcome') as HTMLElement | null
      return {
        inputMin: getComputedStyle(el).minWidth,
        fieldMin: field ? getComputedStyle(field).minWidth : null,
        overflowX: welcome ? getComputedStyle(welcome).overflowX : null,
        docOverflow: document.documentElement.scrollWidth > window.innerWidth
      }
    })
    expect(sizes.inputMin).toBe('0px')
    expect(sizes.fieldMin).toBe('0px')
    expect(['clip', 'hidden']).toContain(sizes.overflowX)
    expect(sizes.docOverflow).toBe(false)
  })
})
