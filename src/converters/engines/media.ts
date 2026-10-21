import type { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import { baseName, extensionOf, FORMATS } from '../formats'
import { parseProbe, parseTimestamp, planAudio, planGif, planIosMp4, planVideo, type ProbeResult, type VideoPlanOptions } from '../probe'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'

interface Engine {
  ff: FFmpeg
  workerfs: FFFSType
}

let instance: Promise<Engine> | null = null
let logSink: ((line: string) => void) | null = null

async function loadFFmpeg(): Promise<Engine> {
  const [mod, core, wasm] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/core?url'),
    import('@ffmpeg/core/wasm?url'),
  ])
  const ff = new mod.FFmpeg()
  ff.on('log', ({ message }) => logSink?.(message))
  await ff.load({ coreURL: core.default, wasmURL: wasm.default })
  return { ff, workerfs: mod.FFFSType.WORKERFS }
}

function getFFmpeg(ctx: ConvertContext): Promise<Engine> {
  if (!instance) {
    ctx.onStatus('Loading media engine (first time only)…')
    instance = loadFFmpeg().catch((e) => {
      instance = null
      throw new ConversionError(`Could not load the media engine: ${e instanceof Error ? e.message : e}`)
    })
  }
  return instance
}

/** Preloads the engine in the background so the first conversion starts faster. */
export function warmUpMedia() {
  if (!instance) instance = loadFFmpeg().catch(() => (instance = null) as never)
}

function terminate() {
  instance?.then(({ ff }) => ff.terminate()).catch(() => {})
  instance = null
}

// Only one ffmpeg job runs at a time; this serialises callers.
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

let jobCounter = 0

interface Job {
  ff: FFmpeg
  input: string
  cleanup: () => Promise<void>
}

/** Swallows errors, including synchronous throws from a terminated instance. */
async function quietly(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch {
    // ignore
  }
}

async function prepareInput({ ff, workerfs }: Engine, file: File): Promise<Job> {
  const id = ++jobCounter
  const ext = extensionOf(file.name) || 'bin'
  // Mounting with WORKERFS streams the file from disk instead of copying it into memory,
  // which is what makes multi-GB videos workable on phones.
  const dir = `/in${id}`
  try {
    await ff.createDir(dir)
    const safe = new File([file], `input.${ext}`, { type: file.type })
    await ff.mount(workerfs, { files: [safe] }, dir)
    return {
      ff,
      input: `${dir}/input.${ext}`,
      cleanup: async () => {
        await quietly(() => ff.unmount(dir))
        await quietly(() => ff.deleteDir(dir))
      },
    }
  } catch {
    await quietly(() => ff.deleteDir(dir))
    const name = `input${id}.${ext}`
    await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()))
    return { ff, input: name, cleanup: () => quietly(() => ff.deleteFile(name)) }
  }
}

async function probe(job: Job): Promise<ProbeResult> {
  const lines: string[] = []
  logSink = (l) => lines.push(l)
  try {
    await job.ff.exec(['-hide_banner', '-i', job.input])
  } catch {
    // ffmpeg exits non-zero without an output file; the log is what we want.
  } finally {
    logSink = null
  }
  const info = parseProbe(lines.join('\n'))
  if (!info.video && !info.audio) {
    throw new ConversionError("This file doesn't contain audio or video we can read.")
  }
  return info
}

async function run(job: Job, args: string[], outExt: string, duration: number | undefined, ctx: ConvertContext): Promise<Uint8Array> {
  const out = `output${jobCounter}.${outExt}`
  const tail: string[] = []
  logSink = (line) => {
    tail.push(line)
    if (tail.length > 30) tail.shift()
    const m = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line)
    if (m && duration) {
      const t = parseTimestamp(m[1]) ?? 0
      ctx.onProgress(Math.min(0.99, Math.max(0, t / duration)))
    }
  }
  const onAbort = () => terminate()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const code = await job.ff.exec(['-hide_banner', '-nostdin', '-y', '-i', job.input, ...args, out])
    if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (code !== 0) {
      const reason = tail.filter((l) => /error|invalid|not supported|unknown|could not/i.test(l)).pop()
      throw new ConversionError(reason ? `Conversion failed: ${reason.trim()}` : 'Conversion failed.')
    }
    const data = (await job.ff.readFile(out)) as Uint8Array
    await quietly(() => job.ff.deleteFile(out))
    if (!data.length) throw new ConversionError('Conversion produced an empty file.')
    return data
  } catch (e) {
    if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    // A crashed wasm instance can't be reused.
    if (!(e instanceof ConversionError)) terminate()
    throw e instanceof ConversionError ? e : new ConversionError(`Conversion failed: ${e instanceof Error ? e.message : e}`)
  } finally {
    logSink = null
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

function videoOptions(opts: Options): VideoPlanOptions {
  return {
    quality: (opts.quality as VideoPlanOptions['quality']) ?? 'balanced',
    maxSize: Number(opts.maxSize ?? 0),
    mute: Boolean(opts.mute),
    forceEncode: Boolean(opts.forceEncode),
  }
}

export type MediaMode = 'ios-mp4' | 'video' | 'gif' | 'audio'

export function convertMedia(file: File, target: string, mode: MediaMode, opts: Options, ctx: ConvertContext, nameSuffix = ''): Promise<OutputFile[]> {
  return exclusive(async () => {
    const engine = await getFFmpeg(ctx)
    if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const job = await prepareInput(engine, file)
    try {
      ctx.onStatus('Analyzing…')
      const info = await probe(job)
      const start = Number(opts.start ?? 0)
      let length = Number(opts.duration ?? 0)
      if (mode === 'audio' && target === 'm4r' && !length) length = 30 // iOS ringtones max out at 40 s
      let args: string[]
      switch (mode) {
        case 'ios-mp4': {
          const plan = planIosMp4(info, videoOptions(opts))
          args = plan.args
          ctx.onStatus(plan.reencodeVideo ? 'Re-encoding for iPhone…' : 'Repackaging for iPhone (fast, no quality loss)…')
          break
        }
        case 'video':
          if (!info.video) throw new ConversionError('This file has no video track.')
          args = planVideo(target, info, videoOptions(opts))
          ctx.onStatus('Converting video…')
          break
        case 'gif':
          if (!info.video) throw new ConversionError('This file has no video track.')
          args = planGif({ fps: Number(opts.fps ?? 12), width: Number(opts.width ?? 480) })
          ctx.onStatus('Making GIF…')
          break
        case 'audio':
          if (!info.audio) throw new ConversionError('This file has no audio track.')
          args = planAudio(target, Number(opts.bitrate ?? 192))
          ctx.onStatus('Converting audio…')
          break
      }
      // Output-side `-ss`/`-t` are frame accurate, which matters for the short clips trimming is used for.
      const trim = [...(start > 0 ? ['-ss', String(start)] : []), ...(length > 0 ? ['-t', String(length)] : [])]
      const remaining = info.duration !== undefined ? Math.max(0, info.duration - start) : undefined
      const total = length > 0 ? Math.min(length, remaining ?? length) : remaining
      const data = await run(job, [...trim, ...args], FORMATS[target].extensions[0], total, ctx)
      ctx.onProgress(1)
      return [{ name: `${baseName(file.name)}${nameSuffix}.${FORMATS[target].extensions[0]}`, blob: new Blob([data as BlobPart], { type: FORMATS[target].mime }) }]
    } finally {
      await job.cleanup()
    }
  })
}

/** Encodes a PNG as WebP with libwebp, for browsers whose canvas can't. */
export function encodeWebp(png: Blob, quality: number, ctx: ConvertContext): Promise<Blob> {
  return exclusive(async () => {
    const engine = await getFFmpeg(ctx)
    const job = await prepareInput(engine, new File([png], 'image.png', { type: 'image/png' }))
    try {
      const data = await run(job, ['-c:v', 'libwebp', '-quality', String(quality), '-lossless', quality >= 100 ? '1' : '0'], 'webp', undefined, ctx)
      return new Blob([data as BlobPart], { type: 'image/webp' })
    } finally {
      await job.cleanup()
    }
  })
}
