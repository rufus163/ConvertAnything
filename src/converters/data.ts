// Structured-data conversions (CSV, TSV, JSON, YAML, XML, TOML). DOM-free so they run in tests.
import Papa from 'papaparse'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml'
import { ConversionError } from './types'

export type Row = Record<string, unknown>

export const TEXT_DATA_FORMATS = ['csv', 'tsv', 'json', 'yaml', 'xml', 'toml'] as const

export function parseData(text: string, format: string): unknown {
  // Strip a UTF-8 BOM (common in files exported from Excel).
  text = text.replace(/^﻿/, '')
  try {
    switch (format) {
      case 'csv':
      case 'tsv': {
        const res = Papa.parse<Row>(text, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: 'greedy',
          delimiter: format === 'tsv' ? '\t' : '',
        })
        if (res.errors.length && !res.data.length) throw new Error(res.errors[0].message)
        return res.data
      }
      case 'json':
        return JSON.parse(text)
      case 'yaml':
        return yamlLoad(text)
      case 'xml':
        return new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true, attributeNamePrefix: '@', parseTagValue: true, trimValues: true }).parse(text, true)
      case 'toml':
        return tomlParse(text)
    }
  } catch (e) {
    throw new ConversionError(`This ${format.toUpperCase()} file is not valid: ${e instanceof Error ? e.message : e}`)
  }
  throw new ConversionError(`Can't read ${format} data.`)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

/** Flattens nested objects into dotted keys; arrays become JSON text. */
export function flattenRow(obj: Record<string, unknown>, prefix = '', out: Row = {}): Row {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v)) flattenRow(v, key, out)
    else if (Array.isArray(v)) out[key] = v.every((x) => !isPlainObject(x) && !Array.isArray(x)) ? v.join(', ') : JSON.stringify(v)
    else out[key] = v
  }
  return out
}

/** Finds the most table-like part of any data value: the first array of records within a few levels. */
function findRecords(value: unknown, depth = 0): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (!isPlainObject(value) || depth > 4) return undefined
  for (const v of Object.values(value)) {
    const found = findRecords(v, depth + 1)
    if (found && found.length) return found
  }
  return undefined
}

export function toRows(value: unknown): Row[] {
  const records = findRecords(value) ?? (value === undefined || value === null ? [] : [value])
  return records.map((r) => (isPlainObject(r) ? flattenRow(r) : { value: r }))
}

export function columnsOf(rows: Row[]): string[] {
  const cols = new Set<string>()
  rows.forEach((r) => Object.keys(r).forEach((k) => cols.add(k)))
  return [...cols]
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map(stripNulls)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, stripNulls(v)]))
  }
  return value
}

export function serializeData(value: unknown, format: string): string {
  switch (format) {
    case 'csv':
    case 'tsv': {
      const rows = toRows(value)
      return Papa.unparse(rows, { columns: columnsOf(rows), delimiter: format === 'tsv' ? '\t' : ',', newline: '\n' }) + '\n'
    }
    case 'json':
      return JSON.stringify(value, null, 2) + '\n'
    case 'yaml':
      return yamlDump(value, { lineWidth: 120, noRefs: true })
    case 'xml': {
      let root: unknown = value
      if (Array.isArray(value)) root = { root: { item: value } }
      else if (!isPlainObject(value) || Object.keys(value).length !== 1) root = { root: value }
      const body = new XMLBuilder({ format: true, ignoreAttributes: false, attributeNamePrefix: '@', suppressEmptyNode: true }).build(root)
      return body.startsWith('<?xml') ? body : `<?xml version="1.0" encoding="UTF-8"?>\n${body}`
    }
    case 'toml': {
      const clean = stripNulls(value)
      const table = isPlainObject(clean) ? clean : { items: clean }
      try {
        return tomlStringify(table) + '\n'
      } catch (e) {
        throw new ConversionError(`This data can't be represented as TOML: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  throw new ConversionError(`Can't write ${format} data.`)
}

export function convertDataText(text: string, from: string, to: string): string {
  return serializeData(parseData(text, from), to)
}
