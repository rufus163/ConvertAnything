import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { parseOps, removeText, type RemovalTarget } from '../src/converters/engines/pdfContent'

interface Item {
  str: string
  x: number
  y: number
  width: number
  size: number
  angle: number
}

async function textItems(bytes: Uint8Array): Promise<Item[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice() })
  const pdf = await task.promise
  const content = await (await pdf.getPage(1)).getTextContent()
  await task.destroy()
  return content.items
    .filter((i): i is typeof i & { str: string; transform: number[]; width: number } => 'str' in i && Boolean(i.str.trim()))
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], width: i.width, size: Math.hypot(i.transform[2], i.transform[3]), angle: Math.atan2(i.transform[1], i.transform[0]) }))
}

const target = (id: string, i: Item): RemovalTarget => ({ id, x: i.x, y: i.y, angle: i.angle, width: i.width, size: i.size })

/** A page whose content stream is written by hand, using a standard (non-embedded) font. */
async function rawPage(content: string) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 300])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.node.setFontDictionary(PDFName.of('F1'), font.ref)
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)))
  return new Uint8Array(await doc.save())
}

async function remove(bytes: Uint8Array, pick: (items: Item[]) => Item[]) {
  const before = await textItems(bytes)
  const doc = await PDFDocument.load(bytes)
  const result = removeText(doc, doc.getPage(0), pick(before).map((it, n) => target(`t${n}`, it)))
  const after = await textItems(new Uint8Array(await doc.save()))
  return { before, after, result }
}

const find = (items: Item[], str: string) => items.find((i) => i.str.includes(str))

describe('removing text from page content', () => {
  it('removes one word from a kerned TJ array and keeps the others in place', async () => {
    const bytes = await rawPage('BT /F1 18 Tf 1 0 0 1 40 200 Tm [(Keep) -800 (Remove) -800 (Stay) 120 (put)] TJ ET')
    const before = await textItems(bytes)
    expect(before.map((i) => i.str).join('|')).toMatch(/Keep.*Remove.*Stay/)

    // pdf.js may group the words differently; target exactly the word "Remove".
    const doc = await PDFDocument.load(bytes)
    const keep = find(before, 'Keep')!
    // Locate "Remove" by measuring: it starts after "Keep" plus the 800-unit gap.
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const start = keep.x + font.widthOfTextAtSize('Keep', 18) + 0.8 * 18
    const width = font.widthOfTextAtSize('Remove', 18)
    const result = removeText(doc, doc.getPage(0), [{ id: 'r', x: start, y: keep.y, angle: 0, width, size: 18 }])
    expect(result.removed.get('r')).toBe(6)

    const after = await textItems(new Uint8Array(await doc.save()))
    const text = after.map((i) => i.str).join(' ')
    expect(text).not.toContain('Remove')
    expect(text).toContain('Keep')
    expect(text).toMatch(/Stay ?put/)
    // Words after the removed one haven't moved at all.
    expect(find(after, 'Stay')!.x).toBeCloseTo(find(before, 'Stay')!.x, 3)
    expect(find(after, 'Keep')!.x).toBeCloseTo(find(before, 'Keep')!.x, 3)
  })

  it('handles Tj, \', " with word spacing, character spacing and horizontal scaling', async () => {
    const content = [
      'BT /F1 12 Tf 14 TL 1 0 0 1 40 250 Tm',
      '(First line) Tj',
      "(Second line) '",
      '2 0.5 (Third line) "',
      '80 Tz 1 Tc (Fourth line) \'',
      'ET',
    ].join('\n')
    const { before, after, result } = await remove(await rawPage(content), (items) => items.filter((i) => /Second|Fourth/.test(i.str)))
    expect([...result.removed.values()].every((n) => n > 0)).toBe(true)
    const text = after.map((i) => i.str).join(' | ')
    expect(text).toContain('First line')
    expect(text).toContain('Third line')
    expect(text).not.toContain('Second')
    expect(text).not.toContain('Fourth')
    // Lines below a removed one keep their position.
    expect(find(after, 'Third')!.y).toBeCloseTo(find(before, 'Third')!.y, 3)
  })

  it('removes text drawn by pdf-lib with a standard font', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 200])
    const font = await doc.embedFont(StandardFonts.TimesRoman)
    page.drawText('Account 1234-5678', { x: 40, y: 120, size: 16, font })
    page.drawText('Unrelated line', { x: 40, y: 80, size: 16, font })
    const { after, result } = await remove(new Uint8Array(await doc.save()), (items) => items.filter((i) => i.str.includes('Account')))
    expect(result.changed).toBe(true)
    const text = after.map((i) => i.str).join(' ')
    expect(text).not.toContain('1234')
    expect(text).toContain('Unrelated line')
  })

  it('removes text in an embedded subset font (Identity-H)', async () => {
    const bytes = new Uint8Array(await readFile(path.join(import.meta.dirname, '../e2e/fixtures/embedded-font.pdf')))
    const { after } = await remove(bytes, (items) => items.filter((i) => i.str.includes('Hello')))
    const text = after.map((i) => i.str).join(' ')
    expect(text).not.toContain('Hello')
    expect(text).toContain('Invoice total')
  })

  it('leaves the page untouched when nothing matches', async () => {
    const bytes = await rawPage('BT /F1 12 Tf 40 100 Td (Nothing to see) Tj ET')
    const doc = await PDFDocument.load(bytes)
    const result = removeText(doc, doc.getPage(0), [{ id: 'x', x: 300, y: 20, angle: 0, width: 50, size: 12 }])
    expect(result.changed).toBe(false)
  })
})

describe('content stream parsing', () => {
  it('parses strings with escapes, nested parentheses, hex, arrays, dicts and inline images', () => {
    const src = '/P <</MCID 0>> BDC BT (a\\(b\\) \\101 (nested)) Tj <48 65> Tj [(x) -20 <79>] TJ ET EMC BI /W 1 /H 1 /BPC 8 /CS /G ID \x00\xff EI Q'
    const ops = parseOps(new TextEncoder().encode(src)).map((o) => o.op)
    expect(ops).toEqual(['BDC', 'BT', 'Tj', 'Tj', 'TJ', 'ET', 'EMC', 'BI', 'ID', 'Q'])
  })
})
