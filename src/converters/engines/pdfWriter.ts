import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import { marked, type Token, type Tokens } from 'marked'

// A small rich-text layout engine on top of pdf-lib: paragraphs, headings,
// lists, quotes, code blocks and bold/italic/code runs, with word wrapping and
// automatic page breaks.

export const PAGE_SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
}

type FontKey = 'regular' | 'bold' | 'italic' | 'boldItalic' | 'mono'

interface Run {
  text: string
  font: FontKey
}

interface Block {
  kind: 'paragraph' | 'heading' | 'code' | 'rule' | 'space'
  runs?: Run[]
  level?: number
  indent?: number
  bullet?: string
  quote?: boolean
}

// Standard PDF fonts only cover WinAnsi; replace anything else so encoding never throws.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'
function sanitize(text: string): string {
  return text
    .replace(/\t/g, '    ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•●]/g, '•')
    .replace(/./gu, (ch) => {
      const code = ch.codePointAt(0)!
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch
      return '?'
    })
}

function inlineRuns(tokens: Token[] | undefined, font: FontKey = 'regular'): Run[] {
  const runs: Run[] = []
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong': {
        const next: FontKey = font === 'italic' || font === 'boldItalic' ? 'boldItalic' : 'bold'
        runs.push(...inlineRuns((t as Tokens.Strong).tokens, next))
        break
      }
      case 'em': {
        const next: FontKey = font === 'bold' || font === 'boldItalic' ? 'boldItalic' : 'italic'
        runs.push(...inlineRuns((t as Tokens.Em).tokens, next))
        break
      }
      case 'codespan':
        runs.push({ text: decodeEntities((t as Tokens.Codespan).text), font: 'mono' })
        break
      case 'br':
        runs.push({ text: '\n', font })
        break
      case 'link':
        runs.push(...inlineRuns((t as Tokens.Link).tokens, font))
        break
      case 'image':
        runs.push({ text: `[${(t as Tokens.Image).text || 'image'}]`, font: 'italic' })
        break
      default: {
        const anyT = t as Token & { tokens?: Token[]; text?: string }
        if (anyT.tokens?.length) runs.push(...inlineRuns(anyT.tokens, font))
        else if (anyT.text !== undefined) runs.push({ text: decodeEntities(anyT.text), font })
        else if ('raw' in anyT) runs.push({ text: anyT.raw, font })
      }
    }
  }
  return runs
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function markdownBlocks(tokens: Token[], indent = 0, quote = false): Block[] {
  const blocks: Block[] = []
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        blocks.push({ kind: 'heading', level: (t as Tokens.Heading).depth, runs: inlineRuns((t as Tokens.Heading).tokens, 'bold'), indent, quote })
        break
      case 'paragraph':
        blocks.push({ kind: 'paragraph', runs: inlineRuns((t as Tokens.Paragraph).tokens), indent, quote })
        break
      case 'text': {
        const tt = t as Tokens.Text
        blocks.push({ kind: 'paragraph', runs: tt.tokens ? inlineRuns(tt.tokens) : [{ text: decodeEntities(tt.text), font: 'regular' }], indent, quote })
        break
      }
      case 'code':
        blocks.push({ kind: 'code', runs: [{ text: (t as Tokens.Code).text, font: 'mono' }], indent, quote })
        break
      case 'hr':
        blocks.push({ kind: 'rule', indent })
        break
      case 'space':
        break
      case 'blockquote':
        blocks.push(...markdownBlocks((t as Tokens.Blockquote).tokens, indent, true))
        break
      case 'list': {
        const list = t as Tokens.List
        list.items.forEach((item, i) => {
          const start = typeof list.start === 'number' ? list.start : 1
          const bullet = item.task ? (item.checked ? '[x]' : '[ ]') : list.ordered ? `${start + i}.` : '•'
          const inner = markdownBlocks(item.tokens.filter((x) => x.type !== 'checkbox'), indent + 1, quote)
          if (inner.length && inner[0].kind === 'paragraph') inner[0].bullet = bullet
          else inner.unshift({ kind: 'paragraph', runs: [], indent: indent + 1, bullet, quote })
          blocks.push(...inner)
        })
        break
      }
      case 'table': {
        const table = t as Tokens.Table
        const row = (cells: Tokens.TableCell[], font: FontKey) =>
          cells.flatMap((c, i) => [...(i ? [{ text: '  |  ', font: 'regular' as FontKey }] : []), ...inlineRuns(c.tokens, font)])
        blocks.push({ kind: 'paragraph', runs: row(table.header, 'bold'), indent, quote })
        for (const r of table.rows) blocks.push({ kind: 'paragraph', runs: row(r, 'regular'), indent, quote })
        break
      }
      case 'html':
        blocks.push({ kind: 'paragraph', runs: [{ text: (t as Tokens.HTML).text.replace(/<[^>]+>/g, '').trim(), font: 'regular' }], indent, quote })
        break
      default: {
        const anyT = t as Token & { text?: string }
        if (anyT.text) blocks.push({ kind: 'paragraph', runs: [{ text: anyT.text, font: 'regular' }], indent, quote })
      }
    }
  }
  return blocks
}

export interface PdfTextOptions {
  pageSize?: string
  fontSize?: number
  margin?: number
  title?: string
}

class Layout {
  private page!: PDFPage
  private y = 0
  constructor(
    private doc: PDFDocument,
    private fonts: Record<FontKey, PDFFont>,
    private size: [number, number],
    private margin: number,
    private base: number,
  ) {
    this.newPage()
  }

  private newPage() {
    this.page = this.doc.addPage(this.size)
    this.y = this.size[1] - this.margin
  }

  private ensure(height: number) {
    if (this.y - height < this.margin) this.newPage()
  }

  gap(h: number) {
    this.y -= h
  }

  rule(indent: number) {
    this.ensure(12)
    this.y -= 6
    this.page.drawLine({
      start: { x: this.margin + indent, y: this.y },
      end: { x: this.size[0] - this.margin, y: this.y },
      thickness: 0.75,
      color: rgb(0.8, 0.8, 0.82),
    })
    this.y -= 6
  }

  /** Lays out runs with word wrapping. Returns nothing; advances the cursor. */
  text(runs: Run[], opts: { size: number; indent: number; bullet?: string; lineHeight?: number; quote?: boolean; background?: boolean; preserve?: boolean }) {
    const { size, indent } = opts
    const lh = size * (opts.lineHeight ?? 1.4)
    const left = this.margin + indent
    const width = this.size[0] - this.margin - left

    // Split runs into words (keeping trailing spaces) and explicit newlines.
    type Piece = { text: string; font: PDFFont; newline?: boolean }
    const pieces: Piece[] = []
    for (const run of runs) {
      const font = this.fonts[run.font]
      const parts = sanitize(run.text).split('\n')
      parts.forEach((part, i) => {
        if (i > 0) pieces.push({ text: '', font, newline: true })
        const words = opts.preserve ? [part] : part.match(/\S+\s*|\s+/g) ?? []
        for (const w of words) pieces.push({ text: w, font })
      })
    }

    const lines: Piece[][] = [[]]
    let lineW = 0
    for (const p of pieces) {
      if (p.newline) {
        lines.push([])
        lineW = 0
        continue
      }
      let w = p.font.widthOfTextAtSize(p.text, size)
      if (lineW + w > width && lines[lines.length - 1].length && p.text.trim()) {
        lines.push([])
        lineW = 0
      }
      // Hard-break words longer than a full line.
      let text = p.text
      while (w > width && text.length > 1) {
        let cut = text.length
        while (cut > 1 && p.font.widthOfTextAtSize(text.slice(0, cut), size) > width - lineW) cut--
        lines[lines.length - 1].push({ text: text.slice(0, cut), font: p.font })
        lines.push([])
        lineW = 0
        text = text.slice(cut)
        w = p.font.widthOfTextAtSize(text, size)
      }
      lines[lines.length - 1].push({ text, font: p.font })
      lineW += w
    }

    lines.forEach((line, i) => {
      this.ensure(lh)
      this.y -= lh
      const baseline = this.y + (lh - size) / 2 + size * 0.2
      if (opts.background) {
        this.page.drawRectangle({ x: left - 6, y: this.y, width: width + 12, height: lh, color: rgb(0.95, 0.95, 0.96) })
      }
      if (opts.quote) {
        this.page.drawRectangle({ x: left - 10, y: this.y, width: 2.5, height: lh, color: rgb(0.75, 0.75, 0.8) })
      }
      if (i === 0 && opts.bullet) {
        const bw = this.fonts.regular.widthOfTextAtSize(opts.bullet, size)
        this.page.drawText(opts.bullet, { x: left - bw - 6, y: baseline, size, font: this.fonts.regular, color: rgb(0.2, 0.2, 0.25) })
      }
      let x = left
      for (const p of line) {
        if (!p.text) continue
        this.page.drawText(p.text, { x, y: baseline, size, font: p.font, color: opts.quote ? rgb(0.35, 0.35, 0.4) : rgb(0.08, 0.08, 0.1) })
        x += p.font.widthOfTextAtSize(p.text, size)
      }
    })
  }

  render(blocks: Block[]) {
    const base = this.base
    for (const b of blocks) {
      const indent = (b.indent ?? 0) * 18 + (b.quote ? 14 : 0)
      switch (b.kind) {
        case 'heading': {
          const scale = [2, 1.6, 1.3, 1.15, 1.05, 1][Math.min(5, (b.level ?? 1) - 1)]
          this.gap(base * 0.6)
          this.text(b.runs ?? [], { size: base * scale, indent, lineHeight: 1.25, quote: b.quote })
          this.gap(base * 0.3)
          break
        }
        case 'paragraph':
          this.text(b.runs ?? [], { size: base, indent, bullet: b.bullet, quote: b.quote })
          this.gap(b.bullet ? base * 0.15 : base * 0.5)
          break
        case 'code':
          this.gap(base * 0.2)
          this.text(b.runs ?? [], { size: base * 0.85, indent: indent + 6, lineHeight: 1.35, background: true, preserve: true })
          this.gap(base * 0.7)
          break
        case 'rule':
          this.rule(indent)
          break
        case 'space':
          this.gap(base)
          break
      }
    }
  }
}

async function newDocument(opts: PdfTextOptions) {
  const doc = await PDFDocument.create()
  if (opts.title) doc.setTitle(opts.title)
  doc.setCreator('ConvertAnything')
  const fonts: Record<FontKey, PDFFont> = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  }
  const size = PAGE_SIZES[opts.pageSize ?? 'a4'] ?? PAGE_SIZES.a4
  const layout = new Layout(doc, fonts, size, opts.margin ?? 56, opts.fontSize ?? 11)
  return { doc, layout }
}

export async function markdownToPdf(markdown: string, opts: PdfTextOptions = {}): Promise<Uint8Array> {
  const { doc, layout } = await newDocument(opts)
  layout.render(markdownBlocks(marked.lexer(markdown)))
  return doc.save()
}

export async function plainTextToPdf(text: string, opts: PdfTextOptions = {}): Promise<Uint8Array> {
  const { doc, layout } = await newDocument(opts)
  const blocks: Block[] = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? { kind: 'paragraph' as const, runs: [{ text: line, font: 'regular' as FontKey }] } : { kind: 'space' as const }))
  // Plain text keeps line structure: no paragraph gaps between consecutive lines.
  for (const b of blocks) {
    if (b.kind === 'space') layout.gap((opts.fontSize ?? 11) * 0.8)
    else layout.text(b.runs!, { size: opts.fontSize ?? 11, indent: 0 })
  }
  return doc.save()
}
