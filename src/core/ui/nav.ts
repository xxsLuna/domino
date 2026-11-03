import { resolveDataBindings, resolveStateBindings, type NavItem } from '../spec'

/**
 * Live nav badges. An unread count or cart size in the nav is only useful when
 * it follows the data: a badge may be a binding — `{"$data": "<key>.<path>"}`
 * against the runtime-owned [data] snapshots, or `{"$state": "<key>"}`
 * against the screen's client-side state — resolved on every render the same
 * way CardGrid resolves node props, so `every Ns` polling updates it without a
 * model turn.
 */

/** A nav item as the model may write it: the badge can still be a binding. */
export type NavItemInput = Omit<NavItem, 'badge'> & { badge?: unknown }

/** True for the single-key binding object `{"$data": "..."}` / `{"$state": "..."}`. */
function bindingOf(v: unknown): { kind: '$data' | '$state'; path: string } | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 1) return null
  const kind = keys[0]
  const path = (v as Record<string, unknown>)[kind]
  if ((kind !== '$data' && kind !== '$state') || typeof path !== 'string' || !path) return null
  return { kind, path }
}

/**
 * The text a badge shows, or undefined to hide it: numbers and non-empty
 * strings show (a count of 0 hides, as app badges do), `true` shows a dot,
 * anything else — false, null, an unresolved binding, an object — hides.
 */
export function navBadgeText(badge: unknown): string | undefined {
  if (typeof badge === 'number')
    return Number.isFinite(badge) && badge !== 0 ? String(badge) : undefined
  if (typeof badge === 'string') return badge.trim() === '' ? undefined : badge
  if (badge === true) return '•'
  return undefined
}

/** A resolved badge value coerced into NavItem's type (undefined hides it). */
function coerceBadge(v: unknown): string | number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? '•' : undefined
  return undefined
}

/**
 * Nav items with their badge bindings resolved against the latest [data]
 * snapshots and the screen state. Literal badges pass through; a binding
 * whose value is missing (not fetched yet, unknown key) hides the badge
 * instead of the item. Returns the input array itself when nothing was bound,
 * so memoized consumers keep their identity.
 */
export function resolveNavItems(
  items: readonly NavItemInput[],
  data?: Record<string, unknown>,
  state?: Record<string, unknown>
): NavItem[] {
  let changed = false
  const out = items.map((item): NavItem => {
    const binding = bindingOf(item.badge)
    if (!binding) {
      if (
        item.badge === undefined ||
        typeof item.badge === 'string' ||
        typeof item.badge === 'number'
      ) {
        return item as NavItem
      }
      // A literal of another type (boolean, object) cannot render as a badge.
      changed = true
      return { ...item, badge: coerceBadge(item.badge) }
    }
    changed = true
    // Reuse the prop resolvers so paths behave exactly as they do in CardGrid
    // (longest source key match, numeric segments index arrays).
    const probe = { name: 'NavItem', props: { badge: item.badge } }
    const resolved =
      binding.kind === '$data'
        ? resolveDataBindings(probe, data ?? {})
        : resolveStateBindings(probe, state ?? {})
    return { ...item, badge: coerceBadge(resolved.props?.badge) }
  })
  return changed ? out : (items as NavItem[])
}

/**
 * [data] source keys the nav's badges bind (`{"$data": "inbox.unread"}` →
 * "inbox"), to union with referencedDataKeys so the runtime keeps polling the
 * sources a nav badge shows.
 */
export function navDataKeys(items: readonly NavItemInput[] | undefined): Set<string> {
  const keys = new Set<string>()
  for (const item of items ?? []) {
    const binding = bindingOf(item.badge)
    if (binding?.kind === '$data') keys.add(binding.path.split('.')[0])
  }
  return keys
}
