#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createConnection } from 'node:net'
import { build } from 'vite'
import { environment } from './environment.mjs'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('検証ポートが不正です')
const webRoot = resolve(import.meta.dirname, '..')
process.chdir(webRoot)

// 専用ポートの既存プロセスには接続せず、並行実行も拒否する。
for (const emulatorPort of [19099, 18080, 19199, 14400, 14500]) {
  const occupied = await new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port: emulatorPort })
    socket.once('connect', () => { socket.destroy(); accept(true) })
    socket.once('error', () => accept(false))
  })
  if (occupied) throw new Error(`専用Emulatorポート ${emulatorPort} が使用中です`)
}

const viteOptions = {
  mode: 'test',
  envDir: false,
  define: Object.fromEntries(Object.entries(environment).map(([name, value]) => [`import.meta.env.${name}`, JSON.stringify(value)])),
  build: { outDir: '.e2e/dist', emptyOutDir: true },
}
await mkdir('.e2e/emulators', { recursive: true })
// CLIのプロジェクト外ルール参照を避け、専用ディレクトリへ同じルールを用意する。
const emulatorRoot = resolve('.e2e/emulators')
const emulatorConfig = JSON.parse(await readFile(resolve('e2e.firebase.json'), 'utf8'))
for (const service of ['firestore', 'storage']) {
  const ruleName = `${service}.rules`
  await copyFile(resolve(webRoot, emulatorConfig[service].rules), resolve(emulatorRoot, ruleName))
  emulatorConfig[service].rules = ruleName
}
const runtimeConfig = resolve(emulatorRoot, 'firebase.runtime.json')
await writeFile(runtimeConfig, JSON.stringify(emulatorConfig))
await build(viteOptions)

const emulator = spawn(process.execPath, [
  resolve('node_modules/firebase-tools/lib/bin/firebase.js'), 'emulators:exec',
  '--config', runtimeConfig, '--project', 'demo-rertm', '--only', 'auth,firestore,storage',
  'node ../../verification/serve.mjs',
], {
  cwd: resolve('.e2e/emulators'),
  env: { PATH: process.env.PATH, HOME: process.env.HOME, JAVA_HOME: process.env.JAVA_HOME,
    TMPDIR: process.env.TMPDIR, CI: '1', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
    E2E_PREVIEW_PORT: String(port), ...environment },
  stdio: 'inherit',
})
// e2e が所有する子プロセスだけを停止する。証跡や他のサーバーには触れない。
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => emulator.kill('SIGINT'))
emulator.once('exit', (code) => { process.exitCode = code ?? 1 })
