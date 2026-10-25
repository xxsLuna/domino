import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const MOCK_STATS = 'http://127.0.0.1:8790/stats'
export const APP_DOMINO = 'http://localhost:8790/app.domino'

export interface Stats {
  llm: number
  login: number
  leads: number
  edits: number
}

export async function stats(request: APIRequestContext): Promise<Stats> {
  const res = await request.get(MOCK_STATS)
  return (await res.json()) as Stats
}

/**
 * Background page warm-up keeps hitting the mock after a turn settles; wait
 * until the LLM counter stops moving so "no extra turn" assertions are stable.
 */
export async function waitForQuietStats(
  request: APIRequestContext,
  idleMs = 1_500,
  maxWaitMs = 30_000
): Promise<Stats> {
  const deadline = Date.now() + maxWaitMs
  let previous = -1
  let sinceChange = Date.now()
  for (;;) {
    const current = await stats(request)
    if (current.llm !== previous) {
      previous = current.llm
      sinceChange = Date.now()
    } else if (Date.now() - sinceChange >= idleMs) {
      return current
    }
    if (Date.now() > deadline) return current
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * Every page starts from a clean origin with the chat endpoint pinned to the
 * mock: without this the saved BYOK provider (or its absence) makes turns hit
 * a real API and the run non-deterministic.
 */
export async function seedMockLlm(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // First navigation of a fresh context: clean slate + pinned endpoint.
    // Later reloads keep existing state (position prefs, session) intact.
    if (!localStorage.getItem('domino:llm-config')) {
      localStorage.clear()
      localStorage.setItem(
        'domino:llm-config',
        JSON.stringify({
          provider: 'chat_completions',
          baseUrl: 'http://127.0.0.1:8790/v1',
          model: 'mock',
          apiKey: 'e2e-key'
        })
      )
      // The suite's labels are Korean; pin the UI language so every spec
      // stays deterministic regardless of the runner's locale.
      localStorage.setItem('domino:lang', 'ko')
    }
  })
}

/** Home → open the mock app by URL (no dependency on recents). */
export async function openExample(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel('domino URL').fill(APP_DOMINO)
  await page.getByRole('button', { name: '열기' }).click()
  await expect(page.getByRole('heading', { name: /Sign in to ExampleCRM/ })).toBeVisible({
    timeout: 20_000
  })
}

/** Submit any credentials — the mock accepts them and lands on the dashboard.
 * Waits for the FINALIZED screen: the heading alone appears with the streaming
 * preview (breadcrumb text follows the preview too), so also require the
 * render gauge to be gone — it only fades after the turn lands. */
export async function login(page: Page): Promise<void> {
  await page.getByLabel('Email').fill('user@mail.com')
  await page.getByLabel('Password').fill('wrongpw1')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible({
    timeout: 20_000
  })
  await expect(page.locator('.render-gauge')).toHaveCount(0, { timeout: 20_000 })
}

/** Desktop edit composer: type the request and press Enter; resolve when the
 * edit has LANDED — the mock counter only proves generation, and the tagged
 * text appears in the streaming preview too, so wait for the gauge to finish. */
export async function submitEdit(page: Page, request: APIRequestContext, text: string): Promise<void> {
  const before = (await stats(request)).edits
  await page.getByLabel('현재 화면 수정 요청').fill(text)
  await page.getByLabel('현재 화면 수정 요청').press('Enter')
  await expect
    .poll(async () => (await stats(request)).edits, { timeout: 20_000 })
    .toBeGreaterThan(before)
  await expect(page.locator('.render-gauge')).toHaveCount(0, { timeout: 20_000 })
}

/** Vertical center of an element relative to the runtime body — for the
 *  "centered screens stay centered" assertions. */
export async function pageCentering(page: Page): Promise<{ body: number; grid: number }> {
  return page.evaluate(() => {
    const body = document.querySelector('.runtime-body')!
    const grid = document.querySelector('.card-grid')!
    const b = body.getBoundingClientRect()
    const g = grid.getBoundingClientRect()
    return {
      body: Math.round(b.top + b.height / 2),
      grid: Math.round(g.top + g.height / 2)
    }
  })
}
