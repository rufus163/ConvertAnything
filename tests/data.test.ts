import { describe, expect, it } from 'vitest'
import { convertDataText, flattenRow, parseData, toRows } from '../src/converters/data'

const CSV = 'name,age,city\nAda,36,London\n"Grace, Rear Adm.",85,"New York"\n'

describe('data conversions', () => {
  it('CSV → JSON keeps quoting and types', () => {
    expect(JSON.parse(convertDataText(CSV, 'csv', 'json'))).toEqual([
      { name: 'Ada', age: 36, city: 'London' },
      { name: 'Grace, Rear Adm.', age: 85, city: 'New York' },
    ])
  })

  it('round-trips through YAML, TOML, XML and TSV', () => {
    for (const fmt of ['yaml', 'tsv']) {
      const back = parseData(convertDataText(CSV, 'csv', fmt), fmt)
      expect(toRows(back)).toEqual(parseData(CSV, 'csv'))
    }
    const toml = convertDataText(CSV, 'csv', 'toml')
    expect(toml).toContain('[[items]]')
    const xml = convertDataText(CSV, 'csv', 'xml')
    expect(xml).toMatch(/^<\?xml/)
    expect(toRows(parseData(xml, 'xml'))).toEqual(parseData(CSV, 'csv'))
  })

  it('JSON → CSV flattens nested objects', () => {
    const json = JSON.stringify({ users: [{ id: 1, profile: { name: 'Ada', tags: ['a', 'b'] } }] })
    expect(convertDataText(json, 'json', 'csv')).toBe('id,profile.name,profile.tags\n1,Ada,"a, b"\n')
  })

  it('strips a BOM and reports invalid input', () => {
    expect(parseData('﻿{"a":1}', 'json')).toEqual({ a: 1 })
    expect(() => parseData('{nope', 'json')).toThrow(/not valid/)
  })

  it('flattenRow', () => {
    expect(flattenRow({ a: { b: { c: 1 } }, d: [{ x: 1 }] })).toEqual({ 'a.b.c': 1, d: '[{"x":1}]' })
  })
})
