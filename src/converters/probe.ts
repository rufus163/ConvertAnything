// Parses `ffmpeg -i` output and plans media conversions. Pure functions, unit tested.

export interface ProbeResult {
  duration?: number
  video?: { codec: string; profile?: string; tag?: string; pixFmt?: string; width?: number; height?: number }
  /** `bits` is the sample depth when the source is 24-bit or more (for lossless output). */
  audio?: { codec: string; bits?: number }
}

export function parseTimestamp(ts: string): number | undefined {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ts)
  if (!m) return undefined
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

export function parseProbe(log: string): ProbeResult {
  const result: ProbeResult = {}
  const dur = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(log)
  if (dur) result.duration = parseTimestamp(dur[1])

  for (const line of log.split('\n')) {
    if (!result.video) {
      const v = /Stream #\d+:\d+.*?: Video: (\w+)(?: \(([^)]*)\))?(?: \((\w+) \/ 0x[0-9a-fA-F]+\))?,\s*([\w]+)?/.exec(line)
      // Cover art in audio files shows up as an attached-pic video stream; ignore it.
      if (v && !/attached pic/.test(line)) {
        const size = /,\s*(\d{2,5})x(\d{2,5})/.exec(line)
        result.video = {
          codec: v[1],
          profile: v[2],
          tag: v[3],
          pixFmt: v[4],
          width: size ? Number(size[1]) : undefined,
          height: size ? Number(size[2]) : undefined,
        }
      }
    }
    if (!result.audio) {
      const a = /Stream #\d+:\d+.*?: Audio: (\w+)/.exec(line)
      if (a) {
        const deep = /\((2[4-9]|3\d) bit\)|, s(24|32)p?[,\s]|pcm_s(24|32)/.exec(line)
        result.audio = { codec: a[1], bits: deep ? 24 : undefined }
      }
    }
  }
  return result
}

export interface VideoPlanOptions {
  quality: 'lossless' | 'high' | 'balanced' | 'small'
  /** Max long-edge size in pixels, 0 = keep. */
  maxSize: number
  mute: boolean
  /** Force re-encoding even when streams are already compatible. */
  forceEncode?: boolean
}

// "lossless" here is the visually lossless fallback used when a stream can't simply be copied.
const CRF: Record<VideoPlanOptions['quality'], number> = { lossless: 12, high: 20, balanced: 23, small: 28 }
const PRESET: Record<VideoPlanOptions['quality'], string> = { lossless: 'faster', high: 'faster', balanced: 'veryfast', small: 'veryfast' }
const AUDIO_KBPS: Record<VideoPlanOptions['quality'], number> = { lossless: 256, high: 192, balanced: 160, small: 96 }

/** Codecs each container can hold as-is, so "lossless" can copy instead of re-encoding. */
const COPYABLE: Record<string, { video: string[] | '*'; audio: string[] | '*' }> = {
  mp4: { video: ['h264', 'hevc', 'av1', 'mpeg4'], audio: ['aac', 'mp3', 'alac', 'ac3', 'eac3'] },
  mov: { video: ['h264', 'hevc', 'mpeg4', 'prores', 'mjpeg'], audio: ['aac', 'mp3', 'alac', 'ac3', 'pcm_s16le', 'pcm_s24le', 'pcm_s16be', 'pcm_s24be'] },
  mkv: { video: '*', audio: '*' },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
  avi: { video: ['mpeg4', 'h264', 'mjpeg', 'msmpeg4v3', 'mpeg2video'], audio: ['mp3', 'ac3', 'pcm_s16le'] },
}

export function canCopy(target: string, kind: 'video' | 'audio', codec: string | undefined): boolean {
  const allowed = COPYABLE[target]?.[kind]
  if (!allowed || !codec) return false
  // GIF and raw images aren't real video streams for a container to carry.
  if (kind === 'video' && ['gif', 'png', 'bmp', 'webp'].includes(codec)) return false
  return allowed === '*' || allowed.includes(codec)
}

export function scaleFilter(maxSize: number, probe?: ProbeResult): string {
  const w = probe?.video?.width
  const h = probe?.video?.height
  if (maxSize && w && h && Math.max(w, h) > maxSize) {
    return w >= h ? `scale=${maxSize}:-2` : `scale=-2:${maxSize}`
  }
  if (maxSize && (!w || !h)) {
    return `scale='if(gte(iw,ih),min(${maxSize},iw),-2)':'if(gte(iw,ih),-2,min(${maxSize},ih))'`
  }
  // H.264 with yuv420p requires even dimensions.
  return 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
}

function needsResize(maxSize: number, probe: ProbeResult) {
  const w = probe.video?.width ?? 0
  const h = probe.video?.height ?? 0
  return maxSize > 0 && Math.max(w, h) > maxSize
}

/** Can this video stream be copied as-is into an MP4 that iPhone/iPad/Safari will play? */
export function iosCompatibleVideo(probe: ProbeResult): 'copy-h264' | 'copy-hevc' | false {
  const v = probe.video
  if (!v) return false
  const pix = v.pixFmt ?? ''
  if (v.codec === 'h264') {
    const profile = (v.profile ?? '').toLowerCase()
    const badProfile = /4:4:4|4:2:2|high 10/.test(profile)
    return !badProfile && /^yuvj?420p$/.test(pix) ? 'copy-h264' : false
  }
  if (v.codec === 'hevc') {
    return /^yuv420p(10le)?$/.test(pix) ? 'copy-hevc' : false
  }
  return false
}

export function x264Args(o: VideoPlanOptions, probe?: ProbeResult): string[] {
  return [
    '-c:v', 'libx264',
    '-preset', PRESET[o.quality],
    '-crf', String(CRF[o.quality]),
    '-profile:v', 'high',
    '-level:v', '4.1',
    '-pix_fmt', 'yuv420p',
    '-vf', scaleFilter(o.maxSize, probe),
    '-tag:v', 'avc1',
  ]
}

/**
 * Plans an "iPhone compatible MP4": copies streams when they already play on
 * iOS (fast, lossless) and re-encodes only what's needed.
 */
export function planIosMp4(probe: ProbeResult, o: VideoPlanOptions): { args: string[]; reencodeVideo: boolean } {
  const args: string[] = ['-map', '0:v:0?']
  if (!o.mute) args.push('-map', '0:a:0?')

  const compat = o.forceEncode || needsResize(o.maxSize, probe) ? false : iosCompatibleVideo(probe)
  if (compat === 'copy-h264') args.push('-c:v', 'copy', '-tag:v', 'avc1')
  else if (compat === 'copy-hevc') args.push('-c:v', 'copy', '-tag:v', 'hvc1')
  else args.push(...x264Args(o, probe))

  if (o.mute || !probe.audio) args.push('-an')
  else if (probe.audio.codec === 'aac' && !o.forceEncode) args.push('-c:a', 'copy')
  else args.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS[o.quality]}k`, '-ac', '2')

  args.push('-movflags', '+faststart', '-map_metadata', '0')
  return { args, reencodeVideo: !compat }
}

/** Arguments for converting video to a given container. */
export function planVideo(target: string, probe: ProbeResult, o: VideoPlanOptions): string[] {
  if (o.quality === 'lossless') return planLosslessVideo(target, probe, o)
  const noAudio = ['-an']
  const maps = ['-map', '0:v:0?', ...(o.mute ? [] : ['-map', '0:a:0?'])]
  const aac = ['-c:a', 'aac', '-b:a', `${AUDIO_KBPS[o.quality]}k`, '-ac', '2']
  switch (target) {
    case 'mp4':
    case 'mov':
      return [...maps, ...x264Args(o, probe), ...(o.mute ? noAudio : aac), '-movflags', '+faststart']
    case 'mkv':
      return [...maps, ...x264Args(o, probe), ...(o.mute ? noAudio : aac)]
    case 'webm':
      return [
        ...maps,
        '-c:v', 'libvpx',
        '-b:v', o.quality === 'high' ? '4M' : o.quality === 'balanced' ? '2M' : '900k',
        '-crf', String(CRF[o.quality] - 13),
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-vf', scaleFilter(o.maxSize, probe),
        ...(o.mute ? noAudio : ['-c:a', 'libopus', '-b:a', `${Math.min(AUDIO_KBPS[o.quality], 128)}k`]),
      ]
    case 'avi':
      return [
        ...maps,
        '-c:v', 'mpeg4',
        '-q:v', o.quality === 'high' ? '3' : o.quality === 'balanced' ? '5' : '8',
        '-vf', scaleFilter(o.maxSize, probe),
        ...(o.mute ? noAudio : ['-c:a', 'libmp3lame', '-b:a', `${AUDIO_KBPS[o.quality]}k`]),
      ]
    default:
      throw new Error(`Unsupported video target ${target}`)
  }
}

/**
 * Lossless: copy each stream untouched when the target container can hold it
 * (instant, bit-perfect); otherwise use the best lossless or near-lossless codec.
 */
function planLosslessVideo(target: string, probe: ProbeResult, o: VideoPlanOptions): string[] {
  const args = ['-map', '0:v:0?', ...(o.mute ? [] : ['-map', '0:a:0?'])]
  const v = probe.video?.codec
  if (canCopy(target, 'video', v) && !needsResize(o.maxSize, probe)) {
    args.push('-c:v', 'copy')
    if (v === 'hevc' && (target === 'mp4' || target === 'mov')) args.push('-tag:v', 'hvc1')
  } else {
    switch (target) {
      case 'mkv':
        // Mathematically lossless H.264.
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-vf', scaleFilter(o.maxSize, probe))
        break
      case 'webm':
        args.push('-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-vf', scaleFilter(o.maxSize, probe))
        break
      case 'avi':
        args.push('-c:v', 'mpeg4', '-q:v', '1', '-vf', scaleFilter(o.maxSize, probe))
        break
      default:
        // MP4/MOV: visually lossless but still playable everywhere (true lossless H.264 isn't).
        args.push(...x264Args(o, probe))
    }
  }

  const a = probe.audio
  if (o.mute || !a) args.push('-an')
  else if (canCopy(target, 'audio', a.codec)) args.push('-c:a', 'copy')
  else if (target === 'mkv') args.push('-c:a', 'flac')
  else if (target === 'mp4' || target === 'mov') args.push('-c:a', 'alac')
  else if (target === 'avi') args.push('-c:a', a.bits ? 'pcm_s24le' : 'pcm_s16le')
  else args.push('-c:a', 'libopus', '-b:a', '256k')

  if (target === 'mp4' || target === 'mov') args.push('-movflags', '+faststart')
  return args
}

export function planGif(o: { fps: number; width: number }): string[] {
  const scale = o.width > 0 ? `scale='min(${o.width},iw)':-1:flags=lanczos,` : ''
  return [
    '-vf',
    `fps=${o.fps},${scale}split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0',
  ]
}

export function planAudio(target: string, bitrate: number, opts: { codec?: string; bits?: number } = {}): string[] {
  const vn = ['-vn', '-map', '0:a:0']
  // Keep 24-bit sources 24-bit in lossless PCM output.
  const deep = (opts.bits ?? 16) >= 24
  switch (target) {
    case 'mp3':
      return [...vn, '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`]
    case 'm4a':
      if (opts.codec === 'alac') return [...vn, '-c:a', 'alac', '-movflags', '+faststart']
      return [...vn, '-c:a', 'aac', '-b:a', `${bitrate}k`, '-movflags', '+faststart']
    case 'm4r':
      return [...vn, '-c:a', 'aac', '-b:a', `${bitrate}k`, '-f', 'ipod']
    case 'wav':
      return [...vn, '-c:a', deep ? 'pcm_s24le' : 'pcm_s16le']
    case 'aiff':
      return [...vn, '-c:a', deep ? 'pcm_s24be' : 'pcm_s16be', '-f', 'aiff']
    case 'flac':
      return [...vn, '-c:a', 'flac']
    case 'ogg':
      return [...vn, '-c:a', 'libvorbis', '-q:a', String(Math.max(1, Math.min(10, Math.round(bitrate / 32))))]
    case 'opus':
      return [...vn, '-c:a', 'libopus', '-b:a', `${Math.min(bitrate, 256)}k`]
    default:
      throw new Error(`Unsupported audio target ${target}`)
  }
}
