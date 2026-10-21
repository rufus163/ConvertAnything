import { describe, expect, it } from 'vitest'
import { encodeBmp, encodeIco, resizeDimensions } from '../src/converters/encoders'

describe('encoders', () => {
  it('writes a valid 32-bit BMP header and BGRA pixels', () => {
    const bmp = encodeBmp(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]), 2, 1)
    const view = new DataView(bmp.buffer)
    expect(String.fromCharCode(bmp[0], bmp[1])).toBe('BM')
    expect(view.getUint32(2, true)).toBe(bmp.length)
    expect(view.getInt32(18, true)).toBe(2)
    expect(view.getInt32(22, true)).toBe(-1)
    expect([...bmp.subarray(122)]).toEqual([0, 0, 255, 255, 0, 255, 0, 128])
  })

  it('writes an ICO directory pointing at embedded PNGs', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const ico = encodeIco([
      { size: 16, png },
      { size: 256, png },
    ])
    const view = new DataView(ico.buffer)
    expect(view.getUint16(2, true)).toBe(1)
    expect(view.getUint16(4, true)).toBe(2)
    expect(ico[6]).toBe(16)
    expect(ico[22]).toBe(0) // 256 is stored as 0
    expect(view.getUint32(6 + 12, true)).toBe(6 + 32)
    expect([...ico.subarray(38, 42)]).toEqual([...png])
  })

  it('resizes by max edge or percentage', () => {
    expect(resizeDimensions(4000, 3000, '1920')).toEqual({ width: 1920, height: 1440 })
    expect(resizeDimensions(1000, 500, '1920')).toEqual({ width: 1000, height: 500 })
    expect(resizeDimensions(1000, 500, '50%')).toEqual({ width: 500, height: 250 })
    expect(resizeDimensions(1000, 500, 'original')).toEqual({ width: 1000, height: 500 })
  })
})
