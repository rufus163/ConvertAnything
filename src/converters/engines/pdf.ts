import { degrees, PDFDocument, type PDFImage, type PDFPage } from 'pdf-lib'
import { jpegOrientation } from '../encoders'
import { baseName, detectFormat } from '../formats'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'
import { canvasToBlob, decodeImage, encodeCanvas, releaseCanvas } from './image'
import { PAGE_SIZES } from './pdfWriter'

const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'application/pdf' })

function checkAbort(ctx: ConvertContext) {
  if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
}

// ---------- Images → PDF ----------

/** Display rotation needed for an embedded image, from EXIF: 1 = none, 3 = 180°, 6 = 90° CW, 8 = 90° CCW. */
type Orientation = 1 | 3 | 6 | 8

interface Embedded {
  image: PDFImage
  orientation: Orientation
  /** Size as displayed (after orientation). */
  width: number
  height: number
}

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true
  return false
}

async function embedImage(doc: PDFDocument, file: File, opts: Options, ctx: ConvertContext): Promise<Embedded> {
  const fmt = detectFormat(file)?.id
  const quality = Number(opts.quality ?? 90)
  const resized = String(opts.resize ?? 'original') !== 'original'
  const keepOriginal = !resized && quality >= 90

  // Fast, lossless path: JPG and PNG bytes go into the PDF untouched.
  if (keepOriginal && fmt === 'png') {
    const image = await doc.embedPng(new Uint8Array(await file.arrayBuffer()))
    return { image, orientation: 1, width: image.width, height: image.height }
  }
  if (keepOriginal && fmt === 'jpg') {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const exif = jpegOrientation(bytes.subarray(0, 65536))
    // Mirrored orientations (2, 4, 5, 7) are rare; those go through the canvas below.
    if (exif === 1 || exif === 3 || exif === 6 || exif === 8) {
      const image = await doc.embedJpg(bytes)
      const sideways = exif === 6 || exif === 8
      return { image, orientation: exif, width: sideways ? image.height : image.width, height: sideways ? image.width : image.height }
    }
  }

  // Everything else goes through a canvas, which also applies EXIF rotation and resizing.
  const { canvas } = await decodeImage(file, opts, ctx)
  try {
    let image: PDFImage
    const jpegFriendly = fmt === 'jpg' || fmt === 'heic' || (quality < 90 && !hasTransparency(canvas))
    if (quality < 100 && jpegFriendly) {
      const jpg = await canvasToBlob(canvas, 'image/jpeg', Math.min(quality, 95) / 100)
      image = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()))
    } else {
      const png = await canvasToBlob(canvas, 'image/png')
      image = await doc.embedPng(new Uint8Array(await png.arrayBuffer()))
    }
    return { image, orientation: 1, width: image.width, height: image.height }
  } finally {
    releaseCanvas(canvas)
  }
}

/** Draws an image into a box, rotating it on the page instead of re-encoding the pixels. */
function drawOriented(page: PDFPage, e: Embedded, x: number, y: number, w: number, h: number) {
  switch (e.orientation) {
    case 6: // 90° clockwise
      return page.drawImage(e.image, { x, y: y + h, width: h, height: w, rotate: degrees(-90) })
    case 8: // 90° counter-clockwise
      return page.drawImage(e.image, { x: x + w, y, width: h, height: w, rotate: degrees(90) })
    case 3:
      return page.drawImage(e.image, { x: x + w, y: y + h, width: w, height: h, rotate: degrees(180) })
    default:
      return page.drawImage(e.image, { x, y, width: w, height: h })
  }
}

export async function imagesToPdf(files: File[], opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  const doc = await PDFDocument.create()
  doc.setCreator('ConvertAnything')
  const pageSize = String(opts.pageSize ?? 'fit')
  const margin = pageSize === 'fit' ? 0 : Number(opts.margin ?? 24)

  for (let i = 0; i < files.length; i++) {
    checkAbort(ctx)
    ctx.onStatus(files.length > 1 ? `Adding image ${i + 1} of ${files.length}…` : 'Adding image…')
    const img = await embedImage(doc, files[i], opts, ctx)
    if (pageSize === 'fit') {
      const page = doc.addPage([img.width, img.height])
      drawOriented(page, img, 0, 0, img.width, img.height)
    } else {
      let [w, h] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4
      if (img.width > img.height) [w, h] = [h, w] // landscape pages for landscape images
      const page = doc.addPage([w, h])
      const scale = Math.min((w - margin * 2) / img.width, (h - margin * 2) / img.height, 1)
      const dw = img.width * scale
      const dh = img.height * scale
      drawOriented(page, img, (w - dw) / 2, (h - dh) / 2, dw, dh)
    }
    ctx.onProgress((i + 1) / files.length)
  }
  const name = files.length === 1 ? baseName(files[0].name) : `${baseName(files[0].name)}-and-${files.length - 1}-more`
  return [{ name: `${name}.pdf`, blob: pdfBlob(await doc.save({ objectsPerTick: 200 })) }]
}

// ---------- PDF → images / text ----------

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

async function openPdf(file: File) {
  const pdfjs = await loadPdfJs()
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  try {
    const pdf = await task.promise
    return { pdf, close: () => task.destroy() }
  } catch (e) {
    await task.destroy()
    if (e instanceof Error && e.name === 'PasswordException') throw new ConversionError('This PDF is password protected.')
    throw new ConversionError('This PDF could not be opened.')
  }
}

function pageRange(spec: string, count: number): number[] {
  if (spec === 'first') return [1]
  return Array.from({ length: count }, (_, i) => i + 1)
}

export async function pdfToImages(file: File, target: string, opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  ctx.onStatus('Opening PDF…')
  const { pdf, close } = await openPdf(file)
  try {
    const pages = pageRange(String(opts.pages ?? 'all'), pdf.numPages)
    const scale = Number(opts.dpi ?? 150) / 72
    const outputs: OutputFile[] = []
    for (const [i, n] of pages.entries()) {
      checkAbort(ctx)
      ctx.onStatus(`Rendering page ${n} of ${pdf.numPages}…`)
      const page = await pdf.getPage(n)
      let viewport = page.getViewport({ scale })
      // Stay under mobile canvas limits.
      const maxPixels = 16_000_000
      if (viewport.width * viewport.height > maxPixels) {
        viewport = page.getViewport({ scale: scale * Math.sqrt(maxPixels / (viewport.width * viewport.height)) })
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const g = canvas.getContext('2d')!
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: g, viewport }).promise
      const blob = await encodeCanvas(canvas, target, opts, ctx).finally(() => releaseCanvas(canvas))
      const suffix = pages.length > 1 ? `-page-${String(n).padStart(String(pdf.numPages).length, '0')}` : ''
      outputs.push({ name: `${baseName(file.name)}${suffix}.${target}`, blob })
      page.cleanup()
      ctx.onProgress((i + 1) / pages.length)
    }
    return outputs
  } finally {
    await close()
  }
}

export async function pdfToText(file: File, _opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  ctx.onStatus('Opening PDF…')
  const { pdf, close } = await openPdf(file)
  try {
    const chunks: string[] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      checkAbort(ctx)
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      let line = ''
      const lines: string[] = []
      for (const item of content.items) {
        if (!('str' in item)) continue
        line += item.str
        if (item.hasEOL) {
          lines.push(line)
          line = ''
        }
      }
      if (line) lines.push(line)
      chunks.push(lines.join('\n').trim())
      ctx.onProgress(n / pdf.numPages)
    }
    const text = chunks.join('\n\n')
    if (!text.trim()) throw new ConversionError('No text found. This PDF may be a scan (images only).')
    return [{ name: `${baseName(file.name)}.txt`, blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) }]
  } finally {
    await close()
  }
}

// ---------- PDF ↔ PDF ----------

async function loadPdfLib(file: File) {
  try {
    return await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true })
  } catch {
    throw new ConversionError(`"${file.name}" could not be opened as a PDF.`)
  }
}

export async function mergePdfs(files: File[], _opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  const out = await PDFDocument.create()
  out.setCreator('ConvertAnything')
  for (let i = 0; i < files.length; i++) {
    checkAbort(ctx)
    ctx.onStatus(`Merging ${i + 1} of ${files.length}…`)
    let file = files[i]
    if (detectFormat(file)?.id !== 'pdf') {
      // Images can be mixed into a merge.
      const [page] = await imagesToPdf([file], { pageSize: 'a4' }, ctx)
      file = new File([page.blob], page.name, { type: 'application/pdf' })
    }
    const src = await loadPdfLib(file)
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
    ctx.onProgress((i + 1) / files.length)
  }
  return [{ name: `${baseName(files[0].name)}-merged.pdf`, blob: pdfBlob(await out.save()) }]
}

export async function splitPdf(file: File, _opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  const src = await loadPdfLib(file)
  const count = src.getPageCount()
  const outputs: OutputFile[] = []
  for (let i = 0; i < count; i++) {
    checkAbort(ctx)
    const doc = await PDFDocument.create()
    const [page] = await doc.copyPages(src, [i])
    doc.addPage(page)
    outputs.push({ name: `${baseName(file.name)}-page-${String(i + 1).padStart(String(count).length, '0')}.pdf`, blob: pdfBlob(await doc.save()) })
    ctx.onProgress((i + 1) / count)
  }
  return outputs
}
