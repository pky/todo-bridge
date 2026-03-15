import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

export default defineConfig({
  headLinkOptions: {
    preset: '2023'
  },
  preset: {
    ...minimal2023Preset,
    // Apple用のスプラッシュ画面を追加
    appleSplashScreens: {
      padding: 0.3,
      resizeOptions: { background: '#ffffff' },
      linkMediaOptions: {
        log: true,
        addMediaScreen: true,
        xhtml: false
      },
      // 主要なiOSデバイスサイズ
      sizes: [
        // iPhone SE, 8, 7, 6s, 6
        { width: 750, height: 1334, scaleFactor: 2, orientation: 'portrait' },
        // iPhone 8 Plus, 7 Plus, 6s Plus, 6 Plus
        { width: 1242, height: 2208, scaleFactor: 3, orientation: 'portrait' },
        // iPhone X, XS, 11 Pro, 12 mini, 13 mini
        { width: 1125, height: 2436, scaleFactor: 3, orientation: 'portrait' },
        // iPhone XR, 11
        { width: 828, height: 1792, scaleFactor: 2, orientation: 'portrait' },
        // iPhone XS Max, 11 Pro Max
        { width: 1242, height: 2688, scaleFactor: 3, orientation: 'portrait' },
        // iPhone 12, 12 Pro, 13, 13 Pro, 14
        { width: 1170, height: 2532, scaleFactor: 3, orientation: 'portrait' },
        // iPhone 12 Pro Max, 13 Pro Max, 14 Plus
        { width: 1284, height: 2778, scaleFactor: 3, orientation: 'portrait' },
        // iPhone 14 Pro
        { width: 1179, height: 2556, scaleFactor: 3, orientation: 'portrait' },
        // iPhone 14 Pro Max, 15 Plus, 15 Pro Max
        { width: 1290, height: 2796, scaleFactor: 3, orientation: 'portrait' },
        // iPad Mini, Air
        { width: 1536, height: 2048, scaleFactor: 2, orientation: 'portrait' },
        // iPad Pro 10.5"
        { width: 1668, height: 2224, scaleFactor: 2, orientation: 'portrait' },
        // iPad Pro 11"
        { width: 1668, height: 2388, scaleFactor: 2, orientation: 'portrait' },
        // iPad Pro 12.9"
        { width: 2048, height: 2732, scaleFactor: 2, orientation: 'portrait' },
      ]
    }
  },
  images: ['public/icons/icon.svg']
})
