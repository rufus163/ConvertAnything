import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { isNativeApp, isTauri } from './lib/platform'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Offline support for the web version. Native shells already bundle every file.
if (!isNativeApp && !isTauri && import.meta.env.PROD && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {})
}
