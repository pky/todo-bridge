import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist', 'e2e'],
    // Node 25 以降の組み込み localStorage が happy-dom の実装を隠すため無効にする
    execArgv: ['--no-experimental-webstorage'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
