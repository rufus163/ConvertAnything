import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// `./` keeps asset paths relative so the same build runs on the web,
// inside the iOS app (Capacitor) and inside the Windows app (Tauri).
// The GitHub Pages workflow overrides it with VITE_BASE=/<repo>/.
const base = process.env.VITE_BASE ?? './'

export default defineConfig({
  base,
  clearScreen: false,
  plugins: [
    react(),
    VitePWA({
      injectRegister: null,
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'ConvertAnything',
        short_name: 'Convert',
        description: 'Convert images, video, audio, documents and data. Files never leave your device.',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: '.',
            accept: {
              'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic', '.svg', '.tif', '.tiff'],
              'video/*': ['.mp4', '.mov', '.webm', '.mkv', '.avi'],
              'audio/*': ['.mp3', '.wav', '.m4a', '.flac', '.ogg'],
              'application/pdf': ['.pdf'],
            },
          },
        ],
      },
      workbox: {
        // The ffmpeg core (~32 MB) is cached on first use instead of precached.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,mjs}'],
        globIgnores: ['**/ffmpeg-core*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('ffmpeg-core'),
            handler: 'CacheFirst',
            options: { cacheName: 'ffmpeg-core', expiration: { maxEntries: 4 } },
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: ['es2020', 'safari15', 'chrome100', 'edge100', 'firefox100'],
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
