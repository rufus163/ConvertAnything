import { useMemo, useState } from 'react'
import { CATEGORY_LABELS, FORMATS, type Category } from '../converters/formats'
import { convertersFor, converterLabel } from '../converters/registry'
import { Icon, type IconName } from './Icon'

export interface Shortcut {
  label: string
  from: string[]
  converter: string
}

export const POPULAR: Shortcut[] = [
  { label: 'HEIC → JPG', from: ['heic'], converter: 'image-jpg' },
  { label: 'Video → iPhone MP4', from: ['mov', 'mp4', 'webm', 'mkv', 'avi'], converter: 'video-ios' },
  { label: 'PNG → SVG', from: ['png'], converter: 'image-svg' },
  { label: 'Images → PDF', from: ['png', 'jpg', 'heic', 'webp'], converter: 'image-pdf' },
  { label: 'PDF → JPG', from: ['pdf'], converter: 'pdf-jpg' },
  { label: 'Merge PDFs', from: ['pdf'], converter: 'pdf-merge' },
  { label: 'MP4 → MP3', from: ['mp4', 'mov', 'webm', 'mkv'], converter: 'audio-mp3' },
  { label: 'Video → GIF', from: ['mp4', 'mov', 'webm'], converter: 'video-gif' },
  { label: 'Compress video', from: ['mp4', 'mov', 'mkv', 'webm'], converter: 'video-compress' },
  { label: 'WebP → PNG', from: ['webp'], converter: 'image-png' },
  { label: 'Word → PDF', from: ['docx'], converter: 'doc-docx-pdf' },
  { label: 'Excel → CSV', from: ['xlsx'], converter: 'data-csv' },
  { label: 'M4A → MP3', from: ['m4a'], converter: 'audio-mp3' },
  { label: 'Make a ringtone', from: ['mp3', 'm4a', 'wav', 'mp4', 'mov'], converter: 'audio-m4r' },
  { label: 'PNG → ICO', from: ['png', 'svg', 'jpg'], converter: 'image-ico' },
  { label: 'CSV → JSON', from: ['csv'], converter: 'data-json' },
]

const CATEGORY_ICON: Record<Category, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  data: 'data',
  archive: 'archive',
}

export function Hero({ onBrowse, onShortcut }: { onBrowse: () => void; onShortcut: (s: Shortcut) => void }) {
  const total = useMemo(() => Object.keys(FORMATS).reduce((n, id) => n + (id === 'any' ? 0 : convertersFor(id).length), 0), [])
  return (
    <section className="hero">
      <h1>
        Convert <span className="gradient-text">anything</span>.
      </h1>
      <p className="hero__sub">
        Images, video, audio, documents and data — right on your device. <br className="hide-mobile" />
        Nothing is uploaded, so it's private and works offline.
      </p>

      <button type="button" className="dropzone" onClick={onBrowse}>
        <span className="dropzone__icon">
          <Icon name="upload" size={28} />
        </span>
        <span className="dropzone__title">
          <span className="hide-mobile">Drop files here or </span>
          <span className="link">choose files</span>
        </span>
        <span className="muted small">
          {Object.keys(FORMATS).length - 1} formats · {total}+ conversions · No size limits, no sign-up
        </span>
      </button>

      <div className="popular">
        <h2 className="section-title">Popular</h2>
        <div className="popular__grid">
          {POPULAR.map((s) => (
            <button key={s.label} type="button" className="shortcut" onClick={() => onShortcut(s)}>
              <Icon name={CATEGORY_ICON[FORMATS[s.from[0]].category]} size={16} />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="features">
        <li>
          <Icon name="lock" size={18} />
          <div>
            <strong>Private by design</strong>
            <span>Files never leave your device.</span>
          </div>
        </li>
        <li>
          <Icon name="bolt" size={18} />
          <div>
            <strong>Smart iPhone video</strong>
            <span>Repackages instead of re-encoding when it can.</span>
          </div>
        </li>
        <li>
          <Icon name="devices" size={18} />
          <div>
            <strong>Every device</strong>
            <span>iPhone, iPad, Windows, Mac and the web.</span>
          </div>
        </li>
      </ul>
    </section>
  )
}

export function FormatBrowser({ onPick }: { onPick: (fromFormat: string) => void }) {
  const [query, setQuery] = useState('')
  const categories = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: { cat: Category; formats: { id: string; label: string; targets: string[] }[] }[] = []
    for (const cat of Object.keys(CATEGORY_LABELS) as Category[]) {
      const formats = Object.values(FORMATS)
        .filter((f) => f.category === cat && f.id !== 'any')
        .map((f) => ({ id: f.id, label: f.label, targets: [...new Set(convertersFor(f.id).filter((c) => c.id !== 'zip').map(converterLabel))] }))
        .filter((f) => f.targets.length)
        .filter((f) => !q || f.label.toLowerCase().includes(q) || f.id.includes(q) || f.targets.some((t) => t.toLowerCase().includes(q)))
      if (formats.length) out.push({ cat, formats })
    }
    return out
  }, [query])

  return (
    <section className="browser" id="formats">
      <div className="browser__head">
        <h2 className="section-title">Everything it converts</h2>
        <label className="search">
          <Icon name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, e.g. “mov” or “pdf”" aria-label="Search formats" />
        </label>
      </div>
      <div className="browser__grid">
        {categories.map(({ cat, formats }) => (
          <div key={cat} className={`card category category--${cat}`}>
            <h3>
              <span className={`thumb thumb--${cat} thumb--small`}>
                <Icon name={CATEGORY_ICON[cat]} size={16} />
              </span>
              {CATEGORY_LABELS[cat]}
            </h3>
            <ul>
              {formats.map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => onPick(f.id)} title={`Convert ${f.label} files`}>
                    <strong>{f.label}</strong>
                    <span className="muted">→ {f.targets.slice(0, 6).join(', ')}{f.targets.length > 6 ? ` +${f.targets.length - 6}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!categories.length && <p className="muted">Nothing matches “{query}”. Try another format name.</p>}
      </div>
      <p className="muted small center">Any file can also be bundled into a ZIP.</p>
    </section>
  )
}
