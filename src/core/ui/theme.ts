import type { UiSection } from '../domino/types'

/**
 * Maps a domino `[ui]` section onto HeroUI's theme tokens.
 *
 * The variables go inline on the same element that carries `data-theme`:
 * HeroUI re-declares its calculated colors (`--accent-hover`, `--accent-soft`,
 * `--focus`…) per theme block with `var(--accent)`, so they only pick up an
 * override declared on that same element. `--field-radius` is derived from
 * `--radius` once on `:root`, so it is re-derived here as well.
 */

const SNOW = 'var(--snow)'
const ECLIPSE = 'var(--eclipse)'

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const COLOR_FN =
  /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|var)\(\s*[a-z0-9.+\-%,#/() ]*\)$/i
const COLOR_KEYWORD = /^[a-z]+$/i

/**
 * A CSS color and nothing else: hex, a whitelisted color function, or a
 * keyword. The character allowlist excludes `;`/`{`/`}`/quotes/backslash so a
 * value can never end the declaration and inject further CSS (or smuggle a
 * `url()` fetch, which is also rejected outright).
 */
export function isSafeCssColor(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 100) return false
  if (/url\s*\(|expression|javascript:/i.test(v)) return false
  return HEX_COLOR.test(v) || COLOR_FN.test(v) || COLOR_KEYWORD.test(v)
}

/** Readable text color for a hex background; other CSS colors get white text. */
export function foregroundFor(color: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1]
  if (!hex) return SNOW
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const onWhite = 1.05 / (luminance + 0.05)
  // White text reads as the "filled button" look; keep it while it stays legible
  // for bold control labels (3:1), otherwise use whichever contrasts more.
  return onWhite >= 3 || onWhite >= (luminance + 0.05) / 0.06 ? SNOW : ECLIPSE
}

export function themeVars(ui: UiSection): Record<string, string> {
  const vars: Record<string, string> = {}
  const color = (token: string, value: string | undefined): void => {
    // Re-validated here too: setProperty feeds the value straight into CSSOM,
    // so nothing unvetted reaches the document even if a caller bypasses parse.
    if (!value || !isSafeCssColor(value)) return
    vars[`--${token}`] = value
    vars[`--${token}-foreground`] = foregroundFor(value)
  }
  color('accent', ui.primary)
  color('success', ui.success)
  color('warning', ui.warning)
  color('danger', ui.danger)

  const radius = ui.radius ?? (ui.style === 'sharp' ? 0 : undefined)
  if (radius !== undefined && Number.isFinite(radius)) {
    vars['--radius'] = `${radius}px`
    vars['--field-radius'] = `${Math.round(radius * 1.5)}px`
  }
  return vars
}
