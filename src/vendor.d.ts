declare module 'imagetracerjs' {
  interface ImageTracer {
    imagedataToSVG(imgd: { width: number; height: number; data: Uint8ClampedArray }, options?: Record<string, unknown> | string): string
    optionpresets: Record<string, Record<string, unknown>>
  }
  const tracer: ImageTracer
  export default tracer
}

declare module 'gifenc' {
  type Palette = number[][]
  interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: Palette; transparent?: boolean; transparentIndex?: number; delay?: number; repeat?: number }): void
    finish(): void
    bytes(): Uint8Array
  }
  export function GIFEncoder(): Encoder
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: string; oneBitAlpha?: boolean | number }): Palette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: string): Uint8Array
}
