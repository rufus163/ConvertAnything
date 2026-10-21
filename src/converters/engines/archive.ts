import { baseName, detectFormat } from '../formats'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'

/** Returns `name`, or "name (2).ext", "name (3).ext"… if it's already taken. */
export function uniqueName(name: string, used: Set<string>): string {
  let out = name
  const stem = baseName(name)
  for (let n = 2; used.has(out); n++) out = `${stem} (${n})${name.slice(stem.length)}`
  used.add(out)
  return out
}

export async function zipFiles(files: File[], _opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  const { zip } = await import('fflate')
  ctx.onStatus('Compressing…')
  const entries: Record<string, Uint8Array> = {}
  const used = new Set<string>()
  for (const [i, f] of files.entries()) {
    entries[uniqueName(f.name, used)] = new Uint8Array(await f.arrayBuffer())
    ctx.onProgress(((i + 1) / files.length) * 0.5)
  }
  const data = await new Promise<Uint8Array>((resolve, reject) =>
    zip(entries, { level: 6 }, (err, out) => (err ? reject(new ConversionError(err.message)) : resolve(out))),
  )
  ctx.onProgress(1)
  const name = files.length === 1 ? baseName(files[0].name) : 'archive'
  return [{ name: `${name}.zip`, blob: new Blob([data as BlobPart], { type: 'application/zip' }) }]
}

export async function unzipFile(file: File, _opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  const { unzip } = await import('fflate')
  ctx.onStatus('Extracting…')
  const data = new Uint8Array(await file.arrayBuffer())
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(data, (err, out) => (err ? reject(new ConversionError('This ZIP file could not be opened.')) : resolve(out))),
  )
  const used = new Set<string>()
  const outputs = Object.entries(files)
    // Skip folders and macOS metadata.
    .filter(([path]) => !path.endsWith('/') && !path.startsWith('__MACOSX/') && !path.split('/').pop()!.startsWith('._'))
    .map(([path, bytes]) => {
      const name = uniqueName(path.split('/').pop()!, used)
      const type = detectFormat({ name })?.mime ?? 'application/octet-stream'
      return { name, blob: new Blob([bytes as BlobPart], { type }) }
    })
  if (!outputs.length) throw new ConversionError('This ZIP file is empty.')
  ctx.onProgress(1)
  return outputs
}
