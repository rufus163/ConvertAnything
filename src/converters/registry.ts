import { detectFormat, FORMATS } from './formats'
import type { Converter, ConvertContext, OptionDef, Options, OutputFile, QualityPreset } from './types'

// Engines are imported lazily so the first page load stays small.
const image = () => import('./engines/image')
const media = () => import('./engines/media')
const pdf = () => import('./engines/pdf')
const doc = () => import('./engines/document')
const data = () => import('./engines/data')
const archive = () => import('./engines/archive')

type EachFn = (file: File, opts: Options, ctx: ConvertContext) => Promise<OutputFile[]>
const each =
  (fn: EachFn) =>
  async (files: File[], opts: Options, ctx: ConvertContext): Promise<OutputFile[]> => {
    const out: OutputFile[] = []
    for (const f of files) out.push(...(await fn(f, opts, ctx)))
    return out
  }

// ---------- Shared options ----------

const resize: OptionDef = {
  type: 'select',
  key: 'resize',
  label: 'Size',
  default: 'original',
  choices: [
    { value: 'original', label: 'Original' },
    { value: '3840', label: 'Max 3840 px' },
    { value: '1920', label: 'Max 1920 px' },
    { value: '1280', label: 'Max 1280 px' },
    { value: '640', label: 'Max 640 px' },
    { value: '50%', label: '50%' },
    { value: '25%', label: '25%' },
  ],
}
const quality: OptionDef = {
  type: 'range',
  key: 'quality',
  label: 'Quality',
  min: 10,
  max: 100,
  step: 5,
  default: 90,
  unit: '%',
  presets: { lossless: 100, balanced: 90, compact: 75 },
}
const background: OptionDef = { type: 'color', key: 'background', label: 'Background', default: '#ffffff', help: 'Fills transparent areas' }
const svgScale: OptionDef = {
  type: 'select',
  key: 'svgScale',
  label: 'Render scale',
  default: '2',
  choices: [
    { value: '1', label: '1×' },
    { value: '2', label: '2×' },
    { value: '4', label: '4×' },
    { value: '8', label: '8×' },
  ],
}
const pageSize = (withFit: boolean): OptionDef => ({
  type: 'select',
  key: 'pageSize',
  label: 'Page size',
  default: withFit ? 'fit' : 'a4',
  choices: [
    ...(withFit ? [{ value: 'fit', label: 'Fit to image' }] : []),
    { value: 'a4', label: 'A4' },
    { value: 'letter', label: 'US Letter' },
    { value: 'legal', label: 'US Legal' },
  ],
})
const fontSize: OptionDef = { type: 'range', key: 'fontSize', label: 'Text size', min: 8, max: 18, step: 1, default: 11, unit: 'pt' }

const videoQuality = (def: string, presets: OptionDef['presets'] = { lossless: 'lossless', balanced: def, compact: 'small' }): OptionDef => ({
  type: 'select',
  key: 'quality',
  label: 'Encoding',
  default: def,
  presets,
  choices: [
    { value: 'lossless', label: 'Lossless / original streams' },
    { value: 'high', label: 'High' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'small', label: 'Smallest file' },
  ],
})
const maxSize = (def: string, presets?: OptionDef['presets']): OptionDef => ({
  type: 'select',
  key: 'maxSize',
  label: 'Resolution',
  default: def,
  presets,
  choices: [
    { value: '0', label: 'Original' },
    { value: '3840', label: '4K' },
    { value: '1920', label: '1080p' },
    { value: '1280', label: '720p' },
    { value: '854', label: '480p' },
  ],
})
const mute: OptionDef = { type: 'toggle', key: 'mute', label: 'Remove audio', default: false }
const bitrate = (def: string, presets: OptionDef['presets'] = { lossless: '320', compact: '128' }): OptionDef => ({
  type: 'select',
  key: 'bitrate',
  label: 'Bitrate',
  default: def,
  presets,
  choices: ['64', '96', '128', '192', '256', '320'].map((v) => ({ value: v, label: `${v} kbps` })),
})
const start: OptionDef = { type: 'number', key: 'start', label: 'Start at', min: 0, step: 0.5, default: 0, unit: 's' }
const duration = (def: number, help?: string): OptionDef => ({ type: 'number', key: 'duration', label: 'Length', min: 0, step: 0.5, default: def, unit: 's', help: help ?? '0 = until the end' })

// ---------- Format groups ----------

export const RASTER_IN = ['png', 'jpg', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'heic', 'ico']
const IMAGE_IN = [...RASTER_IN, 'svg']
// AVIF output is left out on purpose: most browsers (including Safari) can't encode it yet.
const IMAGE_OUT = ['jpg', 'png', 'webp', 'svg', 'gif', 'bmp', 'tiff', 'ico']
const VIDEO_IN = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'mpeg']
const AUDIO_IN = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'wma', 'amr', 'm4r']
const AUDIO_OUT = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'm4r']
const DATA = ['csv', 'tsv', 'xlsx', 'json', 'yaml', 'xml', 'toml']

function imageOptions(to: string, from: string[]): OptionDef[] {
  const opts: OptionDef[] = []
  if (from.includes('svg')) opts.push(svgScale)
  if (to === 'svg') {
    opts.push(
      {
        type: 'select',
        key: 'svgMode',
        label: 'Method',
        default: 'trace',
        choices: [
          { value: 'trace', label: 'Trace to vector shapes' },
          { value: 'embed', label: 'Embed image (exact)' },
        ],
        help: 'Tracing makes true, scalable vectors; works best on logos and drawings.',
      },
      {
        type: 'select',
        key: 'trace',
        label: 'Detail',
        default: 'logo',
        choices: [
          { value: 'bw', label: 'Black & white' },
          { value: 'logo', label: 'Logo (few colors)' },
          { value: 'illustration', label: 'Illustration' },
          { value: 'photo', label: 'Photo (detailed)' },
        ],
      },
    )
  }
  if (to === 'ico') {
    opts.push({
      type: 'select',
      key: 'icoSizes',
      label: 'Icon sizes',
      default: 'favicon',
      choices: [
        { value: 'favicon', label: 'Favicon (16–48 px)' },
        { value: 'full', label: 'Windows (16–256 px)' },
        { value: 'app', label: 'Single 256 px' },
      ],
    })
  } else {
    opts.push(resize)
  }
  if (to === 'jpg' || to === 'webp') opts.push(quality)
  if (to === 'jpg') opts.push(background)
  return opts
}

const IMAGE_PRESET_NOTES: Record<string, Converter['presetNotes']> = {
  jpg: { lossless: 'Maximum JPG quality. JPG is always slightly lossy; choose PNG or WebP for a perfect copy.', balanced: 'Visually identical, much smaller', compact: 'Smallest JPG; fine detail may soften' },
  webp: { lossless: 'True lossless WebP, pixel-perfect', balanced: 'Visually identical, much smaller', compact: 'Smallest WebP' },
}

const imageConverters: Converter[] = IMAGE_OUT.map((to) => {
  const from = IMAGE_IN.filter((f) => f !== to && !(to === 'svg' && f === 'svg'))
  return {
    id: `image-${to}`,
    from,
    to,
    engine: 'image',
    mode: 'each',
    options: imageOptions(to, IMAGE_IN),
    presetNotes: IMAGE_PRESET_NOTES[to],
    run: each(async (f, o, c) => (await image()).convertImage(f, to, o, c)),
  } satisfies Converter
})

const pdfConverters: Converter[] = [
  {
    id: 'image-pdf',
    from: IMAGE_IN,
    to: 'pdf',
    label: 'PDF',
    description: 'Several images become one PDF, one page each',
    engine: 'pdf',
    mode: 'combine',
    recommended: true,
    options: [pageSize(true), { ...quality, label: 'Image quality' }, { ...resize, presets: { compact: '1920' } }],
    presetNotes: {
      lossless: 'Images are placed unchanged; JPG and PNG are never re-encoded',
      balanced: 'JPG/PNG unchanged, other formats compressed',
      compact: 'Everything compressed and scaled to 1920 px: smallest PDF',
    },
    run: async (files, o, c) => (await pdf()).imagesToPdf(files, o, c),
  },
  ...(['jpg', 'png'] as const).map(
    (to): Converter => ({
      id: `pdf-${to}`,
      from: ['pdf'],
      to,
      label: `${FORMATS[to].label} images`,
      description: 'One image per page',
      engine: 'pdf',
      mode: 'each',
      recommended: to === 'jpg',
      options: [
        {
          type: 'select',
          key: 'dpi',
          label: 'Resolution',
          default: '150',
          presets: { lossless: '300', compact: '96' },
          choices: [
            { value: '72', label: 'Screen (72 dpi)' },
            { value: '96', label: 'Web (96 dpi)' },
            { value: '150', label: 'Standard (150 dpi)' },
            { value: '300', label: 'Print (300 dpi)' },
            { value: '600', label: 'High-res print (600 dpi)' },
          ],
        },
        {
          type: 'select',
          key: 'pages',
          label: 'Pages',
          default: 'all',
          choices: [
            { value: 'all', label: 'All pages' },
            { value: 'first', label: 'First page only' },
          ],
        },
        ...(to === 'jpg' ? [quality] : []),
      ],
      run: each(async (f, o, c) => (await pdf()).pdfToImages(f, to, o, c)),
    }),
  ),
  {
    id: 'pdf-txt',
    from: ['pdf'],
    to: 'txt',
    label: 'Text',
    description: 'Extract the text content',
    engine: 'pdf',
    mode: 'each',
    run: each(async (f, o, c) => (await pdf()).pdfToText(f, o, c)),
  },
  {
    id: 'pdf-split',
    from: ['pdf'],
    to: 'pdf',
    label: 'Split pages',
    description: 'One PDF per page',
    engine: 'pdf',
    mode: 'each',
    run: each(async (f, o, c) => (await pdf()).splitPdf(f, o, c)),
  },
  {
    id: 'pdf-merge',
    from: ['pdf', ...IMAGE_IN],
    to: 'pdf',
    label: 'Merge into one PDF',
    description: 'Combine PDFs (and images) in order',
    engine: 'pdf',
    mode: 'combine',
    minInputs: 2,
    run: async (files, o, c) => (await pdf()).mergePdfs(files, o, c),
  },
]

const LOSSLESS_FALLBACK: Record<string, string> = {
  mp4: 'visually lossless H.264 that plays everywhere',
  mov: 'visually lossless H.264 that plays everywhere',
  mkv: 'mathematically lossless H.264 (large)',
  webm: 'lossless VP9 (slow, large)',
  avi: 'near-lossless MPEG-4',
}

const videoConverters: Converter[] = [
  {
    id: 'video-ios',
    from: VIDEO_IN,
    to: 'mp4',
    label: 'MP4 · iPhone & iPad',
    description: 'H.264/HEVC + AAC that plays on every Apple device. Fast when no re-encoding is needed.',
    engine: 'video',
    mode: 'each',
    recommended: true,
    presetNotes: {
      lossless: 'Copies the original video when the iPhone can play it; otherwise near-lossless H.264',
      balanced: 'Copies when possible; otherwise high-quality H.264',
      compact: 'Copies when possible; otherwise smaller, faster H.264',
    },
    options: [
      videoQuality('balanced'),
      maxSize('0'),
      mute,
      { type: 'toggle', key: 'forceEncode', label: 'Always re-encode', default: false, help: 'Use if a video still won’t play' },
    ],
    run: each(async (f, o, c) => (await media()).convertMedia(f, 'mp4', 'ios-mp4', o, c)),
  },
  {
    id: 'video-compress',
    from: VIDEO_IN,
    to: 'mp4',
    label: 'MP4 · Smaller file',
    description: 'Shrink a video for sharing or email',
    engine: 'video',
    mode: 'each',
    options: [videoQuality('small', { lossless: 'high', balanced: 'balanced', compact: 'small' }), maxSize('1280', { lossless: '1920', balanced: '1280', compact: '854' }), mute],
    presetNotes: { lossless: 'Light compression at 1080p', balanced: 'Good quality at 720p', compact: 'Smallest at 480p' },
    run: each(async (f, o, c) => (await media()).convertMedia(f, 'mp4', 'video', o, c, '-small')),
  },
  ...['mov', 'webm', 'mkv', 'avi'].map(
    (to): Converter => ({
      id: `video-${to}`,
      from: VIDEO_IN.filter((f) => f !== to),
      to,
      engine: 'video',
      mode: 'each',
      options: [videoQuality('balanced'), maxSize('0'), mute],
      presetNotes: {
        lossless: `Copies the original streams when possible (instant, perfect); otherwise ${LOSSLESS_FALLBACK[to]}`,
        compact: 'Smaller file, faster encode',
      },
      run: each(async (f, o, c) => (await media()).convertMedia(f, to, 'video', o, c)),
    }),
  ),
  {
    id: 'video-gif',
    from: [...VIDEO_IN],
    to: 'gif',
    label: 'GIF',
    description: 'Animated GIF',
    engine: 'video',
    mode: 'each',
    options: [
      {
        type: 'select',
        key: 'width',
        label: 'Width',
        default: '480',
        presets: { lossless: '640', compact: '320' },
        choices: ['240', '320', '480', '640', '800'].map((v) => ({ value: v, label: `${v} px` })),
      },
      { type: 'range', key: 'fps', label: 'Frame rate', min: 5, max: 30, step: 1, default: 12, unit: 'fps', presets: { lossless: 15, compact: 10 } },
      start,
      duration(10),
    ],
    run: each(async (f, o, c) => (await media()).convertMedia(f, 'gif', 'gif', o, c)),
  },
  ...['mp4', 'webm'].map(
    (to): Converter => ({
      id: `gif-${to}`,
      from: ['gif'],
      to,
      label: `${FORMATS[to].label} video`,
      description: 'Much smaller than GIF',
      engine: 'video',
      mode: 'each',
      options: [videoQuality('balanced')],
      presetNotes: { lossless: 'Every frame kept exactly (larger file)' },
      run: each(async (f, o, c) => (await media()).convertMedia(f, to, 'video', { ...o, mute: true }, c)),
    }),
  ),
]

const audioConverters: Converter[] = AUDIO_OUT.map((to): Converter => {
  const lossless = ['wav', 'flac', 'aiff'].includes(to)
  const options: OptionDef[] = []
  if (to === 'm4a') {
    options.push({
      type: 'select',
      key: 'codec',
      label: 'Codec',
      default: 'aac',
      presets: { lossless: 'alac' },
      choices: [
        { value: 'aac', label: 'AAC (small)' },
        { value: 'alac', label: 'Apple Lossless (ALAC)' },
      ],
    })
  }
  if (!lossless) options.push(bitrate(to === 'opus' ? '128' : to === 'm4r' ? '256' : '192', to === 'opus' ? { lossless: '256', compact: '64' } : undefined))
  if (to === 'm4r') options.push(start, duration(30, 'iPhone ringtones can be up to 40 s'))
  return {
    id: `audio-${to}`,
    from: [...AUDIO_IN, ...VIDEO_IN].filter((f) => f !== to),
    to,
    label: to === 'm4r' ? 'M4R · iPhone ringtone' : undefined,
    engine: 'audio',
    mode: 'each',
    recommended: to === 'mp3',
    options,
    presetNotes: lossless
      ? undefined
      : to === 'm4a'
        ? { lossless: 'Apple Lossless: bit-perfect, plays on every Apple device', balanced: 'AAC 192 kbps', compact: 'AAC 128 kbps' }
        : { lossless: `Highest ${FORMATS[to].label} bitrate. ${FORMATS[to].label} is lossy; choose FLAC, WAV or M4A (ALAC) for a perfect copy.`, balanced: 'Transparent for most listeners', compact: 'Smaller file' },
    run: each(async (f, o, c) => (await media()).convertMedia(f, to, 'audio', o, c)),
  }
})

const documentConverters: Converter[] = [
  ...[
    ['md', ['html', 'pdf', 'txt']],
    ['html', ['md', 'pdf', 'txt']],
    ['txt', ['pdf', 'html']],
    ['docx', ['pdf', 'html', 'md', 'txt']],
  ].flatMap(([from, tos]) =>
    (tos as string[]).map(
      (to): Converter => ({
        id: `doc-${from}-${to}`,
        from: [from as string],
        to,
        engine: 'document',
        mode: 'each',
        recommended: to === 'pdf',
        options: to === 'pdf' ? [pageSize(false), fontSize] : undefined,
        run: each(async (f, o, c) => (await doc()).convertDocument(f, to, o, c)),
      }),
    ),
  ),
]

const dataConverters: Converter[] = DATA.map(
  (to): Converter => ({
    id: `data-${to}`,
    from: DATA.filter((f) => f !== to),
    to,
    engine: 'data',
    mode: 'each',
    run: each(async (f, o, c) => (await data()).convertData(f, to, o, c)),
  }),
)

const archiveConverters: Converter[] = [
  {
    id: 'zip',
    from: ['any'],
    to: 'zip',
    label: 'ZIP archive',
    description: 'Bundle files into one .zip',
    engine: 'archive',
    mode: 'combine',
    run: async (files, o, c) => (await archive()).zipFiles(files, o, c),
  },
  {
    id: 'unzip',
    from: ['zip'],
    to: 'any',
    label: 'Extract files',
    description: 'Unpack everything inside',
    engine: 'archive',
    mode: 'each',
    recommended: true,
    run: each(async (f, o, c) => (await archive()).unzipFile(f, o, c)),
  },
]

export const CONVERTERS: Converter[] = [
  ...videoConverters,
  ...imageConverters,
  ...pdfConverters,
  ...audioConverters,
  ...documentConverters,
  ...dataConverters,
  ...archiveConverters,
]

export const CONVERTERS_BY_ID = new Map(CONVERTERS.map((c) => [c.id, c]))

// Preferred targets per input format; anything not listed keeps registry order.
const PREFERRED: Record<string, string[]> = {
  png: ['image-jpg', 'image-svg', 'image-pdf', 'image-webp', 'image-ico'],
  jpg: ['image-png', 'image-pdf', 'image-webp', 'image-svg'],
  heic: ['image-jpg', 'image-png', 'image-pdf'],
  webp: ['image-png', 'image-jpg', 'image-gif'],
  avif: ['image-png', 'image-jpg'],
  svg: ['image-png', 'image-jpg', 'image-pdf', 'image-ico'],
  gif: ['gif-mp4', 'image-png', 'gif-webm'],
  tiff: ['image-jpg', 'image-png', 'image-pdf'],
  bmp: ['image-png', 'image-jpg'],
  ico: ['image-png'],
  pdf: ['pdf-jpg', 'pdf-png', 'pdf-txt', 'pdf-split'],
  mov: ['video-ios', 'video-compress', 'video-gif', 'audio-mp3'],
  mp4: ['video-ios', 'video-compress', 'video-gif', 'audio-mp3', 'audio-m4a'],
  webm: ['video-ios', 'video-gif', 'audio-mp3'],
  mkv: ['video-ios', 'video-compress', 'audio-mp3'],
  m4a: ['audio-mp3', 'audio-m4r', 'audio-wav'],
  mp3: ['audio-m4a', 'audio-m4r', 'audio-wav'],
  wav: ['audio-mp3', 'audio-m4a', 'audio-flac'],
  csv: ['data-xlsx', 'data-json'],
  xlsx: ['data-csv', 'data-json'],
  json: ['data-csv', 'data-yaml', 'data-xlsx'],
  docx: ['doc-docx-pdf'],
}

function accepts(c: Converter, formatId: string | undefined) {
  return c.from.includes('any') || (formatId !== undefined && c.from.includes(formatId))
}

/** Converters available for a single file, best first. */
export function convertersFor(formatId: string | undefined): Converter[] {
  const list = CONVERTERS.filter((c) => accepts(c, formatId) && !(c.minInputs && c.minInputs > 1))
  const pref = (formatId && PREFERRED[formatId]) || []
  const rank = (c: Converter) => {
    const i = pref.indexOf(c.id)
    if (i >= 0) return i
    if (c.recommended) return pref.length
    return pref.length + 1 + (c.from.includes('any') ? 1000 : 0)
  }
  return list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c)
}

/** Converters that can take every one of these files together as a single job. */
export function combineConvertersFor(files: { name: string; type?: string }[]): Converter[] {
  if (files.length < 2) return []
  const ids = files.map((f) => detectFormat(f)?.id)
  const list = CONVERTERS.filter((c) => c.mode === 'combine' && ids.every((id) => accepts(c, id)))
  // For images only, "images → PDF" already does what "merge" would.
  return list.some((c) => c.id === 'image-pdf') ? list.filter((c) => c.id !== 'pdf-merge') : list
}

/** Converters with the same output that apply to every file (for "convert all to…"). */
export function commonTargets(files: { name: string; type?: string }[]): { label: string; ids: string[] }[] {
  if (files.length < 2) return []
  const ids = files.map((f) => detectFormat(f)?.id)
  const perFile = ids.map((id) => convertersFor(id).filter((c) => c.id !== 'zip'))
  const labels = new Map<string, string[]>()
  for (const c of perFile[0]) {
    const label = converterLabel(c)
    if (perFile.every((list) => list.some((x) => converterLabel(x) === label))) labels.set(label, [])
  }
  return [...labels.keys()].map((label) => ({ label, ids: perFile.map((list) => list.find((x) => converterLabel(x) === label)!.id) }))
}

export function converterLabel(c: Converter): string {
  return c.label ?? FORMATS[c.to]?.label ?? c.to
}

export function defaultOptions(c: Converter, preset: QualityPreset = 'balanced'): Options {
  return Object.fromEntries((c.options ?? []).map((o) => [o.key, o.presets?.[preset] ?? o.default]))
}

/** Whether the quality switch changes anything for this conversion. */
export function hasPresets(c: Converter): boolean {
  return (c.options ?? []).some((o) => o.presets)
}

/** Applies a preset to existing options, keeping choices the preset doesn't control. */
export function applyPreset(c: Converter, options: Options, preset: QualityPreset): Options {
  const out = { ...options }
  for (const o of c.options ?? []) if (o.presets) out[o.key] = o.presets[preset] ?? o.default
  return out
}
