import type { OutputFile } from '../converters/types'
import { isNativeApp, isTauri } from './platform'

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/** Writes a file into the iOS app's Documents folder (visible in the Files app) in chunks. */
async function writeNative(out: OutputFile): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  // Chunk size is a multiple of 3 so each base64 chunk can be appended independently.
  const CHUNK = 3 * 1024 * 1024
  const path = `ConvertAnything/${out.name}`
  for (let offset = 0; offset < out.blob.size || offset === 0; offset += CHUNK) {
    const data = await blobToBase64(out.blob.slice(offset, offset + CHUNK))
    if (offset === 0) await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true })
    else await Filesystem.appendFile({ path, data, directory: Directory.Documents })
    if (out.blob.size === 0) break
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Documents })
  return uri
}

async function saveTauri(out: OutputFile): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const ext = out.name.includes('.') ? out.name.split('.').pop()! : ''
  const path = await save({ defaultPath: out.name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined })
  if (!path) return false
  await writeFile(path, new Uint8Array(await out.blob.arrayBuffer()))
  return true
}

/** Saves one output the way the current platform expects. Resolves false if the user cancelled. */
export async function saveFile(out: OutputFile): Promise<boolean> {
  if (isTauri) return saveTauri(out)
  if (isNativeApp) {
    const uri = await writeNative(out)
    const { Share } = await import('@capacitor/share')
    try {
      await Share.share({ files: [uri] })
    } catch {
      // Dismissing the share sheet is fine; the file is already in Files › ConvertAnything.
    }
    return true
  }
  download(out.blob, out.name)
  return true
}

/** Opens the system share sheet (AirDrop, Save to Photos, Messages…). */
export async function shareFiles(outs: OutputFile[]): Promise<void> {
  if (isNativeApp) {
    const uris = []
    for (const out of outs) uris.push(await writeNative(out))
    const { Share } = await import('@capacitor/share')
    await Share.share({ files: uris }).catch(() => {})
    return
  }
  const files = outs.map((o) => new File([o.blob], o.name, { type: o.blob.type }))
  try {
    await navigator.share({ files })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return
    throw e
  }
}

export async function saveAll(outs: OutputFile[], zipName: string): Promise<boolean> {
  if (outs.length === 1) return saveFile(outs[0])
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    const { join } = await import('@tauri-apps/api/path')
    const dir = await open({ directory: true, title: 'Choose a folder' })
    if (!dir || Array.isArray(dir)) return false
    for (const out of outs) await writeFile(await join(dir, out.name), new Uint8Array(await out.blob.arrayBuffer()))
    return true
  }
  const { zipFiles } = await import('../converters/engines/archive')
  const files = outs.map((o) => new File([o.blob], o.name, { type: o.blob.type }))
  const ctl = new AbortController()
  const [zip] = await zipFiles(files, {}, { onProgress: () => {}, onStatus: () => {}, signal: ctl.signal })
  return saveFile({ name: `${zipName}.zip`, blob: zip.blob })
}
