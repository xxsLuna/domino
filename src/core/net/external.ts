/**
 * The guard behind `[api] external = https`.
 *
 * A domino that declares `external` may point `call_api` and `[data]` sources
 * at ABSOLUTE URLs — public feeds and APIs the app's author chose — without
 * running a proxy backend. The declaration is the opt-in; this guard is the
 * fence that holds even for a model steered by hostile response text:
 *
 *  - https only in the public space; plain http survives only on this
 *    machine, matching what the transports can actually fetch (Electron's
 *    main process opens http solely on loopback, and so does the dev relay).
 *  - no private, loopback-as-host-via-ip-ambiguity, or link-local targets
 *    over https: the classic SSRF relay hop into cloud metadata (169.254) and
 *    LAN services is exactly what the allowlist exists to make impossible.
 *  - no `user:pass@` userinfo — a credential hidden in a URL is a leak.
 *
 * Hostname checks are best-effort (DNS can rebalance to a private address);
 * the web build layers the deploy-side relay rules on top — the dev relay
 * imports these same two predicates (see vite.web.config.ts).
 */

/** This machine's own hosts — the only place plain http is fetchable. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** LAN / metadata / unique-local ranges that must never be a fetch target. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (h.endsWith('.local') || h.endsWith('.localhost') || h === 'localhost') return true
  // `metadata.google.internal` and friends resolve to link-local inside clouds.
  if (h === 'internal' || h.endsWith('.internal')) return true
  if (h === '::1') return true
  // IPv4 written inside an IPv6 address: the stack routes these to the
  // embedded v4 address, so judge that one. Both spellings, because the URL
  // parser rewrites one into the other — `::ffff:127.0.0.1` arrives here as
  // its HEX form `::ffff:7f00:1`.
  const embedded = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
  if (embedded) return isPrivateHost(embedded[1])
  const mapped = /^::ffff:([0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)$/.exec(h)
  if (mapped) {
    const parts = mapped[1].split(':').map((p) => parseInt(p, 16))
    const word32 =
      parts.length === 2 ? ((parts[0] << 16) | parts[1]) >>> 0 : (parts[0] ?? 0) >>> 0
    return isPrivateHost(
      `${(word32 >>> 24) & 255}.${(word32 >>> 16) & 255}.${(word32 >>> 8) & 255}.${word32 & 255}`
    )
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      // CGNAT (100.64.0.0/10): carriers' internal space — never a public site.
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  // IPv6: unspecified, loopback written expanded, unique-local fc00::/7,
  // link-local fe80::/10 — compared on the first hextet, lowercase.
  const m6 = /^([0-9a-f]{1,4}):/.exec(h)
  if (m6) {
    const head = parseInt(m6[1], 16)
    if (head === 0) return true
    if ((head & 0xfe00) === 0xfc00) return true // fc00::–fdff::
    if ((head & 0xffc0) === 0xfe80) return true // fe80::–febf::
  }
  return false
}

/**
 * Validate one absolute external target. Returns null when the fetch may
 * proceed, or a model-readable reason it may not (the reason doubles as the
 * repair hint — same philosophy as the binding-gap notes).
 */
export function externalTargetError(raw: string): string | null {
  const trimmed = raw.trim()
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return `external target "${trimmed.slice(0, 120)}" is not a valid absolute URL`
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return `external target must be an http(s) URL, not "${u.protocol}"`
  }
  if (u.username || u.password) return 'external target must not carry user:pass credentials'
  if (u.protocol === 'https:') {
    if (isPrivateHost(u.hostname)) {
      return `external target "${u.hostname}" is a private/internal address — external calls go to public https hosts only`
    }
    return null
  }
  if (!isLoopbackHost(u.hostname)) {
    return `plain http is allowed only on localhost for external targets — use https:// for "${u.hostname}"`
  }
  return null
}
