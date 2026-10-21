import { baseName, detectFormat, FORMATS } from '../formats'
import { columnsOf, parseData, serializeData, toRows } from '../data'
import { ConversionError, type ConvertContext, type Options, type OutputFile } from '../types'

async function readXlsx(file: File, allSheets: boolean): Promise<unknown> {
  const readXlsxFile = (await import('read-excel-file/browser')).default
  let sheets
  try {
    sheets = await readXlsxFile(file)
  } catch {
    throw new ConversionError("This spreadsheet couldn't be read. Only .xlsx (not legacy .xls) is supported.")
  }
  const toObjects = (data: unknown[][]) => {
    const [header = [], ...rows] = data
    const keys = header.map((h, i) => (h === null || h === undefined || h === '' ? `column${i + 1}` : String(h)))
    return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])))
  }
  if (allSheets && sheets.length > 1) return Object.fromEntries(sheets.map((s) => [s.sheet, toObjects(s.data as unknown[][])]))
  return toObjects((sheets[0]?.data ?? []) as unknown[][])
}

async function writeXlsx(value: unknown): Promise<Blob> {
  const writeXlsxFile = (await import('write-excel-file/browser')).default
  const rows = toRows(value)
  const columns = columnsOf(rows)
  const cell = (v: unknown) => {
    if (v === null || v === undefined || v === '') return null
    if (typeof v === 'number') return { value: v, type: Number }
    if (typeof v === 'boolean') return { value: v, type: Boolean }
    if (v instanceof Date) return { value: v, type: Date, format: 'yyyy-mm-dd' }
    return { value: String(v), type: String }
  }
  const data = [
    columns.map((c) => ({ value: c, type: String, fontWeight: 'bold' as const })),
    ...rows.map((r) => columns.map((c) => cell(r[c]))),
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return writeXlsxFile(data as any).toBlob()
}

export async function convertData(file: File, target: string, opts: Options, ctx: ConvertContext): Promise<OutputFile[]> {
  const from = detectFormat(file)?.id ?? ''
  ctx.onStatus('Converting…')
  ctx.onProgress(0.2)
  const value = from === 'xlsx' ? await readXlsx(file, target !== 'csv' && target !== 'tsv' && opts.allSheets !== false) : parseData(await file.text(), from)
  ctx.onProgress(0.6)
  const blob =
    target === 'xlsx'
      ? await writeXlsx(value)
      : new Blob([serializeData(value, target)], { type: `${FORMATS[target].mime};charset=utf-8` })
  ctx.onProgress(1)
  return [{ name: `${baseName(file.name)}.${FORMATS[target].extensions[0]}`, blob }]
}
