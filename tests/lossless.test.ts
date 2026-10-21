import { describe, expect, it } from 'vitest'
import { jpegOrientation } from '../src/converters/encoders'
import { canCopy, parseProbe, planAudio, planIosMp4, planVideo } from '../src/converters/probe'
import { applyPreset, CONVERTERS_BY_ID, defaultOptions, hasPresets } from '../src/converters/registry'
import { formatDuration } from '../src/lib/format'

const H264_AAC = `
  Duration: 00:00:10.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s
`
const VP9_OPUS = `
  Duration: 00:00:10.00, start: 0.000000, bitrate: 300 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 1280x720, 30 fps
  Stream #0:1: Audio: opus, 48000 Hz, stereo, fltp (default)
`
const FLAC_24 = `
  Duration: 00:03:00.00, start: 0.000000, bitrate: 2400 kb/s
  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)
`

const lossless = { quality: 'lossless' as const, maxSize: 0, mute: false }

describe('lossless video', () => {
  it('copies streams the target container can hold', () => {
    const args = planVideo('mkv', parseProbe(VP9_OPUS), lossless).join(' ')
    expect(args).toContain('-c:v copy')
    expect(args).toContain('-c:a copy')
    expect(planVideo('mov', parseProbe(H264_AAC), lossless).join(' ')).toContain('-c:v copy')
    expect(planVideo('webm', parseProbe(VP9_OPUS), lossless).join(' ')).toContain('-c:v copy')
  })

  it('uses lossless codecs when copying is impossible', () => {
    const mkv = planVideo('mkv', parseProbe(H264_AAC), { ...lossless, maxSize: 1280 }).join(' ')
    expect(mkv).toContain('-qp 0')
    const webm = planVideo('webm', parseProbe(H264_AAC), lossless).join(' ')
    expect(webm).toContain('libvpx-vp9 -lossless 1')
    // Opus can't go in MP4 as-is, so audio becomes Apple Lossless.
    expect(planVideo('mp4', parseProbe(VP9_OPUS), lossless).join(' ')).toContain('-c:a alac')
  })

  it('keeps iPhone MP4 playable even at lossless quality', () => {
    const plan = planIosMp4(parseProbe(VP9_OPUS), lossless)
    expect(plan.args.join(' ')).toContain('-crf 12')
    expect(plan.args.join(' ')).toContain('-profile:v high')
  })

  it('knows which codecs fit which container', () => {
    expect(canCopy('mp4', 'video', 'hevc')).toBe(true)
    expect(canCopy('mp4', 'audio', 'opus')).toBe(false)
    expect(canCopy('webm', 'video', 'h264')).toBe(false)
    expect(canCopy('mkv', 'video', 'gif')).toBe(false)
  })
})

describe('lossless audio', () => {
  it('detects 24-bit sources and keeps them 24-bit', () => {
    const info = parseProbe(FLAC_24)
    expect(info.audio).toEqual({ codec: 'flac', bits: 24 })
    expect(planAudio('wav', 192, { bits: info.audio?.bits })).toContain('pcm_s24le')
    expect(planAudio('aiff', 192, { bits: info.audio?.bits })).toContain('pcm_s24be')
    expect(planAudio('wav', 192)).toContain('pcm_s16le')
  })

  it('encodes M4A as Apple Lossless when asked', () => {
    expect(planAudio('m4a', 192, { codec: 'alac' })).toContain('alac')
    expect(planAudio('m4a', 192, { codec: 'aac' })).toContain('aac')
  })
})

describe('quality presets', () => {
  it('sets per-preset defaults and keeps unrelated choices', () => {
    const jpg = CONVERTERS_BY_ID.get('image-jpg')!
    expect(hasPresets(jpg)).toBe(true)
    expect(defaultOptions(jpg, 'lossless').quality).toBe(100)
    expect(defaultOptions(jpg, 'compact').quality).toBe(75)
    const custom = { ...defaultOptions(jpg), resize: '1280', quality: 40 }
    expect(applyPreset(jpg, custom, 'lossless')).toMatchObject({ resize: '1280', quality: 100 })

    const m4a = CONVERTERS_BY_ID.get('audio-m4a')!
    expect(defaultOptions(m4a, 'lossless').codec).toBe('alac')
    expect(defaultOptions(m4a).codec).toBe('aac')
    expect(hasPresets(CONVERTERS_BY_ID.get('data-json')!)).toBe(false)
  })

  it('every preset value is a valid choice', () => {
    for (const c of CONVERTERS_BY_ID.values()) {
      for (const o of c.options ?? []) {
        if (o.type !== 'select' || !o.presets) continue
        for (const v of Object.values(o.presets)) expect(o.choices.map((x) => x.value), `${c.id}.${o.key}`).toContain(v)
      }
    }
  })
})

describe('helpers', () => {
  it('reads JPEG EXIF orientation', () => {
    const exif = (orientation: number, little: boolean) => {
      const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255])
      const u32 = (v: number) => (little ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255])
      const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)]
      const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
      return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload, 0xff, 0xda, 0, 2])
    }
    expect(jpegOrientation(exif(6, false))).toBe(6)
    expect(jpegOrientation(exif(8, true))).toBe(8)
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1)
    expect(jpegOrientation(new Uint8Array([1, 2, 3]))).toBe(1)
  })

  it('formats durations', () => {
    expect(formatDuration(0.42)).toBe('0.4s')
    expect(formatDuration(3.25)).toBe('3.3s')
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(125)).toBe('2m 05s')
    expect(formatDuration(3720)).toBe('1h 02m')
  })
})
