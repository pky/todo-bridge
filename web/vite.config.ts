import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return

          if (
            id.includes('/node_modules/firebase/firestore/') ||
            id.includes('/node_modules/@firebase/firestore/')
          ) {
            return 'firebase-firestore'
          }

          if (
            id.includes('/node_modules/firebase/auth/') ||
            id.includes('/node_modules/@firebase/auth/')
          ) {
            return 'firebase-auth'
          }

          if (
            id.includes('/node_modules/firebase/functions/') ||
            id.includes('/node_modules/@firebase/functions/')
          ) {
            return 'firebase-functions'
          }

          if (
            id.includes('/node_modules/firebase/') ||
            id.includes('/node_modules/@firebase/')
          ) {
            return 'firebase-core'
          }

          if (
            id.includes('/node_modules/vue/') ||
            id.includes('/node_modules/@vue/') ||
            id.includes('/node_modules/vue-router/') ||
            id.includes('/node_modules/pinia/')
          ) {
            return 'vue-vendor'
          }

          return 'vendor'
        }
      }
    }
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'prompt', // ユーザーに更新を促す
      includeAssets: ['favicon.ico', 'logo.svg', 'icons/*.png'],
      manifest: {
        name: 'TodoBridge - タスク管理',
        short_name: 'TodoBridge',
        description: 'シンプルで使いやすいタスク管理アプリ',
        theme_color: '#3b82f6',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: '/icons/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // キャッシュするファイルパターン
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        // ナビゲーションのフォールバック
        navigateFallback: '/index.html',
        // Firebase Auth の redirect ハンドラは SPA フォールバックの対象外にする
        navigateFallbackDenylist: [/^\/__/],
        // ランタイムキャッシュ（Firebase等の外部リソース）
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1年
              }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1年
              }
            }
          }
        ]
      },
      devOptions: {
        enabled: false // 開発時はSWを無効化
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
