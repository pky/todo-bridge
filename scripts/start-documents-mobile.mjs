import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'

function isPrivateIpv4(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(address)
}

function findMobileHost() {
  const override = process.env.MOBILE_HOST?.trim()
  if (override) return override

  const interfaces = networkInterfaces()
  const names = Object.keys(interfaces).sort((left, right) => {
    if (left === 'en0') return -1
    if (right === 'en0') return 1
    return left.localeCompare(right)
  })
  for (const name of names) {
    const address = interfaces[name]?.find((candidate) => (
      candidate.family === 'IPv4'
      && !candidate.internal
      && isPrivateIpv4(candidate.address)
    ))
    if (address) return address.address
  }
  throw new Error('同じWi-Fiから到達できるMacのIPv4アドレスを取得できませんでした')
}

const host = findMobileHost()
if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
  throw new Error('MOBILE_HOSTにはIPv4アドレスを指定してください')
}

console.log(`スマホ確認URL: http://${host}:5173`)
console.log('スマホとMacを同じWi-Fiへ接続してください')

const packageManagerPath = process.env.npm_execpath
const command = packageManagerPath ? process.execPath : 'pnpm'
const args = packageManagerPath
  ? [packageManagerPath, 'run', 'dev:documents:mobile:internal']
  : ['run', 'dev:documents:mobile:internal']
const child = spawn(command, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_EMULATOR_HOST: host,
    DOCUMENT_EMULATOR_HOST: host,
  },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exitCode = code ?? 1
})
