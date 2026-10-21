import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.convertanything.app',
  appName: 'ConvertAnything',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    backgroundColor: '#0b0b0f',
    // Large videos are converted in WebAssembly; let the web view use the memory it needs.
    limitsNavigationsToAppBoundDomains: false,
  },
}

export default config
