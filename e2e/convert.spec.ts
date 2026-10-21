import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import path from 'node:path'

const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name)

async function addFiles(page: Page, ...names: string[]) {
  await page.locator('input[type=file]').setInputFiles(names.map(fixture))
}

async function chooseTarget(page: Page, card: ReturnType<Page['locator']>, label: string) {
  const chip = card.getByRole('radio', { name: label, exact: true })
  if (await chip.count()) {
    await chip.click()
  } else {
    await card.getByRole('button', { name: /^More/ }).click()
    await page.getByRole('dialog', { name: 'All formats' }).getByRole('button', { name: new RegExp(`^${label}`) }).first().click()
  }
}

async function convertAndSave(page: Page, card: ReturnType<Page['locator']>) {
  await card.getByRole('button', { name: /^Convert to/ }).click()
  await expect(card).toHaveClass(/job--done/)
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: /^Save/ }).first().click()])
  const file = await download.path()
  return { name: download.suggestedFilename(), bytes: await readFile(file) }
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('pageerror:', e))
  await page.goto('/')
})

test('home page renders @mobile', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Convert')
  await expect(page.getByRole('button', { name: 'HEIC → JPG', exact: true })).toBeVisible()
  await expect(page.getByText('Everything it converts')).toBeVisible()
})

test('PNG → JPG', async ({ page }) => {
  await addFiles(page, 'logo.png')
  const card = page.locator('.job').first()
  await chooseTarget(page, card, 'JPG')
  const out = await convertAndSave(page, card)
  expect(out.name).toBe('logo.jpg')
  expect(out.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
})

test('PNG → SVG (traced vectors)', async ({ page }) => {
  await addFiles(page, 'logo.png')
  const card = page.locator('.job').first()
  await chooseTarget(page, card, 'SVG')
  const out = await convertAndSave(page, card)
  expect(out.name).toBe('logo.svg')
  const svg = out.bytes.toString()
  expect(svg).toContain('<svg')
  expect(svg).toContain('<path')
})

test('PNG → ICO, BMP, TIFF, GIF, WebP', async ({ page }) => {
  const magic: Record<string, number[]> = { ICO: [0, 0, 1, 0], BMP: [0x42, 0x4d], TIFF: [0x4d, 0x4d, 0x00, 0x2a], GIF: [0x47, 0x49, 0x46], WebP: [0x52, 0x49, 0x46, 0x46] }
  for (const [label, bytes] of Object.entries(magic)) {
    await addFiles(page, 'logo.png')
    const card = page.locator('.job').last()
    await chooseTarget(page, card, label)
    const out = await convertAndSave(page, card)
    expect([...out.bytes.subarray(0, bytes.length)], label).toEqual(bytes)
  }
})

test('images → one combined PDF', async ({ page }) => {
  await addFiles(page, 'logo.png', 'photo.jpg')
  await page.getByRole('button', { name: 'Combine into one PDF' }).click()
  const card = page.locator('.job').first()
  await expect(card).toHaveClass(/job--done/)
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: /^Save/ }).first().click()])
  const bytes = await readFile(await download.path())
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2)
})

test('PDF → JPG pages and text', async ({ page }) => {
  await addFiles(page, 'two-pages.pdf')
  const card = page.locator('.job').first()
  await card.getByRole('button', { name: /^Convert to/ }).click()
  await expect(card).toHaveClass(/job--done/)
  await expect(card.locator('.output')).toHaveCount(2)

  await addFiles(page, 'two-pages.pdf')
  const card2 = page.locator('.job').last()
  await chooseTarget(page, card2, 'Text')
  const out = await convertAndSave(page, card2)
  expect(out.bytes.toString()).toContain('Hello from page 2')
})

test('MP4 → iPhone MP4 is repackaged without re-encoding', async ({ page }) => {
  await addFiles(page, 'clip.mp4')
  const card = page.locator('.job').first()
  await expect(card.getByRole('radio', { name: 'MP4 · iPhone & iPad' })).toHaveAttribute('aria-checked', 'true')
  await card.getByRole('button', { name: /^Convert to/ }).click()
  await expect(card).toHaveClass(/job--done/)
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: /^Save/ }).first().click()])
  const bytes = await readFile(await download.path())
  expect(bytes.subarray(4, 8).toString()).toBe('ftyp')
  expect(bytes.includes(Buffer.from('avc1'))).toBe(true)
})

test('WebM (VP9) → iPhone MP4 re-encodes to H.264', async ({ page }) => {
  await addFiles(page, 'clip.webm')
  const card = page.locator('.job').first()
  const out = await convertAndSave(page, card)
  expect(out.name).toBe('clip.mp4')
  expect(out.bytes.includes(Buffer.from('avc1'))).toBe(true)
  expect(out.bytes.includes(Buffer.from('mp4a'))).toBe(true)
})

test('video → GIF and audio extraction', async ({ page }) => {
  await addFiles(page, 'clip.mp4')
  const card = page.locator('.job').first()
  await chooseTarget(page, card, 'GIF')
  const gif = await convertAndSave(page, card)
  expect(gif.bytes.subarray(0, 3).toString()).toBe('GIF')

  await addFiles(page, 'tone.wav')
  const card2 = page.locator('.job').last()
  await chooseTarget(page, card2, 'MP3')
  const mp3 = await convertAndSave(page, card2)
  expect(mp3.name).toBe('tone.mp3')
  expect(mp3.bytes.length).toBeGreaterThan(1000)
})

test('CSV → JSON and XLSX', async ({ page }) => {
  await addFiles(page, 'people.csv')
  const card = page.locator('.job').first()
  await chooseTarget(page, card, 'JSON')
  const json = await convertAndSave(page, card)
  expect(JSON.parse(json.bytes.toString())[2]).toEqual({ name: 'Grace, Rear Adm.', age: 85, city: 'New York' })

  await addFiles(page, 'people.csv')
  const card2 = page.locator('.job').last()
  await chooseTarget(page, card2, 'XLSX')
  const xlsx = await convertAndSave(page, card2)
  expect(xlsx.bytes.subarray(0, 2).toString()).toBe('PK')
})

test('Markdown → PDF @mobile', async ({ page }) => {
  await addFiles(page, 'notes.md')
  const card = page.locator('.job').first()
  const out = await convertAndSave(page, card)
  expect(out.name).toBe('notes.pdf')
  expect(out.bytes.subarray(0, 5).toString()).toBe('%PDF-')
})
