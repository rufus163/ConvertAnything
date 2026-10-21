import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { QualityPreset } from '../converters/types'
import { isIOS, isMobile } from './platform'

export interface Settings {
  /** Default quality for new conversions. */
  quality: QualityPreset
  /** How many conversions run at the same time. */
  concurrency: number
  /** How many of those may be video/audio (each needs its own ~32 MB engine plus working memory). */
  mediaConcurrency: number
  /** Files larger than this are not accepted. 0 = no limit. */
  maxFileSizeMB: number
  /** Larger images are scaled down to this many megapixels. */
  maxImageMegapixels: number
  /** Remove a finished item from the list once its results are saved, to free memory. */
  autoRemoveSaved: boolean
  /** Download the video engine at startup instead of on first use. */
  preloadMedia: boolean
  theme: 'system' | 'light' | 'dark'
}

const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4

export const DEFAULT_SETTINGS: Settings = {
  quality: 'balanced',
  concurrency: isMobile ? 1 : Math.min(4, Math.max(1, Math.floor(cores / 2))),
  mediaConcurrency: 1,
  maxFileSizeMB: 0,
  maxImageMegapixels: 16,
  autoRemoveSaved: false,
  preloadMedia: false,
  theme: 'system',
}

/** iOS Safari refuses canvases above ~16.7 MP, so the image limit can't go higher there. */
export const MAX_IMAGE_MEGAPIXELS = isIOS ? 16 : 64

const KEY = 'convertanything:settings'

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>
    // Older versions stored the theme on its own.
    const legacyTheme = localStorage.getItem('convertanything:theme')
    const merged: Settings = { ...DEFAULT_SETTINGS, ...(legacyTheme === 'light' || legacyTheme === 'dark' ? { theme: legacyTheme } : {}), ...raw }
    merged.maxImageMegapixels = Math.min(merged.maxImageMegapixels, MAX_IMAGE_MEGAPIXELS)
    return merged
  } catch {
    return DEFAULT_SETTINGS
  }
}

// Engines read settings outside React, so the current value is mirrored here.
let current: Settings = typeof window === 'undefined' ? DEFAULT_SETTINGS : load()
export const getSettings = () => current

interface Ctx {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  reset: () => void
}

const SettingsContext = createContext<Ctx>({ settings: current, update: () => {}, reset: () => {} })

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(current)

  useEffect(() => {
    current = settings
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
      localStorage.removeItem('convertanything:theme')
    } catch {
      // Private browsing: settings just won't persist.
    }
  }, [settings])

  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), [])
  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), [])
  const value = useMemo(() => ({ settings, update, reset }), [settings, update, reset])
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export const useSettings = () => useContext(SettingsContext)
