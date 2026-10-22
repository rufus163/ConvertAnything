import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api'
import {
  cssFontFamily,
  EMPTY_STATE,
  extractRuns,
  fromHex,
  openPdfForEditing,
  readFont,
  runBox,
  sampleColors,
  saveEditedPdf,
  STANDARD_FONTS,
  toCss,
  toHex,
  type EditState,
  type FontInfo,
  type SaveReport,
  type TextEdit,
  type TextRun,
} from '../converters/engines/pdfEdit'
import { Icon } from './Icon'

interface Props {
  file: File
  initial?: EditState
  onClose: () => void
  onSaved: (blob: Blob, state: EditState, report: SaveReport) => void
}

type Mode = 'edit' | 'add'

interface PageSize {
  width: number
  height: number
}

const MAX_CANVAS_PIXELS = 8_000_000
let measureCtx: CanvasRenderingContext2D | null = null

function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 8
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

function fontLabel(font: FontInfo | undefined, key: string): string {
  if (font) return font.name.replace(/[-_,]+/g, ' ')
  return key
}

/** CSS font shorthand for an edit, matching what will be drawn into the PDF. */
function editFont(edit: Pick<TextEdit, 'font' | 'size'>, fonts: Map<string, FontInfo>, scale: number): { family: string; weight: string; style: string; px: number } {
  const info = fonts.get(edit.font)
  const std = STANDARD_FONTS.includes(edit.font as (typeof STANDARD_FONTS)[number])
  const family = std ? cssFontFamily({ key: edit.font, name: edit.font, bold: false, italic: false, serif: edit.font === 'Times', mono: edit.font === 'Courier' }) : cssFontFamily(info)
  // Embedded fonts already carry their weight; only synthesise it for fallbacks.
  const synth = !info?.data
  return {
    family,
    weight: synth && info?.bold ? '700' : '400',
    style: synth && info?.italic ? 'italic' : 'normal',
    px: edit.size * scale,
  }
}

export default function PdfEditor({ file, initial, onClose, onSaved }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [error, setError] = useState<string>()
  const [zoom, setZoom] = useState(0)
  const [mode, setMode] = useState<Mode>('edit')
  const [state, setState] = useState<EditState>(initial ?? EMPTY_STATE)
  const [selected, setSelected] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [loadedPages, setLoadedPages] = useState<Record<number, TextRun[]>>({})
  const [newTextStyle, setNewTextStyle] = useState({ font: 'Helvetica', size: 12, color: [0, 0, 0] as [number, number, number] })
  const [showHelp, setShowHelp] = useState(true)
  const runs = useRef(new Map<string, TextRun>())
  const fonts = useRef(new Map<string, FontInfo>())
  const history = useRef<EditState[]>([])
  const coalesce = useRef<string | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  // Open the document and measure every page.
  useEffect(() => {
    let closed = false
    let close: (() => Promise<void>) | undefined
    openPdfForEditing(file)
      .then(async (doc) => {
        close = doc.close
        if (closed) return doc.close()
        const out: PageSize[] = []
        for (let i = 1; i <= doc.pdf.numPages; i++) {
          const vp = (await doc.pdf.getPage(i)).getViewport({ scale: 1 })
          out.push({ width: vp.width, height: vp.height })
        }
        if (closed) return
        const available = (scroller.current?.clientWidth ?? 800) - 40
        setZoom(Math.min(1.6, Math.max(0.4, available / Math.max(...out.map((s) => s.width)))))
        setSizes(out)
        setPdf(doc.pdf)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    return () => {
      closed = true
      close?.()
    }
  }, [file])

  const mutate = useCallback((fn: (s: EditState) => EditState, key?: string) => {
    if (key === undefined || key !== coalesce.current) history.current.push(stateRef.current)
    if (history.current.length > 200) history.current.shift()
    coalesce.current = key
    setState((s) => fn(s))
  }, [])

  const undo = useCallback(() => {
    const prev = history.current.pop()
    coalesce.current = undefined
    if (prev) {
      setState(prev)
      selectedRef.current = undefined
      setSelected(undefined)
    }
  }, [])

  /** Drops edits that ended up identical to the original text. */
  const tidy = useCallback((id: string | undefined) => {
    if (!id) return
    setState((s) => {
      const e = s.edits[id]
      if (!e) return s
      const r = e.runId ? runs.current.get(e.runId) : undefined
      const unchanged = r ? !e.deleted && e.text === r.text && e.size === r.size && e.font === r.font && e.color.every((v, i) => Math.abs(v - r.color[i]) < 0.01) : !e.text.trim()
      if (!unchanged) return s
      const edits = { ...s.edits }
      delete edits[id]
      return { ...s, edits }
    })
  }, [])

  const selectedRef = useRef<string | undefined>(undefined)
  const select = useCallback(
    (id: string | undefined) => {
      const prev = selectedRef.current
      if (prev && prev !== id) tidy(prev)
      selectedRef.current = id
      setSelected(id)
      coalesce.current = undefined
    },
    [tidy],
  )

  const onRunsLoaded = useCallback((page: number, pageRuns: TextRun[], pageFonts: FontInfo[]) => {
    for (const r of pageRuns) runs.current.set(r.id, r)
    for (const f of pageFonts) fonts.current.set(f.key, f)
    setLoadedPages((p) => ({ ...p, [page]: pageRuns }))
  }, [])

  const editRun = useCallback(
    (run: TextRun) => {
      const id = `e-${run.id}`
      if (!stateRef.current.edits[id]) {
        mutate((s) => ({
          ...s,
          edits: { ...s.edits, [id]: { id, page: run.page, runId: run.id, text: run.text, x: run.x, y: run.y, angle: run.angle, size: run.size, font: run.font, color: run.color } },
        }))
      }
      select(id)
    },
    [mutate, select],
  )

  const addText = useCallback(
    (page: number, x: number, y: number, angle: number) => {
      const id = `n-${Date.now().toString(36)}`
      mutate((s) => ({ ...s, edits: { ...s.edits, [id]: { id, page, text: '', x, y, angle, size: newTextStyle.size, font: newTextStyle.font, color: newTextStyle.color } } }))
      select(id)
      setMode('edit')
    },
    [mutate, select, newTextStyle],
  )

  const updateEdit = useCallback(
    (id: string, patch: Partial<TextEdit>, key?: string) => {
      mutate((s) => (s.edits[id] ? { ...s, edits: { ...s.edits, [id]: { ...s.edits[id], ...patch } } } : s), key)
      const e = stateRef.current.edits[id]
      // Remember the style for the next new text box.
      if (e && !e.runId && (patch.font || patch.size || patch.color)) setNewTextStyle((st) => ({ ...st, ...(patch.font && { font: patch.font }), ...(patch.size && { size: patch.size }), ...(patch.color && { color: patch.color }) }))
    },
    [mutate],
  )

  const deleteEdit = useCallback(
    (id: string) => {
      const e = stateRef.current.edits[id]
      if (!e) return
      mutate((s) => {
        const edits = { ...s.edits }
        if (e.runId) edits[id] = { ...e, deleted: true }
        else delete edits[id]
        return { ...s, edits }
      })
      selectedRef.current = undefined
      setSelected(undefined)
    },
    [mutate],
  )

  const rotatePage = useCallback((page: number) => mutate((s) => ({ ...s, rotations: { ...s.rotations, [page]: ((s.rotations[page] ?? 0) + 90) % 360 } })), [mutate])
  const togglePage = useCallback(
    (page: number) => mutate((s) => ({ ...s, deletedPages: s.deletedPages.includes(page) ? s.deletedPages.filter((p) => p !== page) : [...s.deletedPages, page] })),
    [mutate],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT'
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        undo()
      } else if (e.key === 'Escape') {
        if (selected) select(undefined)
        else if (mode === 'add') setMode('edit')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, select, selected, mode])

  const changeCount = useMemo(
    () => Object.keys(state.edits).length + state.deletedPages.length + Object.values(state.rotations).filter((r) => r % 360).length,
    [state],
  )

  const close = () => {
    if (changeCount && !saving && !confirm('Discard your changes to this PDF?')) return
    onClose()
  }

  const save = async () => {
    select(undefined)
    setSaving(true)
    try {
      // Let the last edit's tidy-up land before reading the state.
      await new Promise((r) => setTimeout(r, 0))
      const { bytes, report } = await saveEditedPdf(file, stateRef.current, runs.current, fonts.current)
      onSaved(new Blob([bytes as BlobPart], { type: 'application/pdf' }), stateRef.current, report)
    } catch (e) {
      alert(`Couldn't save the PDF: ${e instanceof Error ? e.message : e}`)
      setSaving(false)
    }
  }

  const sel = selected ? state.edits[selected] : undefined
  const selRun = sel?.runId ? runs.current.get(sel.runId) : undefined
  const selFont = sel ? fonts.current.get(sel.font) : undefined

  return (
    <div className="editor" role="dialog" aria-label={`Edit ${file.name}`}>
      <header className="editor__bar">
        <button type="button" className="icon-btn" onClick={close} aria-label="Close editor">
          <Icon name="x" size={20} />
        </button>
        <div className="editor__title">
          <strong>Edit PDF</strong>
          <span className="muted small">{file.name}</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Tool">
          <button type="button" role="radio" aria-checked={mode === 'edit'} className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')}>
            <Icon name="edit" size={15} /> <span className="hide-mobile">Edit text</span>
          </button>
          <button type="button" role="radio" aria-checked={mode === 'add'} className={mode === 'add' ? 'is-active' : ''} onClick={() => (select(undefined), setMode('add'))}>
            <Icon name="text" size={15} /> <span className="hide-mobile">Add text</span>
          </button>
        </div>
        <div className="editor__tools">
          <button type="button" className="icon-btn" onClick={undo} disabled={!history.current.length} aria-label="Undo">
            <Icon name="undo" size={18} />
          </button>
          <button type="button" className="icon-btn hide-mobile" onClick={() => setZoom((z) => Math.max(0.3, z / 1.25))} aria-label="Zoom out">
            <Icon name="zoomOut" size={18} />
          </button>
          <span className="muted small editor__zoom hide-mobile">{Math.round(zoom * 100)}%</span>
          <button type="button" className="icon-btn hide-mobile" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} aria-label="Zoom in">
            <Icon name="zoomIn" size={18} />
          </button>
          <button type="button" className="btn btn--primary btn--small" onClick={save} disabled={saving || !pdf}>
            {saving ? 'Saving…' : 'Save PDF'}
          </button>
        </div>
      </header>

      {sel && (
        <div className="editor__props">
          <label className="select select--inline">
            <span className="muted small">Font</span>
            <select value={sel.font} onChange={(e) => updateEdit(sel.id, { font: e.target.value })}>
              {selRun && <option value={selRun.font}>{fontLabel(fonts.current.get(selRun.font), selRun.font)} (original)</option>}
              {STANDARD_FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="editor__field">
            <span className="muted small">Size</span>
            <input type="number" min={2} max={400} step={0.5} value={Math.round(sel.size * 10) / 10} onChange={(e) => Number(e.target.value) > 0 && updateEdit(sel.id, { size: Number(e.target.value) }, `size-${sel.id}`)} />
          </label>
          <label className="editor__field">
            <span className="muted small">Color</span>
            <input type="color" value={toHex(sel.color)} onChange={(e) => updateEdit(sel.id, { color: fromHex(e.target.value) }, `color-${sel.id}`)} />
          </label>
          {selFont && (
            <span className="muted small editor__fontinfo" title="Details read from the PDF">
              {selFont.data ? 'Embedded font' : 'System font'} · {Math.round((selRun?.size ?? sel.size) * 10) / 10} pt
            </span>
          )}
          <span className="editor__spacer" />
          <button type="button" className="btn btn--ghost btn--small" onClick={() => deleteEdit(sel.id)}>
            <Icon name="trash" size={15} /> Delete
          </button>
          <button type="button" className="btn btn--small" onClick={() => select(undefined)}>
            Done
          </button>
        </div>
      )}

      {showHelp && !sel && (
        <div className="editor__help">
          <span>
            {mode === 'add'
              ? 'Click anywhere on a page to add text.'
              : 'Click any text to change it. Edits replace the original text and keep the document’s own font, size and color where possible.'}
          </span>
          <button type="button" className="icon-btn" onClick={() => setShowHelp(false)} aria-label="Hide tip">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}

      <div className={`editor__pages ${mode === 'add' ? 'is-adding' : ''}`} ref={scroller} onPointerDown={(e) => e.target === e.currentTarget && select(undefined)}>
        {error && <p className="job__error">{error}</p>}
        {!pdf && !error && <p className="muted center editor__loading">Opening PDF…</p>}
        {pdf &&
          zoom > 0 &&
          sizes.map((size, i) => (
            <PageView
              key={i}
              pdf={pdf}
              index={i}
              size={size}
              zoom={zoom}
              rotation={state.rotations[i] ?? 0}
              deleted={state.deletedPages.includes(i)}
              runs={loadedPages[i]}
              edits={state.edits}
              fonts={fonts.current}
              selected={selected}
              mode={mode}
              root={scroller}
              onRunsLoaded={onRunsLoaded}
              onEditRun={editRun}
              onAddText={addText}
              onSelect={select}
              onChangeText={(id, text) => updateEdit(id, { text }, `text-${id}`)}
              onRotate={rotatePage}
              onToggleDelete={togglePage}
            />
          ))}
      </div>
    </div>
  )
}

interface PageProps {
  pdf: PDFDocumentProxy
  index: number
  size: PageSize
  zoom: number
  rotation: number
  deleted: boolean
  runs?: TextRun[]
  edits: Record<string, TextEdit>
  fonts: Map<string, FontInfo>
  selected?: string
  mode: Mode
  root: React.RefObject<HTMLDivElement | null>
  onRunsLoaded: (page: number, runs: TextRun[], fonts: FontInfo[]) => void
  onEditRun: (run: TextRun) => void
  onAddText: (page: number, x: number, y: number, angle: number) => void
  onSelect: (id: string | undefined) => void
  onChangeText: (id: string, text: string) => void
  onRotate: (page: number) => void
  onToggleDelete: (page: number) => void
}

const PageView = memo(function PageView(p: PageProps) {
  const { pdf, index, size, zoom, rotation, runs } = p
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [viewport, setViewport] = useState<import('pdfjs-dist/types/src/display/page_viewport').PageViewport>()
  const runsRequested = useRef(false)

  // Render only pages near the screen, and free the canvas of pages far away.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: p.root.current, rootMargin: '800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [p.root])

  useEffect(() => {
    const c = canvas.current
    if (!visible || !c) {
      if (c) c.width = c.height = 0
      return
    }
    let task: RenderTask | undefined
    let cancelled = false
    ;(async () => {
      const page = await pdf.getPage(index + 1)
      if (cancelled) return
      const vp = page.getViewport({ scale: zoom })
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height)))
      c.width = Math.floor(vp.width * ratio)
      c.height = Math.floor(vp.height * ratio)
      const ctx = c.getContext('2d', { willReadFrequently: !runsRequested.current })!
      task = page.render({ canvas: c, canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      try {
        await task.promise
      } catch {
        return // cancelled
      }
      if (cancelled) return
      setViewport(vp)
      if (!runsRequested.current) {
        runsRequested.current = true
        const { runs: found, styles } = await extractRuns(page, index, vp)
        sampleColors(found, ctx, vp, ratio)
        const keys = [...new Set(found.map((r) => r.font))]
        p.onRunsLoaded(
          index,
          found,
          keys.map((k) => readFont(page, k, styles[k]?.fontFamily)),
        )
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, zoom, pdf, index])

  const w = size.width * zoom
  const h = size.height * zoom
  const sideways = rotation % 180 !== 0
  const pageEdits = useMemo(() => Object.values(p.edits).filter((e) => e.page === index), [p.edits, index])
  const editedRuns = useMemo(() => new Set(pageEdits.map((e) => e.runId).filter(Boolean)), [pageEdits])

  const onPagePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (p.mode !== 'add' || !viewport) return p.onSelect(undefined)
    const rect = e.currentTarget.getBoundingClientRect()
    // Undo the CSS rotation to get coordinates on the unrotated page.
    let ox = e.clientX - rect.left
    let oy = e.clientY - rect.top
    if (rotation === 90) [ox, oy] = [oy, w - ox]
    else if (rotation === 180) [ox, oy] = [w - ox, h - oy]
    else if (rotation === 270) [ox, oy] = [h - oy, ox]
    const size12 = 12 * zoom
    const [x, y] = viewport.convertToPdfPoint(ox, oy + size12 * 0.8)
    const [ax, ay] = viewport.convertToPdfPoint(ox + 10, oy + size12 * 0.8)
    p.onAddText(index, x, y, Math.atan2(ay - y, ax - x))
    e.preventDefault()
  }

  return (
    <section className={`pdf-page ${p.deleted ? 'is-deleted' : ''}`} aria-label={`Page ${index + 1}`}>
      <div className="pdf-page__bar">
        <span className="muted small">
          Page {index + 1}
          {runs && runs.length === 0 && ' · no editable text (scanned?), you can still add text'}
        </span>
        <button type="button" className="icon-btn" onClick={() => p.onRotate(index)} aria-label={`Rotate page ${index + 1}`}>
          <Icon name="rotate" size={16} />
        </button>
        <button type="button" className={`icon-btn ${p.deleted ? 'is-active' : ''}`} onClick={() => p.onToggleDelete(index)} aria-label={p.deleted ? `Restore page ${index + 1}` : `Delete page ${index + 1}`}>
          <Icon name={p.deleted ? 'undo' : 'trash'} size={16} />
        </button>
      </div>
      <div className="pdf-page__frame" ref={wrap} style={{ width: sideways ? h : w, height: sideways ? w : h }}>
        <div
          className="pdf-page__sheet"
          style={{ width: w, height: h, transform: rotation ? `translate(-50%, -50%) rotate(${rotation}deg)` : 'translate(-50%, -50%)' }}
        >
          <canvas ref={canvas} style={{ width: w, height: h }} />
          <div className="pdf-page__layer" onPointerDown={onPagePointer}>
            {viewport &&
              runs?.map((r) => {
                if (!r.editable || editedRuns.has(r.id)) return null
                const b = runBox(viewport, r)
                return (
                  <button
                    key={r.id}
                    type="button"
                    className="pdf-run"
                    style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
                    onClick={() => p.mode === 'edit' && p.onEditRun(r)}
                    title={r.text}
                    aria-label={`Edit text: ${r.text}`}
                    tabIndex={p.mode === 'edit' ? 0 : -1}
                  />
                )
              })}
            {viewport && pageEdits.map((e) => <EditView key={e.id} {...p} edit={e} viewport={viewport} />)}
          </div>
        </div>
        {p.deleted && <div className="pdf-page__deleted">This page will be removed</div>}
      </div>
    </section>
  )
})

function EditView({
  edit,
  viewport,
  zoom,
  runs,
  fonts,
  selected,
  onSelect,
  onChangeText,
}: { edit: TextEdit; viewport: import('pdfjs-dist/types/src/display/page_viewport').PageViewport } & PageProps) {
  const input = useRef<HTMLInputElement>(null)
  const run = edit.runId ? runs?.find((r) => r.id === edit.runId) : undefined
  const isSelected = selected === edit.id
  const f = editFont(edit, fonts, zoom)
  const ascent = run?.ascent ?? 0.8
  const descent = run?.descent ?? 0.2
  const [left, baseline] = viewport.convertToViewportPoint(edit.x, edit.y)
  const top = baseline - ascent * f.px
  const height = (ascent + descent) * f.px
  const cssFont = `${f.style} ${f.weight} ${f.px}px ${f.family}`
  const width = Math.max(textWidth(edit.text || ' ', cssFont) + 6, run ? run.width * zoom : 40)

  useLayoutEffect(() => {
    if (isSelected) input.current?.focus({ preventScroll: false })
  }, [isSelected])

  const cover = run ? runBox(viewport, run) : undefined
  const pad = run ? run.size * zoom * 0.08 : 0
  const textStyle: React.CSSProperties = {
    left,
    top,
    height,
    width,
    font: cssFont,
    lineHeight: `${height}px`,
    color: toCss(edit.color),
  }

  return (
    <>
      {cover && (
        <div
          className="pdf-cover"
          style={{ left: cover.left - pad, top: cover.top - pad, width: cover.width + pad * 2, height: cover.height + pad * 2, background: toCss(run!.background) }}
          onClick={() => onSelect(edit.id)}
        />
      )}
      {!edit.deleted &&
        (isSelected ? (
          <input
            ref={input}
            className="pdf-edit pdf-edit--active"
            style={textStyle}
            value={edit.text}
            onChange={(e) => onChangeText(edit.id, e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(undefined)}
            aria-label="Text"
            placeholder="Type here"
          />
        ) : (
          <div className="pdf-edit" style={textStyle} onClick={() => onSelect(edit.id)} role="button" tabIndex={0} aria-label={`Edited text: ${edit.text}`}>
            {edit.text}
          </div>
        ))}
    </>
  )
}
