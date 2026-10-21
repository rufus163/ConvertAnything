import { baseName, detectFormat, FORMATS } from '../formats'
import { encodeBmp, encodeIco, resizeDimensions } from '../encoders'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'

// iOS Safari refuses to allocate canvases larger than ~16.7 megapixels.
const MAX_CANVAS_PIXELS = 16_000_000

export interface Decoded {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new ConversionError('Could not create a drawing surface on this device.')
  return ctx
}

function clampToCanvasLimit({ width, height }: { width: number; height: number }) {
  const pixels = width * height
  if (pixels <= MAX_CANVAS_PIXELS) return { width, height }
  const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixels)
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) }
}

async function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } finally {
    // Revoke after the next frame; the decoded bitmap stays in memory.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

async function drawable(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob)
      return { source: bmp, width: bmp.width, height: bmp.height }
    } catch {
      // fall back to <img>, which handles more formats on some browsers (e.g. ICO, SVG)
    }
  }
  const img = await loadImageElement(blob)
  return { source: img, width: img.naturalWidth, height: img.naturalHeight }
}

async function decodeTiff(file: Blob): Promise<Decoded> {
  const UTIF = await import('utif2')
  const buf = await file.arrayBuffer()
  const ifds = UTIF.decode(buf)
  if (!ifds.length) throw new ConversionError('This TIFF file has no images.')
  UTIF.decodeImage(buf, ifds[0])
  const rgba = UTIF.toRGBA8(ifds[0])
  const { width, height } = ifds[0]
  const canvas = makeCanvas(width, height)
  context2d(canvas).putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
  return { canvas, width, height }
}

async function decodeHeic(file: Blob, ctx: ConvertContext): Promise<Blob> {
  // Safari (macOS/iOS 17+) decodes HEIC natively, which is much faster.
  try {
    await drawable(file)
    return file
  } catch {
    ctx.onStatus('Decoding HEIC…')
    const heic2any = (await import('heic2any')).default
    const out = await heic2any({ blob: file, toType: 'image/png' })
    return Array.isArray(out) ? out[0] : out
  }
}

async function svgSize(file: Blob): Promise<{ width: number; height: number } | undefined> {
  const text = await file.text()
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = doc.documentElement
  const w = parseFloat(svg.getAttribute('width') ?? '')
  const h = parseFloat(svg.getAttribute('height') ?? '')
  if (w > 0 && h > 0 && !String(svg.getAttribute('width')).endsWith('%')) return { width: w, height: h }
  const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] }
  return undefined
}

/** Decodes any supported image into a canvas, honouring the `resize` option. */
export async function decodeImage(file: File, opts: Options, ctx: ConvertContext): Promise<Decoded> {
  const fmt = detectFormat(file)?.id
  const resize = String(opts.resize ?? 'original')

  let decoded: Decoded
  if (fmt === 'tiff') {
    decoded = await decodeTiff(file)
  } else {
    let blob: Blob = file
    let intrinsic: { width: number; height: number } | undefined
    if (fmt === 'heic') blob = await decodeHeic(file, ctx)
    if (fmt === 'svg') {
      intrinsic = await svgSize(file)
      blob = new Blob([await file.text()], { type: 'image/svg+xml' })
    }
    let src: Awaited<ReturnType<typeof drawable>>
    try {
      src = await drawable(blob)
    } catch {
      throw new ConversionError(`This device can't read ${FORMATS[fmt ?? '']?.label ?? 'this'} images.`)
    }
    let width = intrinsic?.width ?? src.width
    let height = intrinsic?.height ?? src.height
    if (!width || !height) {
      width = 1024
      height = 1024
    }
    // Vectors are rasterised at a scale factor rather than at their (often tiny) intrinsic size.
    if (fmt === 'svg') {
      const scale = Number(opts.svgScale ?? 2)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }
    const target = clampToCanvasLimit(resizeDimensions(width, height, resize))
    const canvas = makeCanvas(target.width, target.height)
    const g = context2d(canvas)
    g.imageSmoothingQuality = 'high'
    g.drawImage(src.source, 0, 0, target.width, target.height)
    if ('close' in src.source && typeof src.source.close === 'function') src.source.close()
    return { canvas, width: target.width, height: target.height }
  }

  const target = clampToCanvasLimit(resizeDimensions(decoded.width, decoded.height, resize))
  if (target.width === decoded.width && target.height === decoded.height) return decoded
  const canvas = makeCanvas(target.width, target.height)
  const g = context2d(canvas)
  g.imageSmoothingQuality = 'high'
  g.drawImage(decoded.canvas, 0, 0, target.width, target.height)
  return { canvas, width: target.width, height: target.height }
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new ConversionError('Could not encode the image.'))
        else if (blob.type !== mime) reject(new ConversionError(`This browser can't create ${mime.split('/')[1].toUpperCase()} images. Try PNG or JPG.`))
        else resolve(blob)
      },
      mime,
      quality,
    )
  })
}

function flatten(canvas: HTMLCanvasElement, background: string): HTMLCanvasElement {
  const out = makeCanvas(canvas.width, canvas.height)
  const g = context2d(out)
  g.fillStyle = background
  g.fillRect(0, 0, out.width, out.height)
  g.drawImage(canvas, 0, 0)
  return out
}

function rgbaOf(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return context2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data
}

async function encodeGif(canvas: HTMLCanvasElement): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const rgba = rgbaOf(canvas)
  const palette = quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true })
  const index = applyPalette(rgba, palette, 'rgba4444')
  const gif = GIFEncoder()
  gif.writeFrame(index, canvas.width, canvas.height, { palette, transparent: true })
  gif.finish()
  return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' })
}

async function encodeIcoFile(canvas: HTMLCanvasElement, sizesOpt: string): Promise<Blob> {
  const sizes = sizesOpt === 'full' ? [16, 24, 32, 48, 64, 128, 256] : sizesOpt === 'app' ? [256] : [16, 32, 48]
  const images = []
  for (const size of sizes) {
    // Fit inside a square, centred, keeping aspect ratio.
    const c = makeCanvas(size, size)
    const g = context2d(c)
    g.imageSmoothingQuality = 'high'
    const scale = Math.min(size / canvas.width, size / canvas.height)
    const w = Math.round(canvas.width * scale)
    const h = Math.round(canvas.height * scale)
    g.drawImage(canvas, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h)
    const png = new Uint8Array(await (await canvasToBlob(c, 'image/png')).arrayBuffer())
    images.push({ size, png })
  }
  return new Blob([encodeIco(images) as BlobPart], { type: 'image/x-icon' })
}

const TRACE_PRESETS: Record<string, Record<string, unknown>> = {
  logo: { numberofcolors: 8, pathomit: 8, ltres: 1, qtres: 1, colorquantcycles: 3, roundcoords: 1, strokewidth: 0 },
  illustration: { numberofcolors: 24, pathomit: 4, ltres: 0.5, qtres: 0.5, roundcoords: 1, strokewidth: 0 },
  photo: { numberofcolors: 64, pathomit: 0, ltres: 0.5, qtres: 0.5, roundcoords: 2, blurradius: 1, strokewidth: 0 },
  bw: { numberofcolors: 2, colorsampling: 0, pathomit: 8, strokewidth: 0 },
}

async function traceToSvg(canvas: HTMLCanvasElement, preset: string, ctx: ConvertContext): Promise<string> {
  ctx.onStatus('Tracing shapes…')
  const data = rgbaOf(canvas)
  const worker = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'))
      ctx.signal.addEventListener('abort', abort, { once: true })
      worker.onmessage = (e: MessageEvent<{ svg?: string; error?: string }>) => {
        if (e.data.error) reject(new ConversionError(e.data.error))
        else resolve(e.data.svg!)
      }
      worker.onerror = (e) => reject(new ConversionError(e.message || 'Tracing failed'))
      worker.postMessage(
        { width: canvas.width, height: canvas.height, data, options: { ...(TRACE_PRESETS[preset] ?? TRACE_PRESETS.logo), viewbox: true } },
        [data.buffer],
      )
    })
  } finally {
    worker.terminate()
  }
}

async function embedSvg(canvas: HTMLCanvasElement): Promise<string> {
  const png = await canvasToBlob(canvas, 'image/png')
  const b64 = await new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsDataURL(png)
  })
  const { width: w, height: h } = canvas
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" xlink:href="${b64}" href="${b64}"/></svg>`
}

export async function encodeCanvas(canvas: HTMLCanvasElement, target: string, opts: Options, ctx: ConvertContext): Promise<Blob> {
  const quality = Number(opts.quality ?? 90) / 100
  switch (target) {
    case 'png':
      return canvasToBlob(canvas, 'image/png')
    case 'jpg':
      return canvasToBlob(flatten(canvas, String(opts.background ?? '#ffffff')), 'image/jpeg', quality)
    case 'webp':
      try {
        return await canvasToBlob(canvas, 'image/webp', quality)
      } catch {
        // Safari can't encode WebP from a canvas; use the bundled libwebp instead.
        const png = await canvasToBlob(canvas, 'image/png')
        return (await import('./media')).encodeWebp(png, Math.round(quality * 100), ctx)
      }
    case 'avif':
      return canvasToBlob(canvas, 'image/avif', quality)
    case 'bmp':
      return new Blob([encodeBmp(rgbaOf(canvas), canvas.width, canvas.height) as BlobPart], { type: 'image/bmp' })
    case 'gif':
      return encodeGif(canvas)
    case 'ico':
      return encodeIcoFile(canvas, String(opts.icoSizes ?? 'favicon'))
    case 'tiff': {
      const UTIF = await import('utif2')
      const tiff = UTIF.encodeImage(new Uint8Array(rgbaOf(canvas).buffer), canvas.width, canvas.height)
      return new Blob([tiff], { type: 'image/tiff' })
    }
    case 'svg': {
      const svg = opts.svgMode === 'embed' ? await embedSvg(canvas) : await traceToSvg(canvas, String(opts.trace ?? 'logo'), ctx)
      return new Blob([svg], { type: 'image/svg+xml' })
    }
    default:
      throw new ConversionError(`Unsupported image target: ${target}`)
  }
}

export async function convertImage(file: File, target: string, opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  ctx.onStatus('Reading image…')
  ctx.onProgress(0.1)
  // Tracing very large images is slow and produces huge SVGs, so cap the working size.
  const effective = target === 'svg' && opts.svgMode !== 'embed' && (!opts.resize || opts.resize === 'original') ? { ...opts, resize: '1600' } : opts
  const { canvas } = await decodeImage(file, effective, ctx)
  ctx.onProgress(0.5)
  ctx.onStatus('Encoding…')
  const blob = await encodeCanvas(canvas, target, opts, ctx)
  ctx.onProgress(1)
  return [{ name: `${baseName(file.name)}.${FORMATS[target].extensions[0]}`, blob }]
}
