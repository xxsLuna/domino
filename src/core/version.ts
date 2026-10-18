/** Compare dotted versions ("0.10.0" > "0.9.3"); a leading "v" and pre-release tags are ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/** Where releases (and the self-update assets) are published. */
export const RELEASES_REPO = 'xxsLuna/domino'
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`
