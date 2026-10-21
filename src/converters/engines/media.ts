import type { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import { getSettings } from '../../lib/settings'
import { baseName, extensionOf, FORMATS } from '../formats'
import { parseProbe, parseTimestamp, planAudio, planGif, planIosMp4, planVideo, type ProbeResult, type VideoPlanOptions } from '../probe'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'

interface Engine {
  ff: FFmpeg
  workerfs: FFFSType
  /** Log lines go to whichever job is using this instance. */
  sink: ((line: string) => void) | null
  idleTimer?: ReturnType<typeof setTimeout>
}

// ---------- Engine pool ----------
// Each ffmpeg.wasm instance is single-threaded and its memory never shrinks, so:
// - up to `mediaConcurrency` instances run side by side,
// - idle instances are shut down after a short while to give memory back,
// - an instance that handled a big file is shut down right away.

const IDLE_MS = 45_000
const BIG_INPUT = 300 * 1024 * 1024

const idle: Engine[] = []
let live = 0
const waiters: ((e: Engine | null) => void)[] = []
let warm: Promise<Engine> | null = null

async function createEngine(): Promise<Engine> {
  const [mod, core, wasm] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/core?url'),
    import('@ffmpeg/core/wasm?url'),
  ])
  const engine: Engine = { ff: new mod.FFmpeg(), workerfs: mod.FFFSType.WORKERFS, sink: null }
  engine.ff.on('log', ({ message }) => engine.sink?.(message))
  await engine.ff.load({ coreURL: core.default, wasmURL: wasm.default })
  return engine
}

function destroy(engine: Engine) {
  clearTimeout(engine.idleTimer)
  try {
    engine.ff.terminate()
  } catch {
    // already gone
  }
  live--
  // A slot opened up: let a waiting job create a fresh instance.
  waiters.shift()?.(null)
}

async function acquire(ctx: ConvertContext): Promise<Engine> {
  const reuse = idle.pop()
  if (reuse) {
    clearTimeout(reuse.idleTimer)
    return reuse
  }
  if (warm) {
    // Still loading from warmUpMedia(): take it over.
    const w = warm
    warm = null
    try {
      return await w
    } catch {
      live--
    }
  }
  if (live >= Math.max(1, getSettings().mediaConcurrency)) {
    ctx.onStatus('Waiting for a free media engine…')
    const handed = await new Promise<Engine | null>((resolve) => waiters.push(resolve))
    if (handed) return handed
    return acquire(ctx)
  }
  live++
  ctx.onStatus('Loading media engine…')
  try {
    return await createEngine()
  } catch (e) {
    live--
    waiters.shift()?.(null)
    throw new ConversionError(`Could not load the media engine: ${e instanceof Error ? e.message : e}`)
  }
}

function release(engine: Engine, { broken = false, heavy = false, idleMs = IDLE_MS } = {}) {
  engine.sink = null
  if (broken || heavy) return destroy(engine)
  const waiter = waiters.shift()
  if (waiter) return waiter(engine)
  engine.idleTimer = setTimeout(() => {
    const i = idle.indexOf(engine)
    if (i >= 0) idle.splice(i, 1)
    destroy(engine)
  }, idleMs)
  idle.push(engine)
}

/** Preloads one engine in the background so the first conversion starts faster. */
export function warmUpMedia() {
  if (warm || live > 0) return
  live++
  const loading = createEngine()
  warm = loading
  loading.then(
    (engine) => {
      // Nobody took it over while loading: park it, with a longer grace period than usual.
      if (warm !== loading) return
      warm = null
      release(engine, { idleMs: 5 * 60_000 })
    },
    () => {
      if (warm !== loading) return
      warm = null
      live--
    },
  )
}

// ---------- Jobs ----------

let jobCounter = 0

interface Job {
  engine: Engine
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

async function prepareInput(engine: Engine, file: File): Promise<Job> {
  const { ff, workerfs } = engine
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
      engine,
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
    return { engine, input: name, cleanup: () => quietly(() => ff.deleteFile(name)) }
  }
}

async function probe(job: Job): Promise<ProbeResult> {
  const lines: string[] = []
  job.engine.sink = (l) => lines.push(l)
  try {
    await job.engine.ff.exec(['-hide_banner', '-i', job.input])
  } catch {
    // ffmpeg exits non-zero without an output file; the log is what we want.
  } finally {
    job.engine.sink = null
  }
  const info = parseProbe(lines.join('\n'))
  if (!info.video && !info.audio) {
    throw new ConversionError("This file doesn't contain audio or video we can read.")
  }
  return info
}

class EngineCrash extends Error {}

async function run(
  job: Job,
  args: string[],
  outExt: string,
  duration: number | undefined,
  ctx: ConvertContext,
  inputArgs: string[] = [],
): Promise<Uint8Array> {
  const { ff } = job.engine
  const out = `output${++jobCounter}.${outExt}`
  const tail: string[] = []
  job.engine.sink = (line) => {
    tail.push(line)
    if (tail.length > 30) tail.shift()
    // e.g. "frame=  120 fps= 48 q=28.0 size=  512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1.92x"
    const t = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line)
    if (t && duration) ctx.onProgress(Math.min(0.99, Math.max(0, (parseTimestamp(t[1]) ?? 0) / duration)))
    const speed = /speed=\s*([\d.]+)x/.exec(line)
    if (speed && ctx.onSpeed) {
      const fps = /fps=\s*([\d.]+)/.exec(line)
      const x = Number(speed[1])
      ctx.onSpeed([fps && Number(fps[1]) > 0 ? `${Math.round(Number(fps[1]))} fps` : '', `${x >= 10 ? Math.round(x) : x.toFixed(1)}× realtime`].filter(Boolean).join(' · '))
    }
  }
  const onAbort = () => ff.terminate()
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const code = await ff.exec(['-hide_banner', '-nostdin', '-y', ...inputArgs, '-i', job.input, ...args, out])
    if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (code !== 0) {
      const reason = tail.filter((l) => /error|invalid|not supported|unknown|could not/i.test(l)).pop()
      throw new ConversionError(reason ? `Conversion failed: ${reason.trim()}` : 'Conversion failed.')
    }
    const data = (await ff.readFile(out)) as Uint8Array
    await quietly(() => ff.deleteFile(out))
    if (!data.length) throw new ConversionError('Conversion produced an empty file.')
    return data
  } catch (e) {
    if (ctx.signal.aborted) throw new EngineCrash('Cancelled')
    if (e instanceof ConversionError) throw e
    // A crashed wasm instance (often out of memory) can't be reused.
    throw new EngineCrash(e instanceof Error ? e.message : String(e))
  } finally {
    job.engine.sink = null
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

/** Runs `fn` with an engine and the input mounted, and always gives the engine back. */
async function withJob<T>(file: File, ctx: ConvertContext, fn: (job: Job) => Promise<T>): Promise<T> {
  const engine = await acquire(ctx)
  let broken = false
  try {
    if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const job = await prepareInput(engine, file)
    try {
      return await fn(job)
    } finally {
      await job.cleanup()
    }
  } catch (e) {
    if (e instanceof EngineCrash) {
      broken = true
      if (ctx.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      throw new ConversionError(/memory|OOM|abort/i.test(e.message) ? 'Ran out of memory. Try a lower resolution or the "Compact" quality.' : `Conversion failed: ${e.message}`)
    }
    throw e
  } finally {
    release(engine, { broken: broken || ctx.signal.aborted, heavy: file.size > BIG_INPUT })
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
  return withJob(file, ctx, async (job) => {
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
        ctx.onStatus(args.includes('copy') && args[args.indexOf('-c:v') + 1] === 'copy' ? 'Copying streams (lossless)…' : 'Converting video…')
        break
      case 'gif':
        if (!info.video) throw new ConversionError('This file has no video track.')
        args = planGif({ fps: Number(opts.fps ?? 12), width: Number(opts.width ?? 480) })
        ctx.onStatus('Making GIF…')
        break
      case 'audio':
        if (!info.audio) throw new ConversionError('This file has no audio track.')
        args = planAudio(target, Number(opts.bitrate ?? 192), { codec: String(opts.codec ?? ''), bits: info.audio.bits })
        ctx.onStatus('Converting audio…')
        break
    }
    // Seeking before the input skips straight to the start point instead of decoding up to it,
    // and is still frame accurate because these outputs are re-encoded.
    const inputArgs = start > 0 ? ['-ss', String(start)] : []
    const trim = length > 0 ? ['-t', String(length)] : []
    const remaining = info.duration !== undefined ? Math.max(0, info.duration - start) : undefined
    const total = length > 0 ? Math.min(length, remaining ?? length) : remaining
    const ext = FORMATS[target].extensions[0]
    const data = await run(job, [...trim, ...args], ext, total, ctx, inputArgs)
    ctx.onProgress(1)
    return [{ name: `${baseName(file.name)}${nameSuffix}.${ext}`, blob: new Blob([data as BlobPart], { type: FORMATS[target].mime }) }]
  })
}

/** Encodes a PNG as WebP with libwebp, for browsers whose canvas can't. */
export function encodeWebp(png: Blob, quality: number, ctx: ConvertContext): Promise<Blob> {
  return withJob(new File([png], 'image.png', { type: 'image/png' }), ctx, async (job) => {
    const lossless = quality >= 100
    const args = ['-c:v', 'libwebp', ...(lossless ? ['-lossless', '1', '-compression_level', '4'] : ['-quality', String(quality)])]
    const data = await run(job, args, 'webp', undefined, ctx)
    return new Blob([data as BlobPart], { type: 'image/webp' })
  })
}
