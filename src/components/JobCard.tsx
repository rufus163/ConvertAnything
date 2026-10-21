import { useEffect, useMemo, useState } from 'react'
import { detectFormat, FORMATS, type Category } from '../converters/formats'
import { CONVERTERS_BY_ID, convertersFor, converterLabel } from '../converters/registry'
import type { OptionValue, OutputFile } from '../converters/types'
import { formatBytes, sizeDelta } from '../lib/format'
import type { Job } from '../lib/jobs'
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

function Thumb({ file, category }: { file: File; category: Category }) {
  const fmt = detectFormat(file)?.id
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!PREVIEWABLE.has(fmt ?? '') || file.size > 40 * 1024 * 1024) return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file, fmt])
  return (
    <div className={`thumb thumb--${category}`}>
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <Icon name={CATEGORY_ICON[category]} size={22} />}
    </div>
  )
}

function OutputRow({ out, inputSize, single }: { out: OutputFile; inputSize: number; single: boolean }) {
  const [busy, setBusy] = useState(false)
  const delta = single ? sizeDelta(inputSize, out.blob.size) : ''
  const save = async () => {
    setBusy(true)
    try {
      await saveFile(out)
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
  onConverter: (id: string) => void
  onOption: (key: string, value: OptionValue) => void
  onStart: () => void
  onReset: () => void
  onCancel: () => void
  onRemove: () => void
}

export function JobCard({ job, onConverter, onOption, onStart, onReset, onCancel, onRemove }: JobCardProps) {
  const [showOptions, setShowOptions] = useState(false)
  const combined = job.inputs.length > 1
  const fmt = job.formatId ? FORMATS[job.formatId] : undefined
  const converter = job.converterId ? CONVERTERS_BY_ID.get(job.converterId) : undefined
  const converters = useMemo(() => (combined ? (converter ? [converter] : []) : convertersFor(job.formatId)), [combined, converter, job.formatId])
  const inputSize = job.inputs.reduce((n, f) => n + f.size, 0)
  const busy = job.status === 'working' || job.status === 'queued'
  const hasOptions = Boolean(converter?.options?.length)
  const title = combined ? `${job.inputs.length} files` : job.inputs[0].name

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
        <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Remove ${title}`}>
          <Icon name="x" size={18} />
        </button>
      </header>

      {!busy && job.status !== 'done' && (
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
          {combined ? <div className="chips"><span className="chip chip--active">{converter ? converterLabel(converter) : ''}</span></div> : <TargetPicker converters={converters} value={job.converterId} onChange={onConverter} />}
          {converter?.description && <p className="muted small job__desc">{converter.description}</p>}
          {showOptions && converter?.options && <OptionsPanel defs={converter.options} values={job.options} onChange={onOption} />}
        </div>
      )}

      {busy && (
        <div className="job__progress">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
            <div className={`progress__bar ${job.progress === 0 ? 'is-indeterminate' : ''}`} style={{ width: job.progress ? `${Math.max(3, job.progress * 100)}%` : undefined }} />
          </div>
          <div className="job__row">
            <span className="muted small" aria-live="polite">
              {job.statusText}
              {job.progress > 0 && ` ${Math.round(job.progress * 100)}%`}
            </span>
            <button type="button" className="btn btn--ghost btn--small" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {job.status === 'error' && (
        <div className="job__error" role="alert">
          <Icon name="alert" size={16} /> {job.error}
        </div>
      )}

      {job.status === 'done' && <Results job={job} inputSize={inputSize} onConvertAgain={onReset} />}

      {(job.status === 'ready' || job.status === 'error') && (
        <footer className="job__foot">
          <button type="button" className="btn btn--primary" onClick={onStart} disabled={!converter}>
            {job.status === 'error' ? <Icon name="refresh" size={16} /> : null}
            {job.status === 'error' ? 'Try again' : `Convert${converter ? ` to ${converterLabel(converter)}` : ''}`}
          </button>
        </footer>
      )}
    </article>
  )
}

function Results({ job, inputSize, onConvertAgain }: { job: Job; inputSize: number; onConvertAgain: () => void }) {
  const [busy, setBusy] = useState(false)
  const many = job.outputs.length > 1
  const shareable = canShareFiles()
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      alert(`Couldn't complete that: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }
  const stem = job.inputs[0].name.replace(/\.[^.]+$/, '')
  return (
    <div className="job__results">
      <ul className="outputs">
        {job.outputs.slice(0, 50).map((out, i) => (
          <OutputRow key={i} out={out} inputSize={inputSize} single={!many} />
        ))}
        {job.outputs.length > 50 && <li className="muted small">…and {job.outputs.length - 50} more</li>}
      </ul>
      <div className="job__actions">
        {many && (
          <button type="button" className="btn btn--primary" onClick={() => run(() => saveAll(job.outputs, stem))} disabled={busy}>
            <Icon name="download" size={16} /> Save all ({job.outputs.length})
          </button>
        )}
        {!many && (
          <button type="button" className="btn btn--primary" onClick={() => run(() => saveFile(job.outputs[0]))} disabled={busy}>
            <Icon name="download" size={16} /> Save
          </button>
        )}
        {shareable && (
          <button type="button" className="btn" onClick={() => run(() => shareFiles(job.outputs))} disabled={busy}>
            <Icon name="share" size={16} /> Share
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onConvertAgain}>
          Convert again
        </button>
      </div>
    </div>
  )
}
