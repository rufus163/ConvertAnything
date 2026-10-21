import { useCallback, useEffect, useState } from 'react'
import { useSettings } from './settings'

type Theme = 'light' | 'dark'

const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')

/** Follows the system theme unless a theme is chosen in settings. */
export function useTheme() {
  const { settings, update } = useSettings()
  const [system, setSystem] = useState<Theme>(systemTheme)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystem(systemTheme())
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const theme: Theme = settings.theme === 'system' ? system : settings.theme

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0b0f' : '#f5f5f7')
  }, [theme])

  const toggle = useCallback(() => update({ theme: theme === 'dark' ? 'light' : 'dark' }), [theme, update])

  return { theme, toggle }
}
