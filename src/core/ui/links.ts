/**
 * Which presses leave the app: the decision behind the mobile shell's
 * in-app browser (see renderer platform.ts). Kept DOM-free so the rule is
 * testable and shared by every shell.
 */

/**
 * Image addresses: web URLs plus inline/local pictures. A spec-written
 * `file://…` src is a local-file oracle, and `javascript:` in an img src is
 * inert but noise — neither earns a slot. Used by the component renderer
 * and the app chrome (the [meta] logo).
 */
export function webImage(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const u = (typeof v === 'string' ? v : String(v)).trim()
  return /^(https?:\/\/|data:image\/|blob:)/i.test(u) ? u : undefined
}

/**
 * The http(s) address a tapped anchor should open outside the app — or null
 * when the press stays inside. mailto:/tel:/… anchors are left to the system,
 * and a same-origin link that was never meant to pop a tab navigates in the
 * app's own WebView.
 */
export function externalHrefFor(
  anchor: { href: string; target?: string } | null,
  origin: string
): string | null {
  if (!anchor || !anchor.href) return null
  let u: URL
  try {
    u = new URL(anchor.href)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.origin === origin && anchor.target !== '_blank') return null
  return u.href
}
