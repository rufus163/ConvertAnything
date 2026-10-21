import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { acceptAttribute, detectFormat } from './converters/formats'
import { combineConvertersFor, commonTargets, converterLabel } from './converters/registry'
import { Icon } from './components/Icon'
import { FormatBrowser, Hero, type Shortcut } from './components/Home'
import { JobCard } from './components/JobCard'
import { useJobs } from './lib/jobs'
import { saveAll } from './lib/save'
import { useTheme } from './lib/theme'

const MEDIA = new Set(['video', 'audio'])

export default function App() {
  const { jobs, addFiles, setConverter, setOption, start, reset, cancel, remove, clear, combine } = useJobs()
  const { theme, toggle } = useTheme()
  const input = useRef<HTMLInputElement>(null)
  const intent = useRef<string | undefined>(undefined)
  const [accept, setAccept] = useState('')
  const [dragging, setDragging] = useState(false)

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return
      addFiles(files, intent.current)
      intent.current = undefined
      // Start downloading the media engine while the user picks a format.
      if (files.some((f) => MEDIA.has(detectFormat(f)?.category ?? ''))) import('./converters/engines/media').then((m) => m.warmUpMedia())
    },
    [addFiles],
  )

  const browse = useCallback((formats?: string[], converter?: string) => {
    intent.current = converter
    setAccept(formats ? acceptAttribute(formats) : '')
    // Let React apply the accept attribute before opening the picker.
    requestAnimationFrame(() => input.current?.click())
  }, [])

  // Drag & drop anywhere, paste from clipboard, and "Open with" for the installed web app.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      add(Array.from(e.dataTransfer?.files ?? []))
    }
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) add(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue
    lq?.setConsumer(async ({ files }) => add(await Promise.all(files.map((h) => h.getFile()))))
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [add])

  const onShortcut = (s: Shortcut) => browse(s.from, s.converter)

  const pending = jobs.filter((j) => j.inputs.length === 1 && (j.status === 'ready' || j.status === 'error'))
  const startable = jobs.filter((j) => (j.status === 'ready' || j.status === 'error') && j.converterId)
  const finished = jobs.filter((j) => j.status === 'done')
  const pendingFiles = useMemo(() => pending.map((j) => j.inputs[0]), [pending])
  const combiners = useMemo(() => combineConvertersFor(pendingFiles), [pendingFiles])
  const common = useMemo(() => commonTargets(pendingFiles), [pendingFiles])
  const [savingAll, setSavingAll] = useState(false)

  return (
    <div className={`app ${dragging ? 'is-dragging' : ''}`}>
      <header className="topbar">
        <a className="brand" href="./" onClick={(e) => (e.preventDefault(), clear())}>
          <img src="favicon.svg" alt="" width={28} height={28} />
          <span>ConvertAnything</span>
        </a>
        <div className="topbar__actions">
          {jobs.length > 0 && (
            <button type="button" className="btn btn--small" onClick={() => browse()}>
              <Icon name="plus" size={16} /> Add files
            </button>
          )}
          <button type="button" className="icon-btn" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
        </div>
      </header>

      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />

      <main className="main">
        {jobs.length === 0 ? (
          <>
            <Hero onBrowse={() => browse()} onShortcut={onShortcut} />
            <FormatBrowser onPick={(id) => browse([id])} />
          </>
        ) : (
          <>
            {jobs.length > 1 && (
              <div className="card batch">
                <div className="batch__row">
                  <strong>{jobs.length} items</strong>
                  <div className="batch__actions">
                    {finished.length > 1 && (
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={savingAll}
                        onClick={async () => {
                          setSavingAll(true)
                          try {
                            await saveAll(finished.flatMap((j) => j.outputs), 'converted')
                          } finally {
                            setSavingAll(false)
                          }
                        }}
                      >
                        <Icon name="download" size={16} /> Save all results
                      </button>
                    )}
                    <button type="button" className="btn btn--ghost btn--small" onClick={clear}>
                      <Icon name="trash" size={16} /> Clear
                    </button>
                  </div>
                </div>
                {pending.length > 1 && (common.length > 0 || combiners.length > 0) && (
                  <div className="batch__row batch__row--wrap">
                    {common.length > 0 && (
                      <label className="select select--inline">
                        <span className="muted small">All to</span>
                        <select
                          value=""
                          onChange={(e) => {
                            const target = common.find((c) => c.label === e.target.value)
                            target?.ids.forEach((cid, i) => setConverter(pending[i].id, cid))
                          }}
                        >
                          <option value="" disabled>
                            Choose…
                          </option>
                          {common.map((c) => (
                            <option key={c.label} value={c.label}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {combiners.map((c) => (
                      <button key={c.id} type="button" className="btn btn--small" onClick={() => combine(pending.map((j) => j.id), c.id)}>
                        <Icon name={c.to === 'zip' ? 'archive' : 'layers'} size={16} />
                        {c.id === 'zip' ? `Bundle ${pending.length} files as ZIP` : c.id === 'image-pdf' ? `Combine into one PDF` : converterLabel(c)}
                      </button>
                    ))}
                  </div>
                )}
                {startable.length > 1 && (
                  <button type="button" className="btn btn--primary btn--block" onClick={() => start(startable.map((j) => j.id))}>
                    Convert all ({startable.length})
                  </button>
                )}
              </div>
            )}

            <div className="jobs">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  onConverter={(cid) => setConverter(job.id, cid)}
                  onOption={(k, v) => setOption(job, k, v)}
                  onStart={() => start([job.id])}
                  onReset={() => reset(job.id)}
                  onCancel={() => cancel(job.id)}
                  onRemove={() => remove(job.id)}
                />
              ))}
            </div>

            <button type="button" className="dropzone dropzone--compact" onClick={() => browse()}>
              <Icon name="plus" size={18} />
              <span>
                Add more files<span className="hide-mobile"> — or drop them anywhere</span>
              </span>
            </button>
          </>
        )}
      </main>

      <footer className="footer">
        <Icon name="lock" size={14} /> Files are converted on your device and never uploaded.
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="upload" size={36} />
            <p>Drop to add files</p>
          </div>
        </div>
      )}
    </div>
  )
}
