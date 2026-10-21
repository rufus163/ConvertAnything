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
