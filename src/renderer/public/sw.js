/**
 * Domino UI service worker (production web build only).
 *
 * Same-origin GET only: network-first so an online user always gets the
 * fresh shell and hashed assets, cache-first fallback so the app — and every
 * screen already rendered — keeps opening with no connection at all.
 * Cross-origin traffic (LLM providers, [api] backends) is never intercepted.
 *
 * /relay is exempt entirely: its bodies are OTHER sites' data (often behind
 * the user's API key), and an offline user must not read someone else's
 * yesterday from a shared cache. Error pages are not cached either — a 404
 * that poisons the shell comes back as a 404 forever.
 */
const CACHE = 'domino-shell-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['./']))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // APIs and LLM calls stay ours
  if (url.pathname === '/relay' || url.pathname.startsWith('/relay/')) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response.ok || response.type !== 'basic') return response
        const copy = response.clone()
        caches
          .open(CACHE)
          .then((cache) => cache.put(request, copy))
          .catch(() => {})
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request)
        if (cached) return cached
        // Navigations offline: fall back to the cached shell.
        if (request.mode === 'navigate') {
          const shell = await caches.match('./')
          if (shell) return shell
        }
        return Response.error()
      })
  )
})
