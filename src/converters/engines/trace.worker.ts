import ImageTracer from 'imagetracerjs'

self.onmessage = (e: MessageEvent<{ width: number; height: number; data: Uint8ClampedArray; options: Record<string, unknown> }>) => {
  try {
    const { width, height, data, options } = e.data
    const svg = ImageTracer.imagedataToSVG({ width, height, data }, options)
    self.postMessage({ svg })
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) })
  }
}
