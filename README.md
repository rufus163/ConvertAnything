# ConvertAnything

Convert images, video, audio, documents and data files on any device: **iPhone, iPad, Windows, Mac and the web**.

Every conversion runs locally, in the browser or app. Files are never uploaded, nothing needs an account, and the app works offline once it has loaded.

## What it converts

| From | To |
| --- | --- |
| **Images**: PNG, JPG, WebP, HEIC (iPhone photos), AVIF, GIF, BMP, TIFF, ICO, SVG | JPG, PNG, WebP, **SVG (vector tracing)**, PDF, GIF, BMP, TIFF, ICO (favicons / Windows icons) |
| **Video**: MP4, MOV, WebM, MKV, AVI, WMV, FLV, 3GP, MPEG/TS | **MP4 that plays on iPhone/iPad**, smaller MP4 (compress), MOV, WebM, MKV, AVI, animated GIF, audio only (MP3, M4A, WAV, FLAC, OGG, Opus, AIFF) |
| **Animated GIF** | MP4 or WebM video (much smaller) |
| **Audio**: MP3, M4A/AAC, WAV, FLAC, OGG, Opus, AIFF, WMA, AMR | MP3, M4A, WAV, FLAC, OGG, Opus, AIFF, **M4R (iPhone ringtone)** |
| **PDF** | JPG or PNG pages, plain text, split into pages, merge several PDFs (and images) into one |
| **Documents**: Word (.docx), Markdown, HTML, plain text | PDF, HTML, Markdown, text |
| **Data**: CSV, TSV, Excel (.xlsx), JSON, YAML, XML, TOML | Any of the others |
| **Any files** | ZIP archive, and ZIP back to files |

That's 42 formats and about 390 input→output pairs. Most conversions have options: quality, size, resolution, page size, trimming, tracing detail, and so on.

### Smart "iPhone compatible" video

Videos that won't play on iOS are usually fine inside and just packaged wrong (for example HEVC tagged `hev1` instead of `hvc1`, or a `.mkv` container). ConvertAnything inspects the file first:

- **H.264 or HEVC video with AAC audio** is repackaged into an MP4 without re-encoding. That is near-instant and loses no quality.
- **Other audio** (Opus, AC-3…) is re-encoded to AAC; the video is still copied.
- **Other video** (VP9, AV1, MPEG-4, 4:4:4 H.264…), or a smaller resolution you asked for, is re-encoded to H.264 High profile with `yuv420p` and `+faststart`.

## Using it

1. Drop files anywhere on the window, paste them, or tap **choose files** (on iPhone this offers Photos, Camera and Files).
2. Pick a target format. The most useful targets are shown first; **More** lists everything.
3. Tap **Convert**, then **Save** or **Share** (AirDrop, Save to Photos, Messages…).

With several files you can convert them all to one format, combine images or PDFs into a single PDF, or bundle everything into a ZIP.

## Platforms

One codebase, a React web app, ships everywhere:

| Platform | How | Saving files |
| --- | --- | --- |
| Web (any modern browser) | Static site + installable PWA, works offline | Browser download, or the share sheet on phones |
| iPhone & iPad (iOS 15+) | [Capacitor](https://capacitorjs.com) app in `ios/` | Share sheet; copies are also kept in **Files › On My iPhone › ConvertAnything** |
| Windows 10/11 (and macOS) | [Tauri 2](https://tauri.app) app in `src-tauri/` (~10 MB installer) | Native "Save as…" dialog |

## Development

Requires Node 20+.

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (Vitest)
npm run build        # production build in dist/
npm run test:e2e     # browser tests against the build (Playwright)
```

### Web

`npm run build` outputs a static site in `dist/` that can be hosted anywhere. The included GitHub Actions workflow (`.github/workflows/pages.yml`) deploys it to GitHub Pages on every push to `main`. Enable it under *Settings › Pages › Source: GitHub Actions*. The ~32 MB media engine is downloaded only the first time someone converts audio or video, then cached for offline use.

### Windows (and macOS) desktop app

Requires [Rust](https://rustup.rs) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (on Windows: Microsoft C++ Build Tools; WebView2 ships with Windows 10/11).

```sh
npm run desktop:dev     # run with hot reload
npm run desktop:build   # installers in src-tauri/target/release/bundle/ (msi + nsis exe)
```

Pushing a tag such as `v1.0.0` runs `.github/workflows/desktop.yml`, which builds the Windows installers and a universal macOS `.dmg` and attaches them to a draft GitHub release.

### iPhone & iPad app

Requires a Mac with Xcode 16+.

```sh
npm run ios:sync   # build the web app and copy it into the Xcode project
npm run ios:open   # open in Xcode, choose your team under Signing & Capabilities, then Run
```

To publish on the App Store, archive from Xcode (*Product › Archive*) and upload with your Apple Developer account. `.github/workflows/ios.yml` checks that the project compiles for the simulator.

## How it works

```
src/
  converters/
    formats.ts        format catalog and detection (extension + MIME)
    registry.ts       every conversion, its options, and target ranking
    probe.ts          parses ffmpeg output and plans video/audio commands (pure, unit tested)
    data.ts           CSV/TSV/JSON/YAML/XML/TOML conversions (pure, unit tested)
    encoders.ts       BMP and ICO writers (pure, unit tested)
    engines/          lazily-loaded engines:
      image.ts        canvas decode/encode, HEIC, TIFF, GIF, ICO, BMP, SVG tracing (in a worker)
      media.ts        ffmpeg.wasm for all audio/video, streamed from disk via WORKERFS
      pdf.ts          pdf-lib (create/merge/split) and pdf.js (render/extract text)
      pdfWriter.ts    small rich-text layout engine for Markdown/Word/text → PDF
      document.ts     Word, Markdown, HTML, text
      data.ts         adds Excel (.xlsx) on top of converters/data.ts
      archive.ts      ZIP / unzip
  components/         UI (React)
  lib/                job queue, saving/sharing per platform, theme
```

Main libraries: [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), [pdf-lib](https://pdf-lib.js.org), [pdf.js](https://mozilla.github.io/pdf.js/), [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs), [heic2any](https://github.com/alexcorvi/heic2any), [UTIF.js](https://github.com/photopea/UTIF.js), [gifenc](https://github.com/mattdesl/gifenc), [mammoth](https://github.com/mwilliamson/mammoth.js), [marked](https://marked.js.org), [Turndown](https://github.com/mixmark-io/turndown), [Papa Parse](https://www.papaparse.com), [read-excel-file](https://gitlab.com/catamphetamine/read-excel-file) / [write-excel-file](https://gitlab.com/catamphetamine/write-excel-file), [js-yaml](https://github.com/nodeca/js-yaml), [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser), [smol-toml](https://github.com/squirrelchat/smol-toml), [fflate](https://github.com/101arrowz/fflate).

## Limits and notes

- **Large videos.** Video is encoded in WebAssembly on one CPU thread, so re-encoding is slower than a native app. Remuxing (the common iPhone case) is fast. Phones may run out of memory on multi-gigabyte files that need a full re-encode.
- **Very large photos** are scaled down to 16 megapixels, which is iOS Safari's canvas limit.
- **Text → PDF** uses the standard PDF fonts, which cover Latin-1 text. Other scripts (CJK, emoji…) are replaced with `?`.
- **Word → PDF** keeps headings, lists, emphasis, quotes and code, but not page layout or embedded images. Legacy `.doc` and `.xls` aren't supported; use `.docx` and `.xlsx`.
- **AVIF output** isn't offered because most browsers, Safari included, can't encode it yet. AVIF input works where the device can display it.
- **Licensing.** The bundled ffmpeg core includes GPL components (x264, x265), so distributing the app has GPL implications. Choose a license for this repository with that in mind.
