import { describe, expect, it } from 'vitest'
import { iosCompatibleVideo, parseProbe, planAudio, planIosMp4, planVideo, scaleFilter } from '../src/converters/probe'

const IPHONE_HEVC = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0001.MOV':
  Duration: 00:00:12.34, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 8000 kb/s, 30 fps (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 160 kb/s (default)
`

const MKV_HEV1 = `
  Duration: 00:01:00.00, start: 0.000000, bitrate: 2000 kb/s
  Stream #0:0: Video: hevc (Main) (hev1 / 0x31766568), yuv420p(tv), 3840x2160, SAR 1:1 DAR 16:9, 25 fps
  Stream #0:1(eng): Audio: opus, 48000 Hz, stereo, fltp (default)
  Stream #0:2(eng): Subtitle: subrip
`

const WEBM_VP9 = `
  Duration: 00:00:02.00, start: 0.000000, bitrate: 300 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 15 fps
  Stream #0:1: Audio: opus, 48000 Hz, mono, fltp (default)
`

const H264_444 = `
  Duration: 00:00:05.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(progressive), 1280x720, 30 fps
`

const MP3_WITH_ART = `
  Duration: 00:03:30.00, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600, 90k tbr, 90k tbn (attached pic)
`

const opts = { quality: 'balanced' as const, maxSize: 0, mute: false }

describe('parseProbe', () => {
  it('reads duration, codecs, tag, pixel format and size', () => {
    const p = parseProbe(IPHONE_HEVC)
    expect(p.duration).toBeCloseTo(12.34)
    expect(p.video).toMatchObject({ codec: 'hevc', profile: 'Main 10', tag: 'hvc1', pixFmt: 'yuv420p10le', width: 1920, height: 1080 })
    expect(p.audio).toEqual({ codec: 'aac' })
  })

  it('ignores cover art in audio files', () => {
    const p = parseProbe(MP3_WITH_ART)
    expect(p.video).toBeUndefined()
    expect(p.audio?.codec).toBe('mp3')
  })
})

describe('iPhone MP4 planning', () => {
  it('copies iPhone HEVC and AAC without re-encoding', () => {
    const plan = planIosMp4(parseProbe(IPHONE_HEVC), opts)
    expect(plan.reencodeVideo).toBe(false)
    expect(plan.args.join(' ')).toContain('-c:v copy -tag:v hvc1')
    expect(plan.args.join(' ')).toContain('-c:a copy')
    expect(plan.args).toContain('+faststart')
  })

  it('retags hev1 HEVC as hvc1 (the usual reason MKV/MP4 HEVC fails on iOS) and re-encodes opus audio', () => {
    const plan = planIosMp4(parseProbe(MKV_HEV1), opts)
    expect(plan.reencodeVideo).toBe(false)
    expect(plan.args.join(' ')).toContain('-tag:v hvc1')
    expect(plan.args.join(' ')).toContain('-c:a aac')
    // Subtitles are not mapped into the MP4.
    expect(plan.args).not.toContain('0:s')
  })

  it('re-encodes VP9 to H.264', () => {
    const plan = planIosMp4(parseProbe(WEBM_VP9), opts)
    expect(plan.reencodeVideo).toBe(true)
    expect(plan.args.join(' ')).toContain('-c:v libx264')
    expect(plan.args.join(' ')).toContain('-pix_fmt yuv420p')
  })

  it('re-encodes H.264 4:4:4, which iOS cannot decode', () => {
    expect(iosCompatibleVideo(parseProbe(H264_444))).toBe(false)
  })

  it('re-encodes when downscaling or when forced, and drops audio when muted', () => {
    expect(planIosMp4(parseProbe(MKV_HEV1), { ...opts, maxSize: 1920 }).reencodeVideo).toBe(true)
    expect(planIosMp4(parseProbe(IPHONE_HEVC), { ...opts, forceEncode: true }).reencodeVideo).toBe(true)
    const muted = planIosMp4(parseProbe(IPHONE_HEVC), { ...opts, mute: true })
    expect(muted.args).toContain('-an')
    expect(muted.args).not.toContain('0:a:0?')
  })
})

describe('scaleFilter', () => {
  it('fits the long edge and keeps dimensions even', () => {
    expect(scaleFilter(1280, parseProbe(MKV_HEV1))).toBe('scale=1280:-2')
    expect(scaleFilter(0, parseProbe(MKV_HEV1))).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2')
    const portrait = { video: { codec: 'h264', width: 1080, height: 1920 } }
    expect(scaleFilter(1280, portrait)).toBe('scale=-2:1280')
  })
})

describe('codec selection', () => {
  it('picks a codec for every video and audio container', () => {
    const p = parseProbe(WEBM_VP9)
    expect(planVideo('webm', p, opts)).toContain('libvpx')
    expect(planVideo('avi', p, opts)).toContain('mpeg4')
    expect(planVideo('mov', p, opts)).toContain('libx264')
    for (const t of ['mp3', 'm4a', 'm4r', 'wav', 'aiff', 'flac', 'ogg', 'opus']) expect(planAudio(t, 192)).toContain('-vn')
    expect(planAudio('m4r', 256)).toContain('ipod')
  })
})
