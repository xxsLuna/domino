import { useEffect, useRef } from 'react'

/**
 * Hardware/browser "back" for an app that doesn't route with URLs.
 *
 * Screens that can go back (an open dialog, the runtime's history, the maker)
 * register a handler; the newest one wins. While any handler exists, one
 * guard entry sits in window history, so the Android back key (via
 * @capacitor/app, which goes back in web history when it can) and the
 * browser/mouse back button land in `popstate` instead of leaving the app.
 * With no handler left — the home screen — back exits as Android expects.
 */

type Handler = () => void

const stack: Array<{ id: number; handler: { current: Handler } }> = []
let nextId = 1
let guarded = false

function syncGuard(): void {
  if (stack.length && !guarded) {
    history.pushState({ dominoBack: true }, '')
    guarded = true
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (!guarded) return
    guarded = false
    stack[stack.length - 1]?.handler.current()
    // Handlers update React state; re-arm once the new screen has registered.
    setTimeout(syncGuard, 0)
  })
}

/** While `active`, back runs `handler` (latest registration first). */
export function useBackHandler(active: boolean, handler: Handler): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!active) return
    const id = nextId++
    stack.push({ id, handler: ref })
    syncGuard()
    return () => {
      const i = stack.findIndex((e) => e.id === id)
      if (i >= 0) stack.splice(i, 1)
      // Nothing left to go back to: drop the guard so the next back exits.
      // Deferred, so a handler that is immediately re-registered keeps it.
      setTimeout(() => {
        if (!stack.length && guarded) {
          guarded = false
          history.back()
        }
      }, 0)
    }
  }, [active])
}
