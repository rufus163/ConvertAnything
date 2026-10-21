import { Capacitor } from '@capacitor/core'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const isNativeApp = Capacitor.isNativePlatform()
export const isIOS =
  Capacitor.getPlatform() === 'ios' ||
  (typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)))
export const isMobile = isIOS || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent))

export function canShareFiles(): boolean {
  if (isNativeApp) return true
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'x.txt', { type: 'text/plain' })] })
  } catch {
    return false
  }
}
