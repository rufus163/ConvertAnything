import { describe, expect, it } from 'vitest'
import { detectFormat, FORMATS } from '../src/converters/formats'
import { combineConvertersFor, commonTargets, CONVERTERS, convertersFor } from '../src/converters/registry'

describe('registry', () => {
  it('has unique ids and only references known formats', () => {
    expect(new Set(CONVERTERS.map((c) => c.id)).size).toBe(CONVERTERS.length)
    for (const c of CONVERTERS) {
      expect(FORMATS[c.to], c.id).toBeDefined()
      for (const f of c.from) expect(FORMATS[f], `${c.id} from ${f}`).toBeDefined()
      for (const o of c.options ?? []) if (o.type === 'select') expect(o.choices.map((x) => x.value)).toContain(o.default)
    }
  })

  it('offers conversions for every real format', () => {
    for (const id of Object.keys(FORMATS)) {
      if (id === 'any') continue
      expect(convertersFor(id).filter((c) => c.id !== 'zip').length, id).toBeGreaterThan(0)
    }
  })

  it('puts the most useful target first', () => {
    expect(convertersFor('heic')[0].id).toBe('image-jpg')
    expect(convertersFor('mov')[0].id).toBe('video-ios')
    expect(convertersFor('png').map((c) => c.id)).toContain('image-svg')
    expect(convertersFor('pdf').map((c) => c.id)).not.toContain('pdf-merge')
  })

  it('detects formats by extension and MIME type', () => {
    expect(detectFormat({ name: 'IMG_0001.HEIC' })?.id).toBe('heic')
    expect(detectFormat({ name: 'clip', type: 'video/quicktime' })?.id).toBe('mov')
    expect(detectFormat({ name: 'notes.markdown' })?.id).toBe('md')
  })

  it('finds combine and shared targets for batches', () => {
    const files = [{ name: 'a.png' }, { name: 'b.jpg' }]
    expect(combineConvertersFor(files).map((c) => c.id)).toEqual(['image-pdf', 'zip'])
    expect(combineConvertersFor([{ name: 'a.pdf' }, { name: 'b.png' }]).map((c) => c.id)).toEqual(['pdf-merge', 'zip'])
    expect(combineConvertersFor([{ name: 'a.pdf' }, { name: 'b.mp3' }]).map((c) => c.id)).toEqual(['zip'])
    expect(commonTargets(files).map((t) => t.label)).toContain('WebP')
  })
})
