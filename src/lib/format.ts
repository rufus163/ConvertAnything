export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** "−63%" / "+12%" size change, or '' when the change is negligible. */
export function sizeDelta(before: number, after: number): string {
  if (!before) return ''
  const pct = Math.round(((after - before) / before) * 100)
  if (Math.abs(pct) < 1) return ''
  return pct < 0 ? `${pct}%` : `+${pct}%`
}

/** "0.4s", "12s", "1m 05s", "1h 02m" */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 10) return `${seconds < 1 ? seconds.toFixed(1) : Math.round(seconds * 10) / 10}s`
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
