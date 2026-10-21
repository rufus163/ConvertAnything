import { useEffect, useRef } from 'react'
import { QUALITY_PRESETS, type QualityPreset } from '../converters/types'
import { isIOS } from '../lib/platform'
import { DEFAULT_SETTINGS, MAX_IMAGE_MEGAPIXELS, useSettings, type Settings } from '../lib/settings'
import { Icon } from './Icon'

const PRESET_TEXT: Record<QualityPreset, { label: string; help: string }> = {
  lossless: { label: 'Lossless', help: 'Keeps originals untouched where possible; largest files' },
  balanced: { label: 'Balanced', help: 'Visually identical for most files, much smaller' },
  compact: { label: 'Compact', help: 'Smallest files and fastest conversions' },
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting__text">
        <span className="setting__label">{label}</span>
        {help && <span className="muted small">{help}</span>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  )
}

function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="select">
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value
          onChange((typeof value === 'number' ? Number(raw) : raw) as T)
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} className={`switch ${value ? 'switch--on' : ''}`} onClick={() => onChange(!value)}>
      <span />
    </button>
  )
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings, update, reset } = useSettings()
  const panel = useRef<HTMLDivElement>(null)
  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) => update({ [key]: value } as Partial<Settings>)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const cores = navigator.hardwareConcurrency || 4
  const concurrencyChoices = [1, 2, 3, 4, 6, 8].filter((n) => n <= Math.max(4, cores)).map((n) => ({ value: n, label: n === 1 ? '1 at a time' : `${n} at once` }))
  const imageChoices = [8, 16, 24, 36, 50, 64].filter((n) => n <= MAX_IMAGE_MEGAPIXELS).map((n) => ({ value: n, label: `${n} MP${n === 16 ? ' (safe everywhere)' : ''}` }))

  return (
    <div className="modal" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__panel" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={panel}>
        <header className="modal__head">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <Icon name="x" size={20} />
          </button>
        </header>

        <div className="modal__body">
          <h3 className="section-title">Quality</h3>
          <div className="segmented segmented--block" role="radiogroup" aria-label="Default quality">
            {QUALITY_PRESETS.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={settings.quality === p} className={settings.quality === p ? 'is-active' : ''} onClick={() => update({ quality: p })}>
                {PRESET_TEXT[p].label}
              </button>
            ))}
          </div>
          <p className="muted small setting__note">Default for new files: {PRESET_TEXT[settings.quality].help}. You can still change it per file.</p>

          <h3 className="section-title">Performance</h3>
          <Row label="Simultaneous conversions" help={`This device has ${cores} CPU threads`}>
            <Select label="Simultaneous conversions" value={settings.concurrency} options={concurrencyChoices} onChange={set('concurrency')} />
          </Row>
          <Row label="Simultaneous video & audio" help="Each uses its own engine and a lot of memory">
            <Select
              label="Simultaneous video and audio conversions"
              value={settings.mediaConcurrency}
              options={[1, 2, 3].map((n) => ({ value: n, label: n === 1 ? '1 at a time' : `${n} at once` }))}
              onChange={set('mediaConcurrency')}
            />
          </Row>
          <Row label="Preload video engine" help="Downloads the ~32 MB engine at startup so the first video starts sooner">
            <Toggle label="Preload video engine" value={settings.preloadMedia} onChange={set('preloadMedia')} />
          </Row>

          <h3 className="section-title">Limits</h3>
          <Row label="Maximum file size" help="Larger files are rejected instead of risking a crash">
            <Select
              label="Maximum file size"
              value={settings.maxFileSizeMB}
              options={[0, 100, 250, 500, 1024, 2048, 4096].map((n) => ({ value: n, label: n === 0 ? 'No limit' : n >= 1024 ? `${n / 1024} GB` : `${n} MB` }))}
              onChange={set('maxFileSizeMB')}
            />
          </Row>
          <Row label="Maximum image size" help={isIOS ? 'iPhone and iPad allow up to 16 MP' : 'Bigger photos are scaled down to fit'}>
            <Select label="Maximum image size" value={settings.maxImageMegapixels} options={imageChoices} onChange={set('maxImageMegapixels')} />
          </Row>

          <h3 className="section-title">Memory</h3>
          <Row label="Remove items after saving" help="Frees memory as soon as results are saved">
            <Toggle label="Remove items after saving" value={settings.autoRemoveSaved} onChange={set('autoRemoveSaved')} />
          </Row>

          <h3 className="section-title">Appearance</h3>
          <Row label="Theme">
            <Select
              label="Theme"
              value={settings.theme}
              options={[
                { value: 'system', label: 'Match system' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onChange={set('theme')}
            />
          </Row>
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost btn--small" onClick={reset} disabled={JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS)}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn--primary btn--small" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
