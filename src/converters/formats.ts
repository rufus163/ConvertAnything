export type Category = 'image' | 'video' | 'audio' | 'document' | 'data' | 'archive'

export interface Format {
  id: string
  label: string
  category: Category
  extensions: string[]
  mime: string
  /** Short hint shown next to the format in pickers. */
  hint?: string
}

const f = (
  id: string,
  label: string,
  category: Category,
  extensions: string[],
  mime: string,
  hint?: string,
): Format => ({ id, label, category, extensions, mime, hint })

export const FORMATS: Record<string, Format> = Object.fromEntries(
  [
    // Images
    f('png', 'PNG', 'image', ['png'], 'image/png', 'Lossless, transparency'),
    f('jpg', 'JPG', 'image', ['jpg', 'jpeg', 'jfif'], 'image/jpeg', 'Small photos'),
    f('webp', 'WebP', 'image', ['webp'], 'image/webp', 'Modern web image'),
    f('avif', 'AVIF', 'image', ['avif'], 'image/avif'),
    f('gif', 'GIF', 'image', ['gif'], 'image/gif', 'Animation'),
    f('bmp', 'BMP', 'image', ['bmp'], 'image/bmp', 'Uncompressed bitmap'),
    f('tiff', 'TIFF', 'image', ['tif', 'tiff'], 'image/tiff', 'Print & scanning'),
    f('heic', 'HEIC', 'image', ['heic', 'heif'], 'image/heic', 'iPhone photos'),
    f('ico', 'ICO', 'image', ['ico'], 'image/x-icon', 'Favicon / Windows icon'),
    f('svg', 'SVG', 'image', ['svg'], 'image/svg+xml', 'Scalable vector'),

    // Video
    f('mp4', 'MP4', 'video', ['mp4', 'm4v'], 'video/mp4', 'Plays everywhere'),
    f('mov', 'MOV', 'video', ['mov', 'qt'], 'video/quicktime', 'Apple QuickTime'),
    f('webm', 'WebM', 'video', ['webm'], 'video/webm', 'Web video'),
    f('mkv', 'MKV', 'video', ['mkv'], 'video/x-matroska'),
    f('avi', 'AVI', 'video', ['avi'], 'video/x-msvideo'),
    f('wmv', 'WMV', 'video', ['wmv'], 'video/x-ms-wmv'),
    f('flv', 'FLV', 'video', ['flv'], 'video/x-flv'),
    f('3gp', '3GP', 'video', ['3gp', '3g2'], 'video/3gpp'),
    f('mpeg', 'MPEG', 'video', ['mpg', 'mpeg', 'ts', 'mts', 'm2ts'], 'video/mpeg'),

    // Audio
    f('mp3', 'MP3', 'audio', ['mp3'], 'audio/mpeg', 'Plays everywhere'),
    f('m4a', 'M4A', 'audio', ['m4a', 'aac'], 'audio/mp4', 'Apple / AAC'),
    f('wav', 'WAV', 'audio', ['wav'], 'audio/wav', 'Uncompressed'),
    f('flac', 'FLAC', 'audio', ['flac'], 'audio/flac', 'Lossless'),
    f('ogg', 'OGG', 'audio', ['ogg', 'oga'], 'audio/ogg'),
    f('opus', 'Opus', 'audio', ['opus'], 'audio/opus', 'Voice & streaming'),
    f('aiff', 'AIFF', 'audio', ['aif', 'aiff'], 'audio/aiff'),
    f('wma', 'WMA', 'audio', ['wma'], 'audio/x-ms-wma'),
    f('m4r', 'M4R', 'audio', ['m4r'], 'audio/mp4', 'iPhone ringtone'),
    f('amr', 'AMR', 'audio', ['amr'], 'audio/amr', 'Voice memo'),

    // Documents
    f('pdf', 'PDF', 'document', ['pdf'], 'application/pdf', 'Share & print'),
    f('docx', 'DOCX', 'document', ['docx'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document'),
    f('md', 'Markdown', 'document', ['md', 'markdown'], 'text/markdown'),
    f('html', 'HTML', 'document', ['html', 'htm'], 'text/html', 'Web page'),
    f('txt', 'Text', 'document', ['txt', 'text', 'log'], 'text/plain', 'Plain text'),

    // Data
    f('csv', 'CSV', 'data', ['csv'], 'text/csv', 'Spreadsheet rows'),
    f('tsv', 'TSV', 'data', ['tsv', 'tab'], 'text/tab-separated-values'),
    f('xlsx', 'XLSX', 'data', ['xlsx'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel'),
    f('json', 'JSON', 'data', ['json'], 'application/json'),
    f('yaml', 'YAML', 'data', ['yaml', 'yml'], 'application/yaml'),
    f('xml', 'XML', 'data', ['xml'], 'application/xml'),
    f('toml', 'TOML', 'data', ['toml'], 'application/toml'),

    // Archives
    f('zip', 'ZIP', 'archive', ['zip'], 'application/zip', 'Bundle files'),
    // Pseudo-format: anything we can put into a ZIP.
    f('any', 'Any file', 'archive', [], 'application/octet-stream'),
  ].map((x) => [x.id, x]),
)

export const CATEGORY_LABELS: Record<Category, string> = {
  image: 'Images',
  video: 'Video',
  audio: 'Audio',
  document: 'Documents',
  data: 'Data',
  archive: 'Archives',
}

const BY_EXTENSION = new Map<string, Format>()
for (const fmt of Object.values(FORMATS)) {
  for (const ext of fmt.extensions) BY_EXTENSION.set(ext, fmt)
}

const BY_MIME = new Map<string, Format>()
for (const fmt of Object.values(FORMATS)) {
  if (!BY_MIME.has(fmt.mime)) BY_MIME.set(fmt.mime, fmt)
}
BY_MIME.set('image/heif', FORMATS.heic)
BY_MIME.set('audio/x-m4a', FORMATS.m4a)
BY_MIME.set('audio/aac', FORMATS.m4a)
BY_MIME.set('audio/mp3', FORMATS.mp3)
BY_MIME.set('audio/x-wav', FORMATS.wav)
BY_MIME.set('audio/wave', FORMATS.wav)
BY_MIME.set('audio/x-flac', FORMATS.flac)
BY_MIME.set('audio/x-aiff', FORMATS.aiff)
BY_MIME.set('video/x-m4v', FORMATS.mp4)
BY_MIME.set('video/mp2t', FORMATS.mpeg)
BY_MIME.set('text/x-markdown', FORMATS.md)
BY_MIME.set('text/xml', FORMATS.xml)
BY_MIME.set('text/yaml', FORMATS.yaml)
BY_MIME.set('application/x-yaml', FORMATS.yaml)
BY_MIME.set('application/x-zip-compressed', FORMATS.zip)
BY_MIME.set('image/vnd.microsoft.icon', FORMATS.ico)

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function baseName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Detects a file's format from its extension, falling back to its MIME type. */
export function detectFormat(file: { name: string; type?: string }): Format | undefined {
  return BY_EXTENSION.get(extensionOf(file.name)) ?? (file.type ? BY_MIME.get(file.type.toLowerCase()) : undefined)
}

export function acceptAttribute(formatIds: string[]): string {
  const parts = new Set<string>()
  for (const id of formatIds) {
    const fmt = FORMATS[id]
    if (!fmt) continue
    fmt.extensions.forEach((e) => parts.add('.' + e))
    if (fmt.mime !== 'application/octet-stream') parts.add(fmt.mime)
  }
  return [...parts].join(',')
}
