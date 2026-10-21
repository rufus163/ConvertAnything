import { baseName, detectFormat, FORMATS } from '../formats'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'
import { markdownToPdf, plainTextToPdf } from './pdfWriter'

const HTML_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8ed; background: #111114; } a { color: #6ea8ff; } pre, code { background: #1d1d22 !important; } }
  h1, h2, h3 { line-height: 1.25; }
  pre { background: #f4f4f6; padding: 14px 16px; border-radius: 10px; overflow-x: auto; }
  code { background: #f4f4f6; padding: 2px 5px; border-radius: 5px; font-size: 0.92em; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0; padding-left: 16px; border-left: 3px solid #c7c7cc; color: #6e6e73; }
  table { border-collapse: collapse; } td, th { border: 1px solid #d2d2d7; padding: 6px 10px; }
  img { max-width: 100%; }
`

function htmlDocument(title: string, body: string): string {
  const safeTitle = title.replace(/[<>&"]/g, '')
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${safeTitle}</title>\n<style>${HTML_STYLE}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textBlob(text: string, format: string): Blob {
  return new Blob([text], { type: `${FORMATS[format].mime};charset=utf-8` })
}

/** Strips scripts and event handlers before handing HTML to other converters. */
function parseHtml(html: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, noscript, iframe, object, embed').forEach((el) => el.remove())
  return doc
}

function htmlToText(html: string): string {
  const doc = parseHtml(html)
  // Give block elements line breaks so the text keeps its structure.
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'))
  doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote, section, article').forEach((el) => el.append('\n'))
  doc.querySelectorAll('li').forEach((el) => el.prepend('• '))
  return (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

async function htmlToMarkdown(html: string): Promise<string> {
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  return td.turndown(parseHtml(html).body)
}

async function markdownToHtml(md: string): Promise<string> {
  const { marked } = await import('marked')
  return marked.parse(md, { async: false, gfm: true }) as string
}

async function markdownToText(md: string): Promise<string> {
  return htmlToText(await markdownToHtml(md))
}

async function docxTo(file: File, kind: 'html' | 'text'): Promise<string> {
  const mammoth = (await import('mammoth')).default
  const arrayBuffer = await file.arrayBuffer()
  try {
    if (kind === 'text') return (await mammoth.extractRawText({ arrayBuffer })).value
    return (await mammoth.convertToHtml({ arrayBuffer })).value
  } catch {
    throw new ConversionError("This Word document couldn't be read. Only .docx (not legacy .doc) is supported.")
  }
}

export async function convertDocument(file: File, target: string, opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  const from = detectFormat(file)?.id
  const name = baseName(file.name)
  ctx.onStatus('Converting…')
  ctx.onProgress(0.2)
  const pdfOpts = { pageSize: String(opts.pageSize ?? 'a4'), fontSize: Number(opts.fontSize ?? 11), title: name }

  // Normalise every input into either Markdown or HTML first, then render the target.
  let html: string | undefined
  let md: string | undefined
  let text: string | undefined
  switch (from) {
    case 'md':
      md = await file.text()
      break
    case 'html':
      html = await file.text()
      break
    case 'txt':
      text = await file.text()
      break
    case 'docx':
      if (target === 'txt') text = await docxTo(file, 'text')
      else html = await docxTo(file, 'html')
      break
    default:
      throw new ConversionError(`Can't convert ${from} documents.`)
  }

  let out: Blob
  switch (target) {
    case 'html':
      if (md !== undefined) html = await markdownToHtml(md)
      if (text !== undefined) html = `<pre style="white-space: pre-wrap">${escapeHtml(text)}</pre>`
      out = textBlob(from === 'html' ? html! : htmlDocument(name, html!), 'html')
      break
    case 'md':
      if (html !== undefined) md = await htmlToMarkdown(html)
      if (text !== undefined) md = text
      out = textBlob(md!, 'md')
      break
    case 'txt':
      if (md !== undefined) text = await markdownToText(md)
      if (html !== undefined) text = htmlToText(html)
      out = textBlob(text!, 'txt')
      break
    case 'pdf': {
      if (html !== undefined) md = await htmlToMarkdown(html)
      const bytes = md !== undefined ? await markdownToPdf(md, pdfOpts) : await plainTextToPdf(text!, pdfOpts)
      out = new Blob([bytes as BlobPart], { type: 'application/pdf' })
      break
    }
    default:
      throw new ConversionError(`Can't convert documents to ${target}.`)
  }
  ctx.onProgress(1)
  return [{ name: `${name}.${FORMATS[target].extensions[0]}`, blob: out }]
}
