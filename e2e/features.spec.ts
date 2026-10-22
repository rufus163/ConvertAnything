import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'

const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name)

async function addFiles(page: Page, ...names: string[]) {
  await page.locator('input[type=file]').setInputFiles(names.map(fixture))
}

async function chooseTarget(page: Page, card: Locator, label: string) {
  const chip = card.getByRole('radio', { name: label, exact: true })
  if (await chip.count()) await chip.click()
  else {
    await card.getByRole('button', { name: /^More/ }).click()
    await page.getByRole('dialog', { name: 'All formats' }).getByRole('button', { name: new RegExp(`^${label}`) }).first().click()
  }
}

async function download(page: Page, button: Locator) {
  const [dl] = await Promise.all([page.waitForEvent('download'), button.click()])
  return { name: dl.suggestedFilename(), bytes: await readFile(await dl.path()) }
}

async function convert(page: Page, card: Locator) {
  await card.getByRole('button', { name: /^Convert to/ }).click()
  await expect(card).toHaveClass(/job--done/)
  return download(page, card.getByRole('button', { name: /^Save/ }).first())
}

async function pdfText(bytes: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) })
  const doc = await task.promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent()
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
  }
  await task.destroy()
  return pages
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error('pageerror:', e))
  await page.goto('./')
})

test.describe('quality presets', () => {
  test('lossless PNG → WebP is true lossless (VP8L)', async ({ page }) => {
    await addFiles(page, 'logo.png')
    const card = page.locator('.job').first()
    await chooseTarget(page, card, 'WebP')
    await card.getByRole('radiogroup', { name: 'Quality' }).getByRole('radio', { name: 'Lossless' }).click()
    await expect(card.getByText('True lossless WebP')).toBeVisible()
    const out = await convert(page, card)
    // Transparent images use the extended (VP8X) header; the image data must be the lossless VP8L chunk.
    expect(out.bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(out.bytes.includes(Buffer.from('VP8L'))).toBe(true)
    expect(out.bytes.includes(Buffer.from('VP8 '))).toBe(false)
  })

  test('lossless WAV → M4A uses Apple Lossless', async ({ page }) => {
    await addFiles(page, 'tone.wav')
    const card = page.locator('.job').first()
    await chooseTarget(page, card, 'M4A')
    await card.getByRole('radio', { name: 'Lossless' }).click()
    const out = await convert(page, card)
    expect(out.bytes.includes(Buffer.from('alac'))).toBe(true)
  })

  test('lossless MP4 → MKV copies the H.264 stream', async ({ page }) => {
    await addFiles(page, 'clip.mp4')
    const card = page.locator('.job').first()
    await chooseTarget(page, card, 'MKV')
    await card.getByRole('radio', { name: 'Lossless' }).click()
    const out = await convert(page, card)
    expect(out.bytes.includes(Buffer.from('V_MPEG4/ISO/AVC'))).toBe(true)
  })

  test('JPG → PDF keeps the original JPEG bytes and applies EXIF rotation', async ({ page }) => {
    await addFiles(page, 'portrait.jpg')
    const card = page.locator('.job').first()
    await chooseTarget(page, card, 'PDF')
    const out = await convert(page, card)
    const original = await readFile(fixture('portrait.jpg'))
    expect(out.bytes.includes(original)).toBe(true)
    const doc = await PDFDocument.load(out.bytes)
    const { width, height } = doc.getPage(0).getSize()
    // The 320×240 sensor image is portrait once rotated.
    expect([Math.round(width), Math.round(height)]).toEqual([240, 320])
  })
})

test('progress shows percentage, time left and speed', async ({ page }) => {
  await addFiles(page, 'long.webm')
  const card = page.locator('.job').first()
  await card.getByRole('radio', { name: 'Lossless' }).click()
  await card.getByRole('button', { name: /^Convert to/ }).click()
  const stats = card.locator('.stats')
  await expect(stats).toContainText('%')
  await expect(stats).toContainText(/left|elapsed/)
  await expect(stats).toContainText(/fps|×|\/s/)
  await expect(card).toHaveClass(/job--done/)
  await expect(card.getByText(/^Done in/)).toBeVisible()
})

test('settings persist and set the default quality', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('combobox', { name: 'Simultaneous conversions' }).selectOption('2')
  await dialog.getByRole('radio', { name: 'Lossless' }).click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('combobox', { name: 'Simultaneous conversions' })).toHaveValue('2')
  await page.keyboard.press('Escape')

  await addFiles(page, 'logo.png')
  await expect(page.locator('.job').first().getByRole('radio', { name: 'Lossless' })).toHaveAttribute('aria-checked', 'true')
})

test.describe('PDF editor', () => {
  test('edits text in the PDF’s own embedded font and color', async ({ page }) => {
    await addFiles(page, 'embedded-font.pdf')
    const card = page.locator('.job').first()
    await card.getByRole('button', { name: 'Edit PDF' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit embedded-font.pdf' })
    await editor.getByRole('button', { name: 'Edit text: Hello World' }).click()

    // Detected style: the original font, its size and its red color.
    await expect(editor.getByRole('combobox')).toHaveValue(/.+/)
    await expect(editor.getByRole('combobox').locator('option:checked')).toContainText('(original)')
    await expect(editor.getByText(/Embedded font · 24 pt/)).toBeVisible()
    const hex = await editor.locator('input[type=color]').inputValue()
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(150)
    expect(g).toBeLessThan(80)
    expect(b).toBeLessThan(80)

    await editor.getByRole('textbox', { name: 'Text' }).fill('World Hello')
    await editor.getByRole('button', { name: 'Save PDF' }).click()
    await expect(editor).toBeHidden()
    await expect(card).toHaveClass(/job--done/)
    await expect(card).toContainText('1 in the original font')
    const out = await download(page, card.getByRole('button', { name: /^Save/ }).first())
    expect(out.name).toBe('embedded-font-edited.pdf')
    const [text] = await pdfText(out.bytes)
    expect(text).toContain('World Hello')
    expect(text).toContain('Invoice total')
    // The original words are gone from the file, not just hidden.
    expect(text).not.toContain('Hello World')
    expect(text.match(/Hello/g)).toHaveLength(1)
  })

  test('falls back to a standard font, adds text, rotates and deletes pages', async ({ page }) => {
    await addFiles(page, 'two-pages.pdf')
    const card = page.locator('.job').first()
    await card.getByRole('button', { name: 'Edit PDF' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit two-pages.pdf' })

    await editor.getByRole('button', { name: 'Edit text: Hello from page 1' }).click()
    await editor.getByRole('textbox', { name: 'Text' }).fill('Changed text')
    await editor.getByRole('button', { name: 'Done' }).click()

    await editor.getByRole('radio', { name: /Add text/ }).click()
    const layer = editor.locator('.pdf-page__layer').first()
    await layer.click({ position: { x: 30, y: 30 } })
    await page.keyboard.type('Signed')
    await page.keyboard.press('Enter')

    await editor.getByRole('button', { name: 'Rotate page 1' }).click()
    await editor.getByRole('button', { name: 'Delete page 2' }).click()
    await editor.getByRole('button', { name: 'Save PDF' }).click()
    await expect(card).toHaveClass(/job--done/)

    const out = await download(page, card.getByRole('button', { name: /^Save/ }).first())
    const doc = await PDFDocument.load(out.bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getRotation().angle).toBe(90)
    const [text] = await pdfText(out.bytes)
    expect(text).toContain('Changed text')
    expect(text).toContain('Signed')
    expect(text).not.toContain('Hello from page 1')
    await expect(card).not.toContainText('covered')
  })

  test('covers text it can’t remove (inside an embedded graphic)', async ({ page }) => {
    await addFiles(page, 'xobject-text.pdf')
    const card = page.locator('.job').first()
    await card.getByRole('button', { name: 'Edit PDF' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit xobject-text.pdf' })
    await editor.getByRole('button', { name: 'Edit text: Inside a graphic' }).click()
    await editor.getByRole('textbox', { name: 'Text' }).fill('Replaced')
    await editor.getByRole('button', { name: 'Save PDF' }).click()
    await expect(card).toHaveClass(/job--done/)
    await expect(card).toContainText('1 covered instead of removed')
    const out = await download(page, card.getByRole('button', { name: /^Save/ }).first())
    expect((await pdfText(out.bytes))[0]).toContain('Replaced')
  })

  test('“Edit a PDF” shortcut opens the editor directly', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit a PDF' }).click()
    await addFiles(page, 'two-pages.pdf')
    await expect(page.getByRole('dialog', { name: 'Edit two-pages.pdf' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit text: Hello from page 2' })).toBeVisible()
  })
})
