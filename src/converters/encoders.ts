// Small, dependency-free binary encoders. Kept DOM-free so they can be unit tested.

/** Encodes RGBA pixels as a 32-bit BMP (BITMAPV4HEADER keeps the alpha channel). */
export function encodeBmp(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const headerSize = 14
  const dibSize = 108
  const pixelBytes = width * height * 4
  const fileSize = headerSize + dibSize + pixelBytes
  const buf = new Uint8Array(fileSize)
  const view = new DataView(buf.buffer)

  // BITMAPFILEHEADER
  buf[0] = 0x42 // B
  buf[1] = 0x4d // M
  view.setUint32(2, fileSize, true)
  view.setUint32(10, headerSize + dibSize, true)

  // BITMAPV4HEADER
  view.setUint32(14, dibSize, true)
  view.setInt32(18, width, true)
  view.setInt32(22, -height, true) // negative height = top-down rows
  view.setUint16(26, 1, true) // planes
  view.setUint16(28, 32, true) // bits per pixel
  view.setUint32(30, 3, true) // BI_BITFIELDS
  view.setUint32(34, pixelBytes, true)
  view.setInt32(38, 2835, true) // 72 DPI
  view.setInt32(42, 2835, true)
  view.setUint32(54, 0x00ff0000, true) // red mask
  view.setUint32(58, 0x0000ff00, true) // green mask
  view.setUint32(62, 0x000000ff, true) // blue mask
  view.setUint32(66, 0xff000000, true) // alpha mask
  view.setUint32(70, 0x73524742, true) // 'sRGB'

  let o = headerSize + dibSize
  for (let i = 0; i < width * height * 4; i += 4) {
    buf[o++] = rgba[i + 2]
    buf[o++] = rgba[i + 1]
    buf[o++] = rgba[i]
    buf[o++] = rgba[i + 3]
  }
  return buf
}

/** Packs PNG images into a single .ico file (PNG-compressed entries, Vista+). */
export function encodeIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const count = images.length
  const headerBytes = 6 + count * 16
  const total = headerBytes + images.reduce((n, img) => n + img.png.length, 0)
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true) // type: icon
  view.setUint16(4, count, true)

  let offset = headerBytes
  images.forEach((img, i) => {
    const e = 6 + i * 16
    buf[e] = img.size >= 256 ? 0 : img.size
    buf[e + 1] = img.size >= 256 ? 0 : img.size
    buf[e + 2] = 0 // palette
    buf[e + 3] = 0
    view.setUint16(e + 4, 1, true) // color planes
    view.setUint16(e + 6, 32, true) // bpp
    view.setUint32(e + 8, img.png.length, true)
    view.setUint32(e + 12, offset, true)
    buf.set(img.png, offset)
    offset += img.png.length
  })
  return buf
}

/** Computes output dimensions for a resize option value. */
export function resizeDimensions(width: number, height: number, resize: string): { width: number; height: number } {
  if (!resize || resize === 'original') return { width, height }
  if (resize.endsWith('%')) {
    const pct = parseFloat(resize) / 100
    return { width: Math.max(1, Math.round(width * pct)), height: Math.max(1, Math.round(height * pct)) }
  }
  const max = parseInt(resize, 10)
  if (!max || (width <= max && height <= max)) return { width, height }
  const scale = max / Math.max(width, height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * Reads the EXIF orientation (1–8) of a JPEG, or 1 if there is none.
 * Only the first 64 KB are needed: EXIF lives in an APP1 segment near the start.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset)
    const size = view.getUint16(offset + 2)
    if (marker === 0xffe1 && offset + 10 <= view.byteLength && view.getUint32(offset + 4) === 0x45786966 /* "Exif" */) {
      const tiff = offset + 10
      if (tiff + 8 > view.byteLength) return 1
      const little = view.getUint16(tiff) === 0x4949
      const ifd = tiff + view.getUint32(tiff + 4, little)
      if (ifd + 2 > view.byteLength) return 1
      const entries = view.getUint16(ifd, little)
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12
        if (entry + 12 > view.byteLength) return 1
        if (view.getUint16(entry, little) === 0x0112) {
          const value = view.getUint16(entry + 8, little)
          return value >= 1 && value <= 8 ? value : 1
        }
      }
      return 1
    }
    // Stop at start-of-scan: image data follows, no more metadata.
    if (marker === 0xffda || (marker & 0xff00) !== 0xff00) return 1
    offset += 2 + size
  }
  return 1
}
