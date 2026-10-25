import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { I18nProvider } from './i18n'
import { installPlatformFetch } from './platform'
import './styles.css'

installPlatformFetch()

// Production web build only: cache the shell so the app (and every screen
// already opened) keeps working offline. Dev/preview keeps live reloading.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI).href, { scope: './' })
      .catch(() => {
        /* a failed SW registration must never block the app */
      })
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
