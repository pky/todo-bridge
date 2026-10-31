#!/usr/bin/env node
import { preview } from 'vite'
import { resolve } from 'node:path'
import { environment } from './environment.mjs'

const server = await preview({
  root: resolve(import.meta.dirname, '..'),
  mode: 'test',
  envDir: false,
  define: Object.fromEntries(Object.entries(environment).map(([name, value]) => [`import.meta.env.${name}`, JSON.stringify(value)])),
  build: { outDir: '.e2e/dist' },
  preview: {
    host: '127.0.0.1', port: Number(process.env.E2E_PREVIEW_PORT), strictPort: true,
    headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:*; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'" },
  },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.httpServer.close())
