import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { detectFormat, FORMATS, type Category } from '../converters/formats'
import { CONVERTERS_BY_ID, convertersFor, converterLabel, hasPresets } from '../converters/registry'
import { QUALITY_PRESETS, type OutputFile, type QualityPreset } from '../converters/types'
import { formatBytes, formatDuration, sizeDelta } from '../lib/format'
import type { Job, JobActions } from '../lib/jobs'
import { canShareFiles } from '../lib/platform'
import { saveAll, saveFile, shareFiles } from '../lib/save'
import { Icon, type IconName } from './Icon'
import { OptionsPanel } from './OptionsPanel'
import { TargetPicker } from './TargetPicker'

const CATEGORY_ICON: Record<Category, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  data: 'data',
  archive: 'archive',
}

// Formats most browsers can show in an <img>.
const PREVIEWABLE = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'avif'])
const THUMB_PX = 96

/**
 * Decodes a small thumbnail instead of showing the full image in a 48 px box:
 * a 48 MP photo would otherwise cost ~190 MB of memory per card.
 */
async function makeThumb(file: File): Promise<string> {
  if (typeof createImageBitmap === 'function' && detectFormat(file)?.id !== 'svg') {
    try {
      const bmp = await createImageBitmap(file, { resizeHeight: THUMB_PX, resizeQuality: 'medium' })
      if (bmp.height <= THUMB_PX * 2) {
        const canvas = document.createElement('canvas')
        canvas.width = bmp.width
        canvas.height = bmp.height
        canvas.getContext('2d')!.drawImage(bmp, 0, 0)
        bmp.close()
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.8))
        canvas.width = canvas.height = 0
        if (blob) return URL.createObjectURL(blob)
      } else {
        bmp.close()
      }
    } catch {
      // fall through
    }
  }
  // Browsers without bitmap resizing: only preview reasonably small files directly.
  if (file.size > 8 * 1024 * 1024) throw new Error('too large to preview')
  return URL.createObjectURL(file)
}

function Thumb({ file, category }: { file: File; category: Category }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!PREVIEWABLE.has(detectFormat(file)?.id ?? '')) return
    let made: string | undefined
    let cancelled = false
    makeThumb(file)
      .then((u) => {
        made = u
        if (cancelled) URL.revokeObjectURL(u)
        else setUrl(u)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [file])
  return (
    <div className={`thumb thumb--${category}`}>
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <Icon name={CATEGORY_ICON[category]} size={22} />}
    </div>
  )
}

const PRESET_LABELS: Record<QualityPreset, string> = { lossless: 'Lossless', balanced: 'Balanced', compact: 'Compact' }
const PRESET_HINTS: Record<QualityPreset, string> = {
  lossless: 'Best quality, larger files',
  balanced: 'Great quality, smaller files',
  compact: 'Smallest and fastest',
}

function QualitySwitch({ value, onChange, note }: { value: QualityPreset; onChange: (p: QualityPreset) => void; note?: string }) {
  return (
    <div className="quality">
      <div className="segmented" role="radiogroup" aria-label="Quality">
        {QUALITY_PRESETS.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={value === p} className={value === p ? 'is-active' : ''} onClick={() => onChange(p)}>
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      <p className="muted small quality__note">{note ?? PRESET_HINTS[value]}</p>
    </div>
  )
}

/** Percentage, time left and speed. Ticks once a second on its own so the card doesn't re-render. */
function ProgressStats({ job }: { job: Job }) {
  const [now, setNow] = useState(() => Date.now())
  const samples = useRef<{ t: number; p: number }[]>([])
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const s = samples.current
  if (job.progress > 0 && (!s.length || s[s.length - 1].p !== job.progress)) s.push({ t: Date.now(), p: job.progress })
  // Rate over the last ~10 s reacts to speed changes without jumping around.
  while (s.length > 2 && s[s.length - 1].t - s[0].t > 10_000) s.shift()

  const elapsed = job.startedAt ? (now - job.startedAt) / 1000 : 0
  let eta: number | undefined
  if (job.progress > 0.01 && elapsed > 1.5) {
    const first = s[0]
    const last = s[s.length - 1]
    const rate = s.length > 1 && last.t > first.t ? (last.p - first.p) / ((last.t - first.t) / 1000) : job.progress / elapsed
    if (rate > 0) eta = Math.max(0, (1 - job.progress) / rate - (now - last.t) / 1000)
  }
  const bytes = job.inputs.reduce((n, f) => n + f.size, 0)
  const throughput = elapsed > 1 && job.progress > 0 ? `${formatBytes((bytes * job.progress) / elapsed)}/s` : ''
  const speed = job.speed || throughput

  return (
    <div className="stats" aria-live="off">
      <strong>{Math.round(job.progress * 100)}%</strong>
      <span>{eta !== undefined ? `${formatDuration(eta)} left` : elapsed > 0 ? `${formatDuration(elapsed)} elapsed` : ''}</span>
      {speed && <span>{speed}</span>}
    </div>
  )
}

function OutputRow({ out, inputSize, single, onSaved }: { out: OutputFile; inputSize: number; single: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const delta = single ? sizeDelta(inputSize, out.blob.size) : ''
  const save = async () => {
    setBusy(true)
    try {
      if (await saveFile(out)) onSaved()
    } catch (e) {
      alert(`Couldn't save: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="output">
      <Icon name="check" size={16} className="output__check" />
      <span className="output__name" title={out.name}>
        {out.name}
      </span>
      <span className="output__size">
        {formatBytes(out.blob.size)}
        {delta && <em className={delta.startsWith('-') ? 'is-smaller' : ''}> {delta}</em>}
      </span>
      {!single && (
        <button type="button" className="btn btn--small" onClick={save} disabled={busy} aria-label={`Save ${out.name}`}>
          <Icon name="download" size={16} />
        </button>
      )}
    </li>
  )
}

export interface JobCardProps {
  job: Job
  actions: JobActions
  onEditPdf: (job: Job) => void
}

export const JobCard = memo(function JobCard({ job, actions, onEditPdf }: JobCardProps) {
  const [showOptions, setShowOptions] = useState(false)
  const combined = job.inputs.length > 1
  const fmt = job.formatId ? FORMATS[job.formatId] : undefined
  const converter = job.converterId ? CONVERTERS_BY_ID.get(job.converterId) : undefined
  const converters = useMemo(() => (combined ? (converter ? [converter] : []) : convertersFor(job.formatId)), [combined, converter, job.formatId])
  const inputSize = job.inputs.reduce((n, f) => n + f.size, 0)
  const busy = job.status === 'working' || job.status === 'queued'
  const hasOptions = Boolean(converter?.options?.length)
  const title = combined ? `${job.inputs.length} files` : job.inputs[0].name
  const editable = !combined && job.formatId === 'pdf' && !busy

  return (
    <article className={`card job job--${job.status}`}>
      <header className="job__head">
        <Thumb file={job.inputs[0]} category={fmt?.category ?? 'archive'} />
        <div className="job__meta">
          <h3 title={title}>{title}</h3>
          <p className="muted small">
            {combined ? job.inputs.map((f) => f.name).join(', ') : `${fmt?.label ?? 'Unknown type'} · ${formatBytes(inputSize)}`}
          </p>
        </div>
        {editable && (
          <button type="button" className="btn btn--small" onClick={() => onEditPdf(job)}>
            <Icon name="edit" size={16} /> Edit PDF
          </button>
        )}
        <button type="button" className="icon-btn" onClick={() => actions.remove(job.id)} aria-label={`Remove ${title}`}>
          <Icon name="x" size={18} />
        </button>
      </header>

      {!busy && job.status !== 'done' && converter !== undefined && (
        <div className="job__body">
          <div className="job__row">
            <span className="job__label">
              <Icon name="arrow" size={16} /> Convert to
            </span>
            {hasOptions && (
              <button type="button" className={`icon-btn icon-btn--label ${showOptions ? 'is-active' : ''}`} onClick={() => setShowOptions((s) => !s)} aria-expanded={showOptions}>
                <Icon name="sliders" size={16} /> Options
              </button>
            )}
          </div>
          {combined ? (
            <div className="chips">
              <span className="chip chip--active">{converterLabel(converter)}</span>
            </div>
          ) : (
            <TargetPicker converters={converters} value={job.converterId} onChange={(cid) => actions.setConverter(job.id, cid)} />
          )}
          {converter.description && <p className="muted small job__desc">{converter.description}</p>}
          {hasPresets(converter) && <QualitySwitch value={job.preset} onChange={(p) => actions.setPreset(job.id, p)} note={converter.presetNotes?.[job.preset]} />}
          {showOptions && converter.options && <OptionsPanel defs={converter.options} values={job.options} onChange={(k, v) => actions.setOption(job.id, k, v)} />}
        </div>
      )}

      {!busy && job.status !== 'done' && converter === undefined && converters.length === 0 && job.status !== 'error' && (
        <p className="muted small job__desc">No conversions available for this file type.</p>
      )}

      {busy && (
        <div className="job__progress">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
            <div className={`progress__bar ${job.progress === 0 ? 'is-indeterminate' : ''}`} style={{ width: job.progress ? `${Math.max(3, job.progress * 100)}%` : undefined }} />
          </div>
          <div className="job__row">
            <span className="muted small job__status" aria-live="polite">
              {job.statusText}
            </span>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => actions.cancel(job.id)}>
              Cancel
            </button>
          </div>
          {job.status === 'working' && <ProgressStats job={job} />}
        </div>
      )}

      {job.status === 'error' && (
        <div className="job__error" role="alert">
          <Icon name="alert" size={16} /> {job.error}
        </div>
      )}

      {job.status === 'done' && <Results job={job} inputSize={inputSize} actions={actions} />}

      {(job.status === 'ready' || job.status === 'error') && converter && (
        <footer className="job__foot">
          <button type="button" className="btn btn--primary" onClick={() => actions.start([job.id])}>
            {job.status === 'error' ? <Icon name="refresh" size={16} /> : null}
            {job.status === 'error' ? 'Try again' : `Convert to ${converterLabel(converter)}`}
          </button>
        </footer>
      )}
    </article>
  )
})

function Results({ job, inputSize, actions }: { job: Job; inputSize: number; actions: JobActions }) {
  const [busy, setBusy] = useState(false)
  const many = job.outputs.length > 1
  const shareable = canShareFiles()
  const run = async (fn: () => Promise<boolean | void>) => {
    setBusy(true)
    try {
      if ((await fn()) !== false) actions.saved(job.id)
    } catch (e) {
      alert(`Couldn't complete that: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }
  const stem = job.inputs[0].name.replace(/\.[^.]+$/, '')
  const took = job.startedAt && job.finishedAt ? (job.finishedAt - job.startedAt) / 1000 : undefined
  const total = job.outputs.reduce((n, o) => n + o.blob.size, 0)
  return (
    <div className="job__results">
      <p className="muted small job__done">
        {took !== undefined && took > 0.05 ? `Done in ${formatDuration(took)}` : 'Done'}
        {many && ` · ${job.outputs.length} files, ${formatBytes(total)}`}
        {job.note && ` · ${job.note}`}
      </p>
      <ul className="outputs">
        {job.outputs.slice(0, 50).map((out, i) => (
          <OutputRow key={i} out={out} inputSize={inputSize} single={!many} onSaved={() => {}} />
        ))}
        {job.outputs.length > 50 && <li className="muted small">…and {job.outputs.length - 50} more</li>}
      </ul>
      <div className="job__actions">
        <button type="button" className="btn btn--primary" onClick={() => run(() => (many ? saveAll(job.outputs, stem) : saveFile(job.outputs[0])))} disabled={busy}>
          <Icon name="download" size={16} /> {many ? `Save all (${job.outputs.length})` : 'Save'}
        </button>
        {shareable && (
          <button type="button" className="btn" onClick={() => run(() => shareFiles(job.outputs))} disabled={busy}>
            <Icon name="share" size={16} /> Share
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={() => actions.reset(job.id)}>
          Convert again
        </button>
      </div>
    </div>
  )
}
