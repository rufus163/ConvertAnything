// PDF text editing: reads every text run's real font, size, color and position with pdf.js,
// and writes edits back with pdf-lib, reusing the PDF's own embedded font whenever it
// contains the characters needed.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api'
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport'
import type { PDFDocument as PdfLibDocument, PDFFont } from 'pdf-lib'
import { ConversionError } from '../types'
import { toWinAnsi } from './winAnsi'

export type RGB = [number, number, number]

export interface FontInfo {
  /** pdf.js internal name; also the CSS font-family pdf.js registers for rendering. */
  key: string
  /** Name as stored in the PDF, without the subset prefix ("Calibri-Bold"). */
  name: string
  bold: boolean
  italic: boolean
  serif: boolean
  mono: boolean
  /** Font program (OpenType) when the PDF embeds the font. */
  data?: Uint8Array
}

export interface TextRun {
  id: string
  page: number
  text: string
  /** Baseline origin in PDF user space. */
  x: number
  y: number
  /** Text direction in user space, radians. */
  angle: number
  /** Advance width in user space units. */
  width: number
  size: number
  /** Fractions of the font size above and below the baseline. */
  ascent: number
  descent: number
  font: string
  color: RGB
  background: RGB
  /** Only text that reads left-to-right on screen can be edited in place. */
  editable: boolean
}

export interface TextEdit {
  id: string
  page: number
  /** Set when this edit replaces existing text. */
  runId?: string
  text: string
  x: number
  y: number
  angle: number
  size: number
  font: string
  color: RGB
  deleted?: boolean
}

export interface EditState {
  edits: Record<string, TextEdit>
  /** Extra clockwise rotation per page, in degrees. */
  rotations: Record<number, number>
  deletedPages: number[]
}

export const EMPTY_STATE: EditState = { edits: {}, rotations: {}, deletedPages: [] }

/** Fonts that new text can use; also the fallbacks for edits. */
export const STANDARD_FONTS = ['Helvetica', 'Times', 'Courier'] as const

// ---------- Loading ----------

export async function openPdfForEditing(file: File): Promise<{ pdf: PDFDocumentProxy; close: () => Promise<void> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  // fontExtraProperties keeps each font's name, style flags and program available after rendering.
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), fontExtraProperties: true })
  try {
    const pdf = await task.promise
    return { pdf, close: () => task.destroy() }
  } catch (e) {
    await task.destroy()
    if (e instanceof Error && e.name === 'PasswordException') throw new ConversionError('This PDF is password protected.')
    throw new ConversionError('This PDF could not be opened.')
  }
}

const cleanFontName = (name: string) => name.replace(/^[A-Z]{6}\+/, '')

interface PdfJsFont {
  name?: string
  bold?: boolean
  italic?: boolean
  black?: boolean
  isSerifFont?: boolean
  isMonospace?: boolean
  isType3Font?: boolean
  missingFile?: boolean
  data?: Uint8Array
}

/** Reads font details pdf.js loaded while rendering the page. */
export function readFont(page: PDFPageProxy, key: string, fallbackFamily?: string): FontInfo {
  let f: PdfJsFont = {}
  try {
    if (page.commonObjs.has(key)) f = page.commonObjs.get(key) as PdfJsFont
  } catch {
    // not loaded
  }
  const name = cleanFontName(f.name ?? fallbackFamily ?? 'Unknown')
  return {
    key,
    name,
    bold: Boolean(f.bold || f.black) || /bold|black|heavy|semibold|demi/i.test(name),
    italic: Boolean(f.italic) || /italic|oblique/i.test(name),
    serif: Boolean(f.isSerifFont) || /times|serif|georgia|garamond|cambria|book/i.test(name),
    mono: Boolean(f.isMonospace) || /courier|mono|consol/i.test(name),
    data: !f.isType3Font && !f.missingFile && f.data?.length ? f.data : undefined,
  }
}

interface RawItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL: boolean
}

/** Groups pdf.js text items into line-sized runs that share a font, size and direction. */
export async function extractRuns(page: PDFPageProxy, pageIndex: number, viewport: PageViewport): Promise<{ runs: TextRun[]; styles: Record<string, { fontFamily: string; ascent: number; descent: number }> }> {
  const content = await page.getTextContent()
  const styles = content.styles as Record<string, { fontFamily: string; ascent: number; descent: number }>
  const runs: TextRun[] = []
  let cur: TextRun | undefined

  for (const raw of content.items) {
    if (!('str' in raw)) continue
    const item = raw as RawItem
    if (!item.str) continue
    const [a, b, c, d, e, f] = item.transform
    const size = Math.hypot(c, d) || Math.hypot(a, b)
    if (size < 0.5) continue
    const angle = Math.atan2(b, a)
    const style = styles[item.fontName]
    const ascent = style?.ascent ? Math.min(1.2, Math.max(0.5, style.ascent)) : 0.8
    const descent = style?.descent ? Math.min(0.5, Math.max(0.1, -style.descent)) : 0.2

    if (cur && cur.font === item.fontName && Math.abs(cur.size - size) < 0.05 * size && Math.abs(cur.angle - angle) < 0.01) {
      const ux = Math.cos(angle)
      const uy = Math.sin(angle)
      const dx = e - cur.x
      const dy = f - cur.y
      const along = dx * ux + dy * uy
      const across = -dx * uy + dy * ux
      const gap = along - cur.width
      if (Math.abs(across) < 0.2 * size && gap > -0.3 * size && gap < 1.2 * size) {
        if (gap > 0.18 * size && !cur.text.endsWith(' ') && !item.str.startsWith(' ')) cur.text += ' '
        cur.text += item.str
        cur.width = Math.max(cur.width, along + item.width)
        if (item.hasEOL) cur = undefined
        continue
      }
    }
    cur = {
      id: `p${pageIndex}-r${runs.length}`,
      page: pageIndex,
      text: item.str,
      x: e,
      y: f,
      angle,
      width: item.width,
      size,
      ascent,
      descent,
      font: item.fontName,
      color: [0, 0, 0],
      background: [1, 1, 1],
      editable: isUpright(viewport, e, f, angle),
    }
    runs.push(cur)
    if (item.hasEOL) cur = undefined
  }
  for (const r of runs) r.text = r.text.replace(/\s+$/, '')
  return { runs: runs.filter((r) => r.text.trim()), styles }
}

/** True when the run reads left-to-right on screen (after page rotation). */
function isUpright(viewport: PageViewport, x: number, y: number, angle: number): boolean {
  const [x0, y0] = viewport.convertToViewportPoint(x, y)
  const [x1, y1] = viewport.convertToViewportPoint(x + Math.cos(angle) * 10, y + Math.sin(angle) * 10)
  return Math.abs(Math.atan2(y1 - y0, x1 - x0)) < 0.02
}

/** Screen box of a run (CSS px at the viewport's scale). */
export function runBox(viewport: PageViewport, r: Pick<TextRun, 'x' | 'y' | 'width' | 'size' | 'ascent' | 'descent'>) {
  const [left, baseline] = viewport.convertToViewportPoint(r.x, r.y)
  const s = viewport.scale
  return { left, top: baseline - r.ascent * r.size * s, width: Math.max(r.width * s, 2), height: (r.ascent + r.descent) * r.size * s, baseline }
}

/**
 * Samples the rendered page to find each run's text and background colors,
 * since a PDF's text color isn't part of pdf.js's text content.
 */
export function sampleColors(runs: TextRun[], ctx: CanvasRenderingContext2D, viewport: PageViewport, pixelRatio: number) {
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  for (const r of runs) {
    if (!r.editable) continue
    const box = runBox(viewport, r)
    const x0 = Math.max(0, Math.floor((box.left - 1) * pixelRatio))
    const y0 = Math.max(0, Math.floor((box.top - 1) * pixelRatio))
    const x1 = Math.min(W, Math.ceil((box.left + box.width + 1) * pixelRatio))
    const y1 = Math.min(H, Math.ceil((box.top + box.height + 1) * pixelRatio))
    if (x1 - x0 < 2 || y1 - y0 < 2) continue
    let px: Uint8ClampedArray
    try {
      px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
    } catch {
      continue
    }
    const w = x1 - x0
    const h = y1 - y0
    // Background: the most common (quantised) color along the box edge.
    const counts = new Map<number, number>()
    const edge = (i: number) => {
      const q = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4)
      counts.set(q, (counts.get(q) ?? 0) + 1)
    }
    for (let x = 0; x < w; x++) {
      edge(x * 4)
      edge(((h - 1) * w + x) * 4)
    }
    for (let y = 0; y < h; y++) {
      edge(y * w * 4)
      edge((y * w + w - 1) * 4)
    }
    let bgQ = 0xfff
    let best = -1
    for (const [q, n] of counts) if (n > best) [bgQ, best] = [q, n]
    const bg: RGB = [((bgQ >> 8) & 15) * 17, ((bgQ >> 4) & 15) * 17, (bgQ & 15) * 17]
    // Text: average of the pixels furthest from the background (skips anti-aliased edges).
    let maxDist = 0
    const dist = (i: number) => Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2])
    for (let i = 0; i < px.length; i += 4) maxDist = Math.max(maxDist, dist(i))
    let sum = [0, 0, 0]
    let n = 0
    if (maxDist > 40) {
      for (let i = 0; i < px.length; i += 4) {
        if (dist(i) >= maxDist * 0.7) {
          sum = [sum[0] + px[i], sum[1] + px[i + 1], sum[2] + px[i + 2]]
          n++
        }
      }
    }
    r.background = [bg[0] / 255, bg[1] / 255, bg[2] / 255]
    r.color = n ? [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255] : [0, 0, 0]
  }
}

export const toCss = ([r, g, b]: RGB) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`
export const toHex = ([r, g, b]: RGB) => '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
export const fromHex = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB

export function cssFontFamily(font: FontInfo | undefined): string {
  if (!font) return 'Helvetica, Arial, sans-serif'
  const generic = font.mono ? '"Courier New", monospace' : font.serif ? '"Times New Roman", Times, serif' : 'Helvetica, Arial, sans-serif'
  return font.data ? `"${font.key}", ${generic}` : generic
}

// ---------- Saving ----------

export interface SaveReport {
  edited: number
  exactFont: number
  /** Edits where some characters used a standard font because the original (subset) font lacks them. */
  substituted: string[]
}

export async function saveEditedPdf(
  file: File,
  state: EditState,
  runs: Map<string, TextRun>,
  fonts: Map<string, FontInfo>,
): Promise<{ bytes: Uint8Array; report: SaveReport }> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib')
  let doc: PdfLibDocument
  try {
    doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false })
  } catch {
    throw new ConversionError('This PDF could not be opened for editing.')
  }
  const fontkit = (await import('@pdf-lib/fontkit')).default
  doc.registerFontkit(fontkit)

  type PdfFont = PDFFont
  const embedded = new Map<string, { font: PdfFont; chars: Set<number> } | null>()
  const standard = new Map<string, PdfFont>()

  async function standardFont(info: Pick<FontInfo, 'bold' | 'italic' | 'serif' | 'mono'>): Promise<PdfFont> {
    const name = info.mono
      ? info.bold
        ? info.italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold
        : info.italic ? StandardFonts.CourierOblique : StandardFonts.Courier
      : info.serif
        ? info.bold
          ? info.italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold
          : info.italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman
        : info.bold
          ? info.italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold
          : info.italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica
    if (!standard.has(name)) standard.set(name, await doc.embedFont(name))
    return standard.get(name)!
  }

  async function embeddedFont(key: string) {
    const info = fonts.get(key)
    if (!info?.data) return null
    if (!embedded.has(key)) {
      try {
        const font = await doc.embedFont(info.data, { subset: false })
        embedded.set(key, { font, chars: new Set(font.getCharacterSet()) })
      } catch {
        embedded.set(key, null)
      }
    }
    return embedded.get(key) ?? null
  }

  async function fallbackFont(key: string) {
    const info = fonts.get(key)
    const std = STANDARD_FONTS.includes(key as (typeof STANDARD_FONTS)[number])
      ? { bold: false, italic: false, serif: key === 'Times', mono: key === 'Courier' }
      : (info ?? { bold: false, italic: false, serif: false, mono: false })
    return standardFont(std)
  }

  /**
   * Splits text into pieces drawn with the PDF's own font wherever it has the glyph, and the
   * closest standard font for characters the (usually subset) original font doesn't contain.
   * Whitespace becomes a gap, since subset fonts often have no space glyph.
   */
  async function layout(key: string, text: string) {
    const own = await embeddedFont(key)
    const fallback = await fallbackFont(key)
    type Piece = { text: string; font: PdfFont | null }
    const pieces: Piece[] = []
    let missing = 0
    for (const ch of text) {
      const font = /\s/.test(ch) ? null : own && own.chars.has(ch.codePointAt(0)!) ? own.font : fallback
      if (font === fallback && !/\s/.test(ch)) missing++
      const last = pieces[pieces.length - 1]
      if (last && last.font === font) last.text += ch
      else pieces.push({ text: ch, font })
    }
    for (const p of pieces) if (p.font === fallback) p.text = toWinAnsi(p.text)
    const spaceFont = own?.chars.has(32) ? own.font : fallback
    const spaceWidth = (size: number) => spaceFont.widthOfTextAtSize(' ', size)
    return { pieces, spaceWidth, usesOwn: Boolean(own) && missing < [...text].filter((c) => !/\s/.test(c)).length, missing, hadOwn: Boolean(own) }
  }

  const report: SaveReport = { edited: 0, exactFont: 0, substituted: [] }
  const pages = doc.getPages()

  for (const edit of Object.values(state.edits)) {
    const page = pages[edit.page]
    if (!page) continue
    const run = edit.runId ? runs.get(edit.runId) : undefined
    const changed = !run || edit.deleted || edit.text !== run.text || edit.size !== run.size || edit.font !== run.font || edit.color.some((v, i) => Math.abs(v - run.color[i]) > 0.01)
    if (!changed) continue
    report.edited++

    if (run) {
      // Cover the original text with its own background color.
      const pad = run.size * 0.08
      const ux = Math.cos(run.angle)
      const uy = Math.sin(run.angle)
      const down = run.descent * run.size + pad
      page.drawRectangle({
        x: run.x - ux * pad + uy * down,
        y: run.y - uy * pad - ux * down,
        width: run.width + pad * 2,
        height: (run.ascent + run.descent) * run.size + pad * 2,
        rotate: degrees((run.angle * 180) / Math.PI),
        color: rgb(...run.background),
      })
    }
    if (edit.deleted || !edit.text.trim()) continue

    const { pieces, spaceWidth, usesOwn, missing, hadOwn } = await layout(edit.font, edit.text)
    if (usesOwn && !missing) report.exactFont++
    else if (hadOwn) report.substituted.push(edit.text)
    const style = { size: edit.size, color: rgb(...edit.color), rotate: degrees((edit.angle * 180) / Math.PI) }
    const ux = Math.cos(edit.angle)
    const uy = Math.sin(edit.angle)
    let advance = 0
    for (const piece of pieces) {
      if (!piece.font) {
        advance += spaceWidth(edit.size) * piece.text.replace(/\t/g, '    ').length
        continue
      }
      page.drawText(piece.text, { x: edit.x + ux * advance, y: edit.y + uy * advance, font: piece.font, ...style })
      advance += piece.font.widthOfTextAtSize(piece.text, edit.size)
    }
  }

  for (const [index, extra] of Object.entries(state.rotations)) {
    const page = pages[Number(index)]
    if (page && extra % 360) page.setRotation(degrees((page.getRotation().angle + extra) % 360))
  }
  for (const index of [...state.deletedPages].sort((a, b) => b - a)) {
    if (doc.getPageCount() > 1) doc.removePage(index)
  }
  return { bytes: await doc.save(), report }
}
