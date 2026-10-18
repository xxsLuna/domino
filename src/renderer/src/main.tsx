import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installPlatformFetch } from './platform'
import './styles.css'

installPlatformFetch()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
