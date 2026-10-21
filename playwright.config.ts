import { defineConfig, devices } from '@playwright/test'

// Runs against the production build (`npm run build` first).
// Set CHROMIUM_PATH to use a preinstalled Chromium instead of Playwright's download.
// Set VITE_BASE (e.g. /ConvertAnything/) to test a build made for a sub-path, like GitHub Pages.
const basePath = process.env.VITE_BASE ?? '/'

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:4173${basePath}`,
    acceptDownloads: true,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: `http://localhost:4173${basePath}`,
    reuseExistingServer: !process.env.CI,
  },
})
