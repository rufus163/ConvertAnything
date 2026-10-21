import { PDFDocument } from 'pdf-lib'
import { baseName, detectFormat } from '../formats'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'
import { canvasToBlob, decodeImage, encodeCanvas } from './image'
import { PAGE_SIZES } from './pdfWriter'

const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'application/pdf' })

function checkAbort(ctx: ConvertContext) {
  if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
}

// ---------- Images → PDF ----------

async function embedImage(doc: PDFDocument, file: File, opts: Options, ctx: ConvertContext) {
  const fmt = detectFormat(file)?.id
  if (fmt === 'png') {
    return doc.embedPng(new Uint8Array(await file.arrayBuffer()))
  }
  // Everything else goes through a canvas so EXIF rotation and exotic formats are handled.
  const { canvas } = await decodeImage(file, opts, ctx)
  if (fmt === 'jpg' || fmt === 'heic') {
    const jpg = await canvasToBlob(canvas, 'image/jpeg', Number(opts.quality ?? 90) / 100)
    return doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()))
  }
  const png = await canvasToBlob(canvas, 'image/png')
  return doc.embedPng(new Uint8Array(await png.arrayBuffer()))
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
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height })
    } else {
      let [w, h] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4
      if (img.width > img.height) [w, h] = [h, w] // landscape pages for landscape images
      const page = doc.addPage([w, h])
      const scale = Math.min((w - margin * 2) / img.width, (h - margin * 2) / img.height, 1)
      const dw = img.width * scale
      const dh = img.height * scale
      page.drawImage(img, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh })
    }
    ctx.onProgress((i + 1) / files.length)
  }
  const name = files.length === 1 ? baseName(files[0].name) : `${baseName(files[0].name)}-and-${files.length - 1}-more`
  return [{ name: `${name}.pdf`, blob: pdfBlob(await doc.save()) }]
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
      const blob = await encodeCanvas(canvas, target, opts, ctx)
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
