import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditState, SaveReport } from './converters/engines/pdfEdit'
import { acceptAttribute, baseName, detectFormat } from './converters/formats'
import { combineConvertersFor, commonTargets, converterLabel } from './converters/registry'
import { Icon } from './components/Icon'
import { FormatBrowser, Hero, type Shortcut } from './components/Home'
import { JobCard } from './components/JobCard'
import { SettingsPanel } from './components/SettingsPanel'
import { useJobs, type Job } from './lib/jobs'
import { saveAll } from './lib/save'
import { useSettings } from './lib/settings'
import { useTheme } from './lib/theme'

// The editor pulls in pdf.js and fontkit, so it's only downloaded when opened.
const PdfEditor = lazy(() => import('./components/PdfEditor'))

const MEDIA = new Set(['video', 'audio'])
/** Pseudo-converter id used by the "Edit a PDF" shortcut. */
const EDIT_PDF = 'edit-pdf'

const warmUpMedia = () => import('./converters/engines/media').then((m) => m.warmUpMedia())

function editNote(report: SaveReport): string {
  if (!report.edited) return 'Pages updated'
  const parts = [`${report.edited} edit${report.edited === 1 ? '' : 's'}`]
  if (report.exactFont) parts.push(`${report.exactFont} in the original font`)
  if (report.substituted.length) parts.push(`${report.substituted.length} with some characters in the closest standard font (the original font doesn't include them)`)
  return parts.join(', ')
}

export default function App() {
  const { jobs, actions } = useJobs()
  const { settings } = useSettings()
  const { theme, toggle } = useTheme()
  const input = useRef<HTMLInputElement>(null)
  const intent = useRef<string | undefined>(undefined)
  const pendingEdit = useRef<File | undefined>(undefined)
  const [accept, setAccept] = useState('')
  const [dragging, setDragging] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const editing = jobs.find((j) => j.id === editingId)

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return
      const wantsEdit = intent.current === EDIT_PDF
      actions.addFiles(files, wantsEdit ? undefined : intent.current)
      if (wantsEdit) pendingEdit.current = files.find((f) => detectFormat(f)?.id === 'pdf')
      intent.current = undefined
      // Start downloading the media engine while the user picks a format.
      if (files.some((f) => MEDIA.has(detectFormat(f)?.category ?? ''))) warmUpMedia()
    },
    [actions],
  )

  // "Edit a PDF" shortcut: open the editor once the file's card exists.
  useEffect(() => {
    if (!pendingEdit.current) return
    const job = jobs.find((j) => j.inputs[0] === pendingEdit.current)
    if (job) {
      pendingEdit.current = undefined
      setEditingId(job.id)
    }
  }, [jobs])

  // Optional: fetch the media engine while the browser is idle after startup.
  useEffect(() => {
    if (!settings.preloadMedia) return
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500))
    idle(() => warmUpMedia())
  }, [settings.preloadMedia])

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
  const openEditor = useCallback((job: Job) => setEditingId(job.id), [])

  const onEdited = (blob: Blob, state: EditState, report: SaveReport) => {
    if (!editing) return
    actions.complete(editing.id, [{ name: `${baseName(editing.inputs[0].name)}-edited.pdf`, blob }], { editState: state, note: editNote(report) })
    setEditingId(undefined)
  }

  const pending = jobs.filter((j) => j.inputs.length === 1 && (j.status === 'ready' || j.status === 'error'))
  const startable = jobs.filter((j) => (j.status === 'ready' || j.status === 'error') && j.converterId)
  const finished = jobs.filter((j) => j.status === 'done')
  const active = jobs.filter((j) => j.status === 'working' || j.status === 'queued')
  const pendingFiles = useMemo(() => pending.map((j) => j.inputs[0]), [pending])
  const combiners = useMemo(() => combineConvertersFor(pendingFiles), [pendingFiles])
  const common = useMemo(() => commonTargets(pendingFiles), [pendingFiles])
  const [savingAll, setSavingAll] = useState(false)
  // Overall progress across everything that's running or finished.
  const tracked = [...active, ...finished]
  const overall = tracked.length ? tracked.reduce((n, j) => n + (j.status === 'done' ? 1 : j.progress), 0) / tracked.length : 0

  return (
    <div className={`app ${dragging ? 'is-dragging' : ''}`}>
      <header className="topbar">
        <a className="brand" href="./" onClick={(e) => (e.preventDefault(), actions.clear())}>
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
          <button type="button" className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings">
            <Icon name="settings" size={18} />
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
                  <strong>
                    {jobs.length} items
                    {tracked.length > 0 && (
                      <span className="muted small batch__summary">
                        {' '}
                        · {finished.length} of {tracked.length} done
                        {active.length > 0 && ` · ${Math.round(overall * 100)}%`}
                      </span>
                    )}
                  </strong>
                  <div className="batch__actions">
                    {finished.length > 1 && (
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={savingAll}
                        onClick={async () => {
                          setSavingAll(true)
                          try {
                            if (await saveAll(finished.flatMap((j) => j.outputs), 'converted')) finished.forEach((j) => actions.saved(j.id))
                          } finally {
                            setSavingAll(false)
                          }
                        }}
                      >
                        <Icon name="download" size={16} /> Save all results
                      </button>
                    )}
                    <button type="button" className="btn btn--ghost btn--small" onClick={actions.clear}>
                      <Icon name="trash" size={16} /> Clear
                    </button>
                  </div>
                </div>
                {active.length > 0 && (
                  <div className="progress progress--thin" role="progressbar" aria-label="Overall progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
                    <div className="progress__bar" style={{ width: `${Math.max(2, overall * 100)}%` }} />
                  </div>
                )}
                {pending.length > 1 && (common.length > 0 || combiners.length > 0) && (
                  <div className="batch__row batch__row--wrap">
                    {common.length > 0 && (
                      <label className="select select--inline">
                        <span className="muted small">All to</span>
                        <select
                          value=""
                          onChange={(e) => {
                            const target = common.find((c) => c.label === e.target.value)
                            target?.ids.forEach((cid, i) => actions.setConverter(pending[i].id, cid))
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
                      <button key={c.id} type="button" className="btn btn--small" onClick={() => actions.combine(pending.map((j) => j.id), c.id)}>
                        <Icon name={c.to === 'zip' ? 'archive' : 'layers'} size={16} />
                        {c.id === 'zip' ? `Bundle ${pending.length} files as ZIP` : c.id === 'image-pdf' ? `Combine into one PDF` : converterLabel(c)}
                      </button>
                    ))}
                  </div>
                )}
                {startable.length > 1 && (
                  <button type="button" className="btn btn--primary btn--block" onClick={() => actions.start(startable.map((j) => j.id))}>
                    Convert all ({startable.length})
                  </button>
                )}
              </div>
            )}

            <div className="jobs">
              {jobs.map((job) => (
                <JobCard key={job.id} job={job} actions={actions} onEditPdf={openEditor} />
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

      {dragging && !editing && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <Icon name="upload" size={36} />
            <p>Drop to add files</p>
          </div>
        </div>
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {editing && (
        <Suspense fallback={<div className="editor editor--loading">Opening editor…</div>}>
          <PdfEditor file={editing.inputs[0]} initial={editing.editState as EditState | undefined} onClose={() => setEditingId(undefined)} onSaved={onEdited} />
        </Suspense>
      )}
    </div>
  )
}
