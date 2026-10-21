// Capacitor injects `window.Capacitor` in the native iOS app; reading it directly keeps
// @capacitor/core out of the startup bundle (it's loaded lazily when saving files natively).
const cap = typeof window !== 'undefined' ? (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor : undefined

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const isNativeApp = Boolean(cap?.isNativePlatform?.())
export const isIOS =
  cap?.getPlatform?.() === 'ios' ||
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
