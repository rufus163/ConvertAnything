// Removes specific text from a PDF page's content stream, so edited text is really
// replaced instead of covered up.
//
// A page's text is a list of drawing instructions ("font F1 at 12 pt, move to x/y,
// draw these glyph codes"). This module reads those instructions, tracks the text
// state the way a PDF viewer does to work out where every glyph lands, deletes the
// glyphs inside the target areas, and puts equivalent spacing in their place so the
// rest of the line stays exactly where it was.
import { Encodings, Font as StandardFontMetrics, FontNames } from '@pdf-lib/standard-fonts'
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFDocument, type PDFPage } from 'pdf-lib'

/** An area of text to remove, in PDF user space (baseline origin, direction, advance width, font size). */
export interface RemovalTarget {
  id: string
  x: number
  y: number
  angle: number
  width: number
  size: number
}

// ---------- Tokenizer ----------

type Value = number | boolean | null | { name: string } | { bytes: Uint8Array } | Value[] | { dict: true }

interface Op {
  op: string
  operands: Value[]
  /** Byte range covering the operands and the operator. */
  start: number
  end: number
}

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37])

class Lexer {
  pos = 0
  constructor(private b: Uint8Array) {}

  private skipSpace() {
    const b = this.b
    while (this.pos < b.length) {
      const c = b[this.pos]
      if (WS.has(c)) this.pos++
      else if (c === 37 /* % */) while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++
      else break
    }
  }

  private regular(): string {
    const start = this.pos
    while (this.pos < this.b.length && !WS.has(this.b[this.pos]) && !DELIM.has(this.b[this.pos])) this.pos++
    return String.fromCharCode(...this.b.subarray(start, this.pos))
  }

  private literalString(): Uint8Array {
    const b = this.b
    const out: number[] = []
    let depth = 1
    this.pos++ // (
    while (this.pos < b.length) {
      const c = b[this.pos++]
      if (c === 92 /* \ */) {
        const n = b[this.pos++]
        const map: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 }
        if (n in map) out.push(map[n])
        else if (n >= 48 && n <= 55) {
          let v = n - 48
          for (let i = 0; i < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; i++) v = v * 8 + (b[this.pos++] - 48)
          out.push(v & 255)
        } else if (n === 13) {
          if (b[this.pos] === 10) this.pos++
        } else if (n !== 10) out.push(n)
      } else if (c === 40) {
        depth++
        out.push(c)
      } else if (c === 41) {
        if (--depth === 0) break
        out.push(c)
      } else out.push(c)
    }
    return new Uint8Array(out)
  }

  private hexString(): Uint8Array {
    const b = this.b
    this.pos++ // <
    let hex = ''
    while (this.pos < b.length && b[this.pos] !== 62) {
      const c = b[this.pos++]
      if (!WS.has(c)) hex += String.fromCharCode(c)
    }
    this.pos++ // >
    if (hex.length % 2) hex += '0'
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }

  /** Next token: a value, an operator ({ op }), or undefined at the end. */
  next(): { value?: Value; op?: string; close?: ']' | '>>'; start: number } | undefined {
    this.skipSpace()
    const b = this.b
    if (this.pos >= b.length) return undefined
    const start = this.pos
    const c = b[this.pos]
    if (c === 40) return { value: { bytes: this.literalString() }, start }
    if (c === 60) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2
        this.skipValuesUntil('>>')
        return { value: { dict: true }, start }
      }
      return { value: { bytes: this.hexString() }, start }
    }
    if (c === 62 && b[this.pos + 1] === 62) {
      this.pos += 2
      return { close: '>>', start }
    }
    if (c === 91) {
      this.pos++
      const arr: Value[] = []
      for (;;) {
        const t = this.next()
        if (!t || t.close === ']') break
        if (t.value !== undefined) arr.push(t.value)
        else if (t.op !== undefined) arr.push(t.op === 'true' ? true : t.op === 'false' ? false : null)
      }
      return { value: arr, start }
    }
    if (c === 93) {
      this.pos++
      return { close: ']', start }
    }
    if (c === 47) {
      this.pos++
      return { value: { name: this.regular() }, start }
    }
    if (c === 123 || c === 125 || c === 41) {
      this.pos++
      return this.next()
    }
    const word = this.regular()
    if (!word) {
      this.pos++
      return this.next()
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { value: Number(word), start }
    return { op: word, start }
  }

  private skipValuesUntil(close: '>>') {
    for (;;) {
      const t = this.next()
      if (!t || t.close === close) return
    }
  }

  /** Skips inline image data after the ID operator, up to and including EI. */
  skipInlineImage() {
    const b = this.b
    this.pos++ // single whitespace after ID
    while (this.pos < b.length) {
      if (b[this.pos] === 69 && b[this.pos + 1] === 73 && WS.has(b[this.pos - 1]) && (this.pos + 2 >= b.length || WS.has(b[this.pos + 2]) || DELIM.has(b[this.pos + 2]))) {
        this.pos += 2
        return
      }
      this.pos++
    }
  }
}

export function parseOps(bytes: Uint8Array): Op[] {
  const lexer = new Lexer(bytes)
  const ops: Op[] = []
  let operands: Value[] = []
  let first = -1
  for (;;) {
    const t = lexer.next()
    if (!t) break
    if (t.op === undefined) {
      if (t.value !== undefined) {
        if (first < 0) first = t.start
        operands.push(t.value)
      }
      continue
    }
    if (t.op === 'true' || t.op === 'false' || t.op === 'null') {
      if (first < 0) first = t.start
      operands.push(t.op === 'null' ? null : t.op === 'true')
      continue
    }
    if (t.op === 'ID') lexer.skipInlineImage()
    ops.push({ op: t.op, operands, start: first < 0 ? t.start : first, end: lexer.pos })
    operands = []
    first = -1
  }
  return ops
}

// ---------- Fonts ----------

interface FontMetrics {
  /** 1 for simple fonts, 2 for Identity-encoded composite fonts. */
  bytesPerCode: number
  /** Advance width of a character code in text space units (usually /1000 of the size). */
  width: (code: number) => number
}

const STANDARD: [RegExp, FontNames][] = [
  [/courier.*bold.*(oblique|italic)/i, FontNames.CourierBoldOblique],
  [/courier.*bold/i, FontNames.CourierBold],
  [/courier.*(oblique|italic)/i, FontNames.CourierOblique],
  [/courier/i, FontNames.Courier],
  [/times.*bold.*italic/i, FontNames.TimesRomanBoldItalic],
  [/times.*bold/i, FontNames.TimesRomanBold],
  [/times.*italic/i, FontNames.TimesRomanItalic],
  [/times/i, FontNames.TimesRoman],
  [/symbol/i, FontNames.Symbol],
  [/dingbats/i, FontNames.ZapfDingbats],
  [/(helvetica|arial).*bold.*(oblique|italic)/i, FontNames.HelveticaBoldOblique],
  [/(helvetica|arial).*bold/i, FontNames.HelveticaBold],
  [/(helvetica|arial).*(oblique|italic)/i, FontNames.HelveticaOblique],
]

let winAnsiNames: Map<number, string> | undefined
function winAnsiGlyphName(code: number): string | undefined {
  if (!winAnsiNames) {
    winAnsiNames = new Map()
    const enc = Encodings.WinAnsi
    for (const cp of enc.supportedCodePoints) {
      const { code: c, name } = enc.encodeUnicodeCodePoint(cp)
      winAnsiNames.set(c, name)
    }
  }
  return winAnsiNames.get(code)
}

const num = (v: unknown, fallback = 0) => (v instanceof PDFNumber ? v.asNumber() : fallback)

function fontMetrics(doc: PDFDocument, font: PDFDict): FontMetrics | null {
  const get = (dict: PDFDict, key: string) => doc.context.lookup(dict.get(PDFName.of(key)))
  const name = (dict: PDFDict, key: string) => {
    const v = get(dict, key)
    return v instanceof PDFName ? v.asString() : undefined
  }
  const array = (dict: PDFDict, key: string) => {
    const v = get(dict, key)
    return v instanceof PDFArray ? v : undefined
  }
  const subtype = name(font, 'Subtype')

  if (subtype === '/Type0') {
    const encoding = name(font, 'Encoding')
    // Other CMaps map codes of varying length; not worth guessing.
    if (encoding !== '/Identity-H' && encoding !== '/Identity-V') return null
    const descendant = doc.context.lookup(array(font, 'DescendantFonts')?.get(0))
    if (!(descendant instanceof PDFDict)) return null
    const dw = num(doc.context.lookup(descendant.get(PDFName.of('DW'))), 1000)
    const widths = new Map<number, number>()
    const w = array(descendant, 'W')
    if (w) {
      const items = w.asArray().map((x) => doc.context.lookup(x))
      for (let i = 0; i < items.length; ) {
        const first = num(items[i])
        const next = items[i + 1]
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => widths.set(first + j, num(doc.context.lookup(x))))
          i += 2
        } else {
          const last = num(next)
          const value = num(items[i + 2])
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, value)
          i += 3
        }
      }
    }
    return { bytesPerCode: 2, width: (code) => (widths.get(code) ?? dw) / 1000 }
  }

  const scale = subtype === '/Type3' ? num(doc.context.lookup(array(font, 'FontMatrix')?.get(0)), 0.001) : 0.001
  const widthsArr = array(font, 'Widths')
  const firstChar = num(doc.context.lookup(font.get(PDFName.of('FirstChar'))))
  const descriptorObj = get(font, 'FontDescriptor')
  const descriptor = descriptorObj instanceof PDFDict ? descriptorObj : undefined
  const missing = descriptor ? num(doc.context.lookup(descriptor.get(PDFName.of('MissingWidth')))) : 0
  if (widthsArr) {
    const widths = widthsArr.asArray().map((x) => num(doc.context.lookup(x)))
    return { bytesPerCode: 1, width: (code) => (widths[code - firstChar] ?? missing) * scale }
  }

  // Standard 14 fonts may omit /Widths; use their built-in metrics.
  const base = name(font, 'BaseFont')?.slice(1) ?? ''
  const std = StandardFontMetrics.load(STANDARD.find(([re]) => re.test(base))?.[1] ?? FontNames.Helvetica)
  const differences = new Map<number, string>()
  const encoding = doc.context.lookup(font.get(PDFName.of('Encoding')))
  const diffs = encoding instanceof PDFDict ? doc.context.lookup(encoding.get(PDFName.of('Differences'))) : undefined
  if (diffs instanceof PDFArray) {
    let code = 0
    for (const item of diffs.asArray()) {
      const v = doc.context.lookup(item)
      if (v instanceof PDFNumber) code = v.asNumber()
      else if (v instanceof PDFName) differences.set(code++, v.asString().slice(1))
    }
  }
  return {
    bytesPerCode: 1,
    width: (code) => {
      const name = differences.get(code) ?? winAnsiGlyphName(code)
      const w = name ? std.getWidthOfGlyph(name) : undefined
      return (typeof w === 'number' ? w : 500) / 1000
    },
  }
}

// ---------- Interpreter ----------

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]
const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]

interface TextState {
  ctm: Matrix
  font?: string
  size: number
  charSpacing: number
  wordSpacing: number
  scale: number
  leading: number
  rise: number
}

const isNum = (v: Value): v is number => typeof v === 'number'
const isBytes = (v: Value): v is { bytes: Uint8Array } => typeof v === 'object' && v !== null && 'bytes' in v

function hex(bytes: Uint8Array): string {
  let s = '<'
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s + '>'
}
const fmt = (n: number) => (Math.abs(n) < 1e-6 ? '0' : String(Math.round(n * 1000) / 1000))

function inside(t: RemovalTarget, x: number, y: number, size: number): boolean {
  const ux = Math.cos(t.angle)
  const uy = Math.sin(t.angle)
  const dx = x - t.x
  const dy = y - t.y
  const along = dx * ux + dy * uy
  const across = -dx * uy + dy * ux
  return Math.abs(across) <= 0.45 * t.size && along >= -0.25 * t.size && along <= t.width + 0.25 * t.size && Math.abs(size - t.size) <= 0.3 * t.size
}

export interface RemovalResult {
  /** Glyphs removed per target id. */
  removed: Map<string, number>
  /** Whether the page content was changed. */
  changed: boolean
}

function contentBytes(doc: PDFDocument, page: PDFPage): Uint8Array | null {
  const contents = page.node.Contents()
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : contents ? [contents] : []
  const parts: Uint8Array[] = []
  for (const s of streams) {
    if (s instanceof PDFRawStream) parts.push(decodePDFRawStream(s).decode())
    else if (s instanceof PDFStream) parts.push(s.getContents())
    else return null
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    out[o + p.length] = 10
    o += p.length + 1
  }
  return out
}

/** Removes the glyphs inside `targets` from the page's own content stream. */
export function removeText(doc: PDFDocument, page: PDFPage, targets: RemovalTarget[]): RemovalResult {
  const removed = new Map(targets.map((t) => [t.id, 0]))
  if (!targets.length) return { removed, changed: false }
  let bytes: Uint8Array | null
  try {
    bytes = contentBytes(doc, page)
  } catch {
    return { removed, changed: false }
  }
  if (!bytes) return { removed, changed: false }

  const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
  const fonts = new Map<string, FontMetrics | null>()
  const metricsFor = (name: string | undefined) => {
    if (!name || !fontDict) return null
    if (!fonts.has(name)) {
      const f = doc.context.lookup(fontDict.get(PDFName.of(name)))
      let m: FontMetrics | null = null
      try {
        m = f instanceof PDFDict ? fontMetrics(doc, f) : null
      } catch {
        m = null
      }
      fonts.set(name, m)
    }
    return fonts.get(name)!
  }

  const ops = parseOps(bytes)
  const stack: TextState[] = []
  let gs: TextState = { ctm: IDENTITY, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, rise: 0 }
  let tm: Matrix = IDENTITY
  let tlm: Matrix = IDENTITY
  const edits: { start: number; end: number; text: string }[] = []

  const newLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -gs.leading], tlm)
    tm = tlm
  }

  /** Walks a show-text operation; returns replacement source if any glyph was removed. */
  const show = (items: Value[]): string | null => {
    const m = metricsFor(gs.font)
    const th = gs.scale
    const fs = gs.size
    const out: string[] = []
    let pending: number[] = []
    let gap = 0
    let any = false
    const flush = () => {
      if (pending.length) out.push(hex(new Uint8Array(pending)))
      pending = []
    }
    for (const item of items) {
      if (isNum(item)) {
        const tx = (-item / 1000) * fs * th
        tm = mul([1, 0, 0, 1, tx, 0], tm)
        // Inside a gap left by removed glyphs, fold the adjustment into the same number.
        if (gap) gap += item
        else {
          flush()
          out.push(fmt(item))
        }
        continue
      }
      if (!isBytes(item)) continue
      const b = item.bytes
      const step = m?.bytesPerCode ?? 1
      for (let i = 0; i + step <= b.length; i += step) {
        const code = step === 2 ? (b[i] << 8) | b[i + 1] : b[i]
        const w0 = m ? m.width(code) : 0
        const tx = (w0 * fs + gs.charSpacing + (step === 1 && code === 32 ? gs.wordSpacing : 0)) * th
        const trm = mul(mul([fs * th, 0, 0, fs, 0, gs.rise], tm), gs.ctm)
        const effSize = Math.hypot(trm[2], trm[3])
        // Glyph centre, in user space.
        const [cx, cy] = apply(mul(tm, gs.ctm), tx / 2, gs.rise)
        const hit = m && fs ? targets.find((t) => inside(t, cx, cy, effSize)) : undefined
        if (hit) {
          removed.set(hit.id, (removed.get(hit.id) ?? 0) + 1)
          any = true
          if (gap === 0) flush()
          // TJ number that advances by the same distance the removed glyph did.
          gap += -(tx / th) * (1000 / fs)
        } else {
          if (gap) {
            out.push(fmt(gap))
            gap = 0
          }
          for (let k = 0; k < step; k++) pending.push(b[i + k])
        }
        tm = mul([1, 0, 0, 1, tx, 0], tm)
      }
    }
    if (gap) {
      flush()
      out.push(fmt(gap))
    }
    flush()
    return any ? `[${out.join(' ')}] TJ` : null
  }

  for (const o of ops) {
    const a = o.operands
    switch (o.op) {
      case 'q':
        stack.push({ ...gs })
        break
      case 'Q':
        gs = stack.pop() ?? gs
        break
      case 'cm':
        if (a.length === 6 && a.every(isNum)) gs = { ...gs, ctm: mul(a as Matrix, gs.ctm) }
        break
      case 'BT':
        tm = tlm = IDENTITY
        break
      case 'Tf':
        if (a.length === 2 && typeof a[0] === 'object' && a[0] && 'name' in a[0] && isNum(a[1])) gs = { ...gs, font: a[0].name, size: a[1] }
        break
      case 'Tc':
        if (isNum(a[0])) gs = { ...gs, charSpacing: a[0] }
        break
      case 'Tw':
        if (isNum(a[0])) gs = { ...gs, wordSpacing: a[0] }
        break
      case 'Tz':
        if (isNum(a[0])) gs = { ...gs, scale: a[0] / 100 }
        break
      case 'TL':
        if (isNum(a[0])) gs = { ...gs, leading: a[0] }
        break
      case 'Ts':
        if (isNum(a[0])) gs = { ...gs, rise: a[0] }
        break
      case 'Td':
      case 'TD':
        if (a.length === 2 && a.every(isNum)) {
          if (o.op === 'TD') gs = { ...gs, leading: -(a[1] as number) }
          tlm = mul([1, 0, 0, 1, a[0] as number, a[1] as number], tlm)
          tm = tlm
        }
        break
      case 'Tm':
        if (a.length === 6 && a.every(isNum)) tm = tlm = a as Matrix
        break
      case 'T*':
        newLine()
        break
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        let prefix = ''
        if (o.op === '"' && a.length === 3 && isNum(a[0]) && isNum(a[1])) {
          gs = { ...gs, wordSpacing: a[0], charSpacing: a[1] }
          prefix = `${fmt(a[0])} Tw ${fmt(a[1])} Tc T* `
          newLine()
        } else if (o.op === "'") {
          prefix = 'T* '
          newLine()
        }
        const arg = a[a.length - 1]
        const items = Array.isArray(arg) ? arg : arg !== undefined ? [arg] : []
        const replacement = show(items)
        if (replacement) edits.push({ start: o.start, end: o.end, text: prefix + replacement })
        break
      }
    }
  }

  if (!edits.length) return { removed, changed: false }

  // Splice the rewritten operations into the original bytes.
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let at = 0
  for (const e of edits.sort((x, y) => x.start - y.start)) {
    chunks.push(bytes.subarray(at, e.start), encoder.encode(e.text))
    at = e.end
  }
  chunks.push(bytes.subarray(at))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  const ref: PDFRef = doc.context.register(doc.context.flateStream(out))
  page.node.set(PDFName.of('Contents'), ref)
  return { removed, changed: true }
}
